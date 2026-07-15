# viveda_echo/gemini_transcription_service.py
from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import random
from pathlib import Path
from typing import Any, Optional

import httpx

from .config import Settings
from .models import ChunkTranscript, SpeakerSegment, TranscriptWord

logger = logging.getLogger(__name__)

# FIX: process-wide cap on concurrent Gemini generateContent calls, keyed
# by (base_url, model) so different configs don't share a limiter.
# Chunks used to all fire at Gemini simultaneously (only gated by the
# unrelated file-size worker semaphore in pipeline.py), which instantly
# blew through Gemini's per-minute request quota and 429'd every chunk
# at once. This semaphore is created lazily per event loop / settings
# combo and shared across all GeminiTranscriptionService instances in
# this process.
_gemini_semaphores: dict[tuple[str, str], asyncio.Semaphore] = {}


def _get_gemini_semaphore(settings: Settings) -> asyncio.Semaphore:
    key = (settings.gemini_base_url, settings.gemini_model)
    sem = _gemini_semaphores.get(key)
    if sem is None:
        sem = asyncio.Semaphore(max(1, settings.gemini_max_concurrent_requests))
        _gemini_semaphores[key] = sem
    return sem


class GeminiTranscriptionService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client: Optional[httpx.AsyncClient] = None
        self._semaphore = _get_gemini_semaphore(settings)

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
                # Read audio file and convert to base64
                audio_bytes = await asyncio.to_thread(file_path.read_bytes)
                audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
                
                # STRICT FIX: Normalize MIME types explicitly to standard Gemini accepted strings
                ext = file_path.suffix.lower()
                if ext in [".mp3", ".mpeg"]:
                    mime_type = "audio/mp3"
                elif ext == ".wav":
                    mime_type = "audio/wav"
                elif ext in [".ogg", ".opus"]:
                    mime_type = "audio/ogg"
                elif ext == ".aac":
                    mime_type = "audio/aac"
                else:
                    mime_type = mimetypes.guess_type(file_path.name)[0] or "audio/mp3"

                # FIX: gate the actual network call behind a process-wide
                # semaphore so only N chunks ever hit Gemini at once,
                # instead of every chunk firing simultaneously and
                # tripping the per-minute request quota (429).
                async with self._semaphore:
                    payload = await self._transcribe_via_gemini(audio_b64, mime_type)
                return self._parse_gemini_payload(chunk_id, start_time, end_time, payload)
            except Exception as exc:
                logger.warning(f"Gemini transcription attempt {attempt + 1} failed for chunk {chunk_id}: {exc}")
                last_error = exc
                if attempt >= self.settings.transcription_retry_count:
                    break

                # FIX: 429 (rate limit) needs a much longer wait than a
                # normal transient error - the old `2 ** attempt` backoff
                # (1s, 2s, 4s...) is far shorter than Gemini's ~60s
                # per-minute quota window, so retries just got 429'd
                # again in lockstep with every other chunk. If Gemini
                # sends a Retry-After header, honor it exactly; otherwise
                # use a long backoff with jitter so concurrent chunks
                # don't all retry at the same instant.
                status_code = getattr(getattr(exc, "response", None), "status_code", None)
                if status_code == 429:
                    retry_after_header = exc.response.headers.get("Retry-After") if hasattr(exc, "response") else None
                    if retry_after_header:
                        try:
                            wait_seconds = float(retry_after_header)
                        except ValueError:
                            wait_seconds = 20.0 * (attempt + 1)
                    else:
                        wait_seconds = 20.0 * (attempt + 1)
                    wait_seconds += random.uniform(0, 5)
                    logger.info(f"Chunk {chunk_id} rate-limited by Gemini (429) - waiting {wait_seconds:.1f}s before retry.")
                else:
                    wait_seconds = (2 ** attempt) + random.uniform(0, 1)
                await asyncio.sleep(wait_seconds)

        # Fallback graceful failure object if all retries fail
        return ChunkTranscript(
            chunk_id=chunk_id,
            start_time=start_time,
            end_time=end_time,
            transcript=f"[Chunk {chunk_id} could not be transcribed by Gemini after retries.]",
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

    async def _transcribe_via_gemini(self, audio_b64: str, mime_type: str) -> dict[str, Any]:
        model = self.settings.gemini_model
        url = (
            f"{self.settings.gemini_base_url}/models/{model}:generateContent"
            f"?key={self.settings.gemini_api_key}"
        )

        prompt = (
            "You are an expert audio transcription and diarization engine. "
            "Analyze the provided audio file and return a verbatim transcript. "
            "Diarize distinct speakers carefully (e.g., 'Speaker 1', 'Speaker 2'). "
            "The timestamps for each segment must be relative to the start of this specific audio file (0.0 seconds).\n\n"
            "You MUST respond ONLY with a valid JSON object matching this schema structure:\n"
            "{\n"
            "  \"transcript\": \"Full text combining all turns...\",\n"
            "  \"language\": \"en\",\n"
            "  \"speakers\": [\n"
            "    {\n"
            "      \"speaker\": \"Speaker 1\",\n"
            "      \"text\": \"The text spoken in this segment.\",\n"
            "      \"start_time\": 0.0,\n"
            "      \"end_time\": 4.5\n"
            "    }\n"
            "  ]\n"
            "}"
        )

        headers = {"Content-Type": "application/json"}
        
        # CRITICAL FIXED ORDER: The text instructions part MUST precede the inlineData block
        request_body = {
            "contents": [
                {
                    "parts": [
                        {
                            "text": prompt
                        },
                        {
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": audio_b64
                            }
                        }
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json"  # Forces native structured JSON output
            }
        }

        client = self._get_client()
        response = await client.post(url, headers=headers, json=request_body)
        response.raise_for_status()
        
        res_json = response.json()
        raw_text = res_json["candidates"][0]["content"]["parts"][0]["text"]
        
        # Clean off any markdown wrapping blocks if Gemini adds them
        clean_text = raw_text.strip()
        if clean_text.startswith("```"):
            clean_text = clean_text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        try:
            return json.loads(clean_text)
        except Exception:
            return {"transcript": clean_text, "language": "en", "speakers": []}

    def _parse_gemini_payload(self, chunk_id: int, chunk_start: float, chunk_end: float, data: dict[str, Any]) -> ChunkTranscript:
        transcript = data.get("transcript", "").strip()
        language = data.get("language", "unknown")
        raw_speakers = data.get("speakers", [])

        speakers: list[SpeakerSegment] = []
        words: list[TranscriptWord] = []

        for item in raw_speakers:
            rel_start = float(item.get("start_time", 0.0))
            rel_end = float(item.get("end_time", rel_start))
            
            abs_start = chunk_start + rel_start
            abs_end = min(chunk_end, chunk_start + rel_end)
            speaker_label = str(item.get("speaker", "Speaker 1")).strip()
            segment_text = str(item.get("text", "")).strip()

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
                    language_metadata={}
                )
            )

        if not speakers and transcript:
            speakers.append(
                SpeakerSegment(
                    speaker="Speaker 1",
                    text=transcript,
                    start_time=chunk_start,
                    end_time=chunk_end,
                    confidence=1.0,
                    language=language,
                    languages=[language],
                    words=[],
                    language_metadata={}
                )
            )

        return ChunkTranscript(
            chunk_id=chunk_id,
            start_time=chunk_start,
            end_time=chunk_end,
            transcript=transcript,
            language=language,
            detected_language=language,
            languages=[language],
            confidence=1.0,
            words=words,
            language_metadata={},
            speakers=speakers,
        )