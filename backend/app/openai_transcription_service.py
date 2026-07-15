# backend/app/openai_transcription_service.py
#
# Fallback transcription engine, used only by HybridTranscriptionService
# when Gemini fails a chunk after its own retries. Same public interface
# as GeminiTranscriptionService:
#   transcribe_chunk(chunk_id, file_path, start_time, end_time) -> ChunkTranscript

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
from pathlib import Path
from typing import Any, Optional

import httpx

from .config import Settings
from .models import ChunkTranscript, SpeakerSegment, TranscriptWord

logger = logging.getLogger(__name__)


class OpenAITranscriptionService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.settings.chunk_request_timeout_seconds,
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            )
        return self._client

    async def transcribe_chunk(self, chunk_id: int, file_path: Path, start_time: float, end_time: float) -> ChunkTranscript:
        last_error: Exception | None = None

        for attempt in range(self.settings.transcription_retry_count + 1):
            try:
                payload = await self._transcribe_via_openai(file_path)
                return self._parse_openai_payload(chunk_id, start_time, end_time, payload)
            except Exception as exc:
                logger.warning(f"OpenAI transcription attempt {attempt + 1} failed for chunk {chunk_id}: {exc}")
                last_error = exc
                if attempt >= self.settings.transcription_retry_count:
                    break
                await asyncio.sleep(2 ** attempt)

        # Never raise - always return something visible so pipeline.py
        # can't silently lose the chunk, and so HybridTranscriptionService
        # can detect the failure via `.error`.
        return ChunkTranscript(
            chunk_id=chunk_id,
            start_time=start_time,
            end_time=end_time,
            transcript=f"[Chunk {chunk_id} could not be transcribed by OpenAI after retries.]",
            language="unknown",
            confidence=0.0,
            speakers=[
                SpeakerSegment(
                    speaker="System",
                    text=f"Chunk {chunk_id} transcription failed.",
                    start_time=start_time,
                    end_time=end_time,
                    confidence=0.0,
                )
            ],
            error=str(last_error) if last_error else "Unknown transcription error",
        )

    async def _transcribe_via_openai(self, file_path: Path) -> dict[str, Any]:
        url = f"{self.settings.openai_base_url}/audio/transcriptions"
        headers = {"Authorization": f"Bearer {self.settings.openai_api_key}"}

        mime_type = mimetypes.guess_type(file_path.name)[0] or "audio/flac"
        audio_bytes = await asyncio.to_thread(file_path.read_bytes)

        files = {
            "file": (file_path.name, audio_bytes, mime_type),
        }
        data = {
            "model": self.settings.openai_transcribe_model,
            "response_format": "diarized_json",
            "chunking_strategy": "auto",
        }
        # Without an explicit language hint, OpenAI's transcription models
        # often default to romanized (Latin-script) output for Hindi/
        # English code-switched speech instead of native Devanagari.
        # Passing the ISO code forces native-script output for that
        # language.
        if self.settings.openai_transcribe_language:
            data["language"] = self.settings.openai_transcribe_language

        client = self._get_client()
        response = await client.post(url, headers=headers, data=data, files=files)
        response.raise_for_status()
        return response.json()

    def _parse_openai_payload(self, chunk_id: int, chunk_start: float, chunk_end: float, data: dict[str, Any]) -> ChunkTranscript:
        raw_segments = data.get("segments", [])
        language = data.get("language", "unknown") or "unknown"

        speakers: list[SpeakerSegment] = []
        for item in raw_segments:
            rel_start = float(item.get("start", 0.0))
            rel_end = float(item.get("end", rel_start))

            abs_start = chunk_start + rel_start
            abs_end = min(chunk_end, chunk_start + rel_end)
            speaker_label = str(item.get("speaker", "Speaker 1")).strip()
            segment_text = str(item.get("text", "")).strip()
            logger.info(f"TRANSCRIPT (OpenAI fallback): {segment_text}")

            if not segment_text:
                continue

            speakers.append(
                SpeakerSegment(
                    speaker=speaker_label,
                    text=segment_text,
                    start_time=abs_start,
                    end_time=abs_end,
                    confidence=1.0,
                    language=language,
                    languages=[language],
                    words=[],
                    language_metadata={},
                )
            )

        full_transcript = data.get("text", "").strip()
        if not full_transcript and speakers:
            full_transcript = " ".join(seg.text for seg in speakers)

        if not speakers and full_transcript:
            speakers.append(
                SpeakerSegment(
                    speaker="Speaker 1",
                    text=full_transcript,
                    start_time=chunk_start,
                    end_time=chunk_end,
                    confidence=1.0,
                    language=language,
                    languages=[language],
                    words=[],
                    language_metadata={},
                )
            )

        return ChunkTranscript(
            chunk_id=chunk_id,
            start_time=chunk_start,
            end_time=chunk_end,
            transcript=full_transcript,
            language=language,
            detected_language=language,
            languages=[language],
            confidence=1.0,
            words=[],
            language_metadata={},
            speakers=speakers,
        )
