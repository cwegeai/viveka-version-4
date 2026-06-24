from __future__ import annotations

import asyncio
import logging
import tempfile
import time
from pathlib import Path

from fastapi import UploadFile

from .audio import ChunkManifest, build_chunk_plan, create_chunk, prepare_chunks, probe_duration_seconds, stream_upload_to_disk
from .config import Settings
from .deepgram_service import DeepgramTranscriptionService
from .events import progress_event, sse_event
from .gemini_service import GeminiArtifactService
from .merge_engine import merge_chunk_results
from .models import ChunkTranscript, PipelineStage

logger = logging.getLogger(__name__)


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
        chunk_plan: list[tuple[int, float, float]] | None = None
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
            chunk_plan = build_chunk_plan(duration_seconds, self.settings)
            chunk_manifests = []
        total_chunks = len(chunk_manifests) if chunk_plan is None else len(chunk_plan)
        if total_chunks == 0:
            yield progress_event(PipelineStage.error, "Audio preprocessing did not produce any chunks.", progress=35)
            return
        if duration_seconds > self.settings.direct_transcribe_max_seconds:
            yield progress_event(
                PipelineStage.splitting,
                f"Preparing {total_chunks} chunk(s) from {duration_seconds / 60:.1f} minutes of audio and starting transcription immediately.",
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
                try:
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
                finally:
                    if manifest.path != source_path:
                        try:
                            manifest.path.unlink(missing_ok=True)
                        except Exception:
                            pass

        yield_queue: asyncio.Queue[str] = asyncio.Queue()

        if chunk_plan is None:
            tasks = [asyncio.create_task(process_chunk(manifest)) for manifest in chunk_manifests]
        else:
            creation_semaphore = asyncio.Semaphore(4)

            async def create_and_process_chunk(chunk_id: int, start_time: float, end_time: float) -> None:
                async with creation_semaphore:
                    manifest = await asyncio.to_thread(
                        create_chunk,
                        source_path,
                        chunks_dir,
                        self.settings,
                        chunk_id,
                        start_time,
                        end_time,
                    )
                await process_chunk(manifest)

            tasks = [
                asyncio.create_task(create_and_process_chunk(cid, st, et))
                for cid, st, et in chunk_plan
            ]

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

        yield progress_event(PipelineStage.merging, "Generating transcript, translation & summary...", progress=80)

        try:
            final_result = await self.gemini.build_transcript_ready_result(merged, include_summary=True)
        except Exception as e:
            logger.error(f"Gemini transcript/summary generation failed: {e}", exc_info=True)
            final_result = self.gemini.build_default_result(merged)

        yield sse_event(
            PipelineStage.result.value,
            {
                "stage": PipelineStage.result.value,
                "message": "Transcript ready.",
                "progress": 95,
                "result": final_result.model_dump(),
            },
        )

        yield progress_event(PipelineStage.complete, "Transcription complete.", progress=100)
        yield sse_event(
            PipelineStage.complete.value,
            {
                "stage": PipelineStage.complete.value,
                "message": "Transcription complete.",
                "progress": 100,
                "result": final_result.model_dump(),
            },
        )