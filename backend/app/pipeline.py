from __future__ import annotations

import asyncio
import tempfile
import time
from pathlib import Path

from fastapi import UploadFile

from .audio import ChunkManifest, prepare_chunks, probe_duration_seconds, stream_upload_to_disk
from .config import Settings
from .deepgram_service import DeepgramTranscriptionService
from .events import progress_event, sse_event
from .gemini_service import GeminiArtifactService
from .merge_engine import merge_chunk_results
from .models import ChunkTranscript, PipelineStage


class PipelineRunner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.transcriber = DeepgramTranscriptionService(settings)
        self.gemini = GeminiArtifactService(settings)

    def _worker_count_for_size(self, file_size_bytes: int) -> int:
        if file_size_bytes <= self.settings.small_file_limit_bytes:
            return self.settings.small_worker_count
        if file_size_bytes <= self.settings.medium_file_limit_bytes:
            return self.settings.medium_worker_count
        return self.settings.large_worker_count

    async def run(self, upload_file: UploadFile, file_size_bytes: int):
        with tempfile.TemporaryDirectory(prefix="viveka_", dir=self.settings.temp_root) as workspace_dir:
            workspace = Path(workspace_dir)
            source_path = workspace / (upload_file.filename or "session_audio")
            workspace.mkdir(parents=True, exist_ok=True)
            (workspace / "chunks").mkdir(parents=True, exist_ok=True)

            async def upload_progress(percent: int) -> None:
                yield_buffer.append(
                    progress_event(
                        PipelineStage.uploading,
                        f"Uploading {percent}%",
                        progress=max(1, min(20, percent // 5 or 1)),
                    )
                )

            yield_buffer: list[str] = [progress_event(PipelineStage.uploading, "Starting streaming upload...", progress=1)]

            written = await stream_upload_to_disk(
                upload_file,
                source_path,
                self.settings.upload_chunk_size_bytes,
                file_size_bytes,
                on_progress=upload_progress,
            )

            for pending_event in yield_buffer:
                yield pending_event

            if written == 0:
                yield progress_event(PipelineStage.error, "Uploaded file was empty.")
                return

            async for event in self.run_saved_source(source_path, file_size_bytes, workspace):
                yield event

    async def run_saved_source(self, source_path: Path, file_size_bytes: int, workspace: Path):
        chunks_dir = workspace / "chunks"
        chunks_dir.mkdir(parents=True, exist_ok=True)
        yield progress_event(PipelineStage.splitting, "Probing and preparing audio...", progress=25)
        duration_seconds = await asyncio.to_thread(probe_duration_seconds, source_path)
        if duration_seconds <= self.settings.direct_transcribe_max_seconds:
            chunk_manifests = [
                ChunkManifest(
                    chunk_id=1,
                    start_time=0.0,
                    end_time=duration_seconds,
                    path=source_path,
                )
            ]
            yield progress_event(
                PipelineStage.splitting,
                f"Using direct Deepgram path for {duration_seconds / 60:.1f} minutes of audio.",
                progress=35,
                total_chunks=1,
            )
        else:
            chunk_manifests = await prepare_chunks(source_path, workspace, self.settings)
        total_chunks = len(chunk_manifests)
        if total_chunks == 0:
            yield progress_event(PipelineStage.error, "Audio preprocessing did not produce any chunks.", progress=35)
            return
        if duration_seconds > self.settings.direct_transcribe_max_seconds:
            yield progress_event(
                PipelineStage.splitting,
                f"Created {total_chunks} chunk(s) from {duration_seconds / 60:.1f} minutes of audio.",
                progress=35,
                total_chunks=total_chunks,
            )

        worker_limit = self._worker_count_for_size(file_size_bytes)
        semaphore = asyncio.Semaphore(worker_limit)
        processed_chunks: list[ChunkTranscript | None] = [None] * total_chunks
        completed = 0
        last_progress_heartbeat = time.monotonic()

        async def process_chunk(manifest: ChunkManifest) -> None:
            nonlocal completed
            async with semaphore:
                yield_queue.put_nowait(
                    progress_event(
                        PipelineStage.chunk_upload,
                        f"Queueing chunk {manifest.chunk_id} of {total_chunks}",
                        progress=35,
                        chunk_index=manifest.chunk_id,
                        total_chunks=total_chunks,
                    )
                )
                yield_queue.put_nowait(
                    progress_event(
                        PipelineStage.transcribing,
                        f"Transcribing chunk {manifest.chunk_id} of {total_chunks}",
                        progress=35,
                        chunk_index=manifest.chunk_id,
                        total_chunks=total_chunks,
                    )
                )
                chunk_result = await self.transcriber.transcribe_chunk(
                    manifest.chunk_id,
                    manifest.path,
                    manifest.start_time,
                    manifest.end_time,
                )
                processed_chunks[manifest.chunk_id - 1] = chunk_result
                completed += 1
                progress = 35 + int((completed / total_chunks) * 35)
                yield_queue.put_nowait(
                    progress_event(
                        PipelineStage.chunk_complete,
                        f"Completed chunk {completed} of {total_chunks}",
                        progress=progress,
                        chunk_index=manifest.chunk_id,
                        total_chunks=total_chunks,
                    )
                )

        yield_queue: asyncio.Queue[str] = asyncio.Queue()
        tasks = [asyncio.create_task(process_chunk(manifest)) for manifest in chunk_manifests]

        while tasks:
            try:
                event_payload = await asyncio.wait_for(yield_queue.get(), timeout=0.25)
                yield event_payload
                last_progress_heartbeat = time.monotonic()
            except asyncio.TimeoutError:
                pass

            tasks = [task for task in tasks if not task.done()]

            if tasks and time.monotonic() - last_progress_heartbeat >= 5:
                active_chunks = len(tasks)
                progress = 35 + int((completed / total_chunks) * 35)
                yield progress_event(
                    PipelineStage.transcribing,
                    f"Still transcribing {active_chunks} active chunk(s). Larger files can take several minutes per chunk.",
                    progress=progress,
                    total_chunks=total_chunks,
                )
                last_progress_heartbeat = time.monotonic()

        while not yield_queue.empty():
            yield await yield_queue.get()

        final_chunks = [chunk for chunk in processed_chunks if chunk is not None]

        yield progress_event(PipelineStage.merging, "Merging chunk transcripts...", progress=75)
        merged = merge_chunk_results(final_chunks)

        transcript_ready_result = self.gemini.build_default_result(merged)
        yield sse_event(
            PipelineStage.result.value,
            {
                "stage": PipelineStage.result.value,
                "message": "Transcript ready. Generating Gemini artifacts...",
                "progress": 80,
                "result": transcript_ready_result.model_dump(),
            },
        )

        if duration_seconds > self.settings.gemini_auto_max_seconds:
            message = (
                f"Transcript complete. Skipped Gemini artifacts for {duration_seconds / 60:.1f}-minute audio to prioritize speed."
            )
            yield progress_event(PipelineStage.complete, message, progress=100)
            yield sse_event(
                PipelineStage.complete.value,
                {
                    "stage": PipelineStage.complete.value,
                    "message": message,
                    "progress": 100,
                    "result": transcript_ready_result.model_dump(),
                },
            )
            return

        yield progress_event(PipelineStage.artifact_generation, "Generating Gemini artifacts...", progress=88)
        final_result = await self.gemini.generate(merged)

        yield progress_event(PipelineStage.complete, "Transcription and analysis complete.", progress=100)
        yield sse_event(
            PipelineStage.complete.value,
            {
                "stage": PipelineStage.complete.value,
                "message": "Transcription and analysis complete.",
                "progress": 100,
                "result": final_result.model_dump(),
            },
        )