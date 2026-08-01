# viveda_echo/gemini_transcription_service.py
from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import time
from pathlib import Path
from typing import Any, Optional

import httpx

import traceback
from datetime import datetime


from .audio import create_chunk
from .config import Settings
from .gemini_rate_limiter import get_gemini_rate_limiter
from .models import ChunkTranscript, SpeakerSegment, TranscriptWord

logger = logging.getLogger(__name__)

# Main service responsible for transcribing audio chunks
# using the Gemini API and returning structured transcripts.
class GeminiTranscriptionBlockedError(Exception):
    """Raised when Gemini returns a blocked/cutoff finishReason (MAX_TOKENS,
    RECITATION, SAFETY, OTHER) for a transcription request. Distinct from a
    plain exception because it's usually caused by too much audio for one
    response to render in full (a dense 10-minute chunk full of speaker
    turns can produce enough JSON output to hit MAX_TOKENS) — retrying with
    the exact same audio wouldn't help, but splitting the audio in half and
    retrying each half independently can."""

    def __init__(self, finish_reason: str):
        self.finish_reason = finish_reason
        super().__init__(f"Gemini blocked: finishReason={finish_reason}")






# Below this chunk duration, splitting further isn't worth it — accept the
# failure placeholder instead of recursing indefinitely.
MIN_SPLIT_SECONDS = 45.0


class GeminiTranscriptionService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client: Optional[httpx.AsyncClient] = None
        self.total_gemini_seconds: float = 0.0
        self.metrics = None   # NEW

  
    # Create and reuse a single HTTP client for Gemini API requests.
    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.settings.chunk_request_timeout_seconds,
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            )
        return self._client
    # Transcribe a single audio chunk.
    # Handles retries, blocked responses, and recursive chunk splitting
    async def transcribe_chunk(
        self,
        chunk_id: int,
        file_path: Path,
        start_time: float,
        end_time: float,
        *,
        _split_path: str = "",
    ) -> ChunkTranscript:
        last_error: Exception | None = None

    
      
        chunk_started = time.monotonic()
        label = f"chunk {chunk_id}" if not _split_path else f"chunk {chunk_id} (part {_split_path})"

        for attempt in range(self.settings.transcription_retry_count + 1):
            call_started = time.monotonic()
            try:
                # Read audio file and convert to base64
                # Read the audio chunk and encode it as Base64
                # before sending it to the Gemini API.
                audio_bytes = await asyncio.to_thread(file_path.read_bytes)
                audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

                # STRICT FIX: Normalize MIME types explicitly to standard Gemini accepted strings
                ext = file_path.suffix.lower()
                # Determine the correct MIME type
                # based on the uploaded audio format.
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

                logger.info(f"Transcribing {label} (attempt {attempt + 1}), calling Gemini...")

                # Send the audio chunk to Gemini
                # for speech-to-text transcription.
                payload, finish_reason = await self._transcribe_via_gemini(audio_b64, mime_type)

                # ===================================================================================
                # Raw Gemini Response
                # ====================================================================================

                from pathlib import Path
                import json

                debug_dir = Path("logs/debug")
                debug_dir.mkdir(parents=True, exist_ok=True)

                suffix = f"_{_split_path}" if _split_path else ""

                with open(
                    debug_dir / f"chunk_{chunk_id}{suffix}_01_raw_gemini.json",
                    "w",
                    encoding="utf-8",
                ) as f:
                    json.dump(
                        {
                            "chunk_id": chunk_id,
                            "start_time": start_time,
                            "end_time": end_time,
                            "finish_reason": finish_reason,
                            "payload": payload,
                        },
                        f,
                        indent=2,
                        ensure_ascii=False,
                    )

                  # ===================================================================================
                                # END Raw Gemini Response
                 # ====================================================================================
                




                self.total_gemini_seconds += time.monotonic() - call_started
                logger.info(
                    f"{label} transcribed in {time.monotonic() - chunk_started:.1f}s total "
                    f"({attempt + 1} attempt(s))"
                )

                parsed = self._parse_gemini_payload(chunk_id, start_time, end_time, payload)

                      # ===================================================================================
                                                                #  CHUNK
                                                 # ====================================================================================

                with open(
                    debug_dir / f"chunk_{chunk_id}{suffix}_02_parsed_chunk.json",
                    "w",
                    encoding="utf-8",
                ) as f:
                    json.dump(
                        parsed.model_dump(),
                        f,
                        indent=2,
                        ensure_ascii=False,
                    )
                  # ===================================================================================
                                                # END CHUNK
                                 # ====================================================================================

                return parsed

            except GeminiTranscriptionBlockedError as exc:
                self.total_gemini_seconds += time.monotonic() - call_started
                duration = end_time - start_time
                if duration > MIN_SPLIT_SECONDS:
                    logger.warning(
                        f"{label} blocked ({exc.finish_reason}) — splitting into two "
                        f"halves and retrying each independently"
                    )
                    return await self._transcribe_by_splitting(
                        chunk_id, file_path, start_time, end_time, _split_path
                    )
                logger.warning(
                    f"{label} blocked ({exc.finish_reason}) and too short to split "
                    f"further ({duration:.0f}s) — leaving as failed"
                )
                last_error = exc
                break

            except Exception as exc:
        
                self.total_gemini_seconds += time.monotonic() - call_started
                logger.warning(f"Gemini transcription attempt {attempt + 1} failed for {label}: {exc}")
                last_error = exc
                if attempt >= self.settings.transcription_retry_count:
                    break
                await asyncio.sleep(2 ** attempt)

        logger.error(
            f"{label} gave up after {time.monotonic() - chunk_started:.1f}s: {last_error}"
        )

        # Fallback graceful failure object if all retries fail
        return ChunkTranscript(
            chunk_id=chunk_id,
            start_time=start_time,
            end_time=end_time,
            transcript=f"[{label} could not be transcribed by Gemini after retries.]",
            language="unknown",
            confidence=0.0,
            speakers=[
                SpeakerSegment(
                    speaker="System",
                    text=f"{label} transcription failed.",
                    start_time=start_time,
                    end_time=end_time,
                    confidence=0.0,
                )
            ],
            error=str(last_error) if last_error else "Unknown transcription error",
        )
    # Split large audio chunks into smaller parts
   # when Gemini cannot process them in a single request.
    async def _transcribe_by_splitting(
        self,
        chunk_id: int,
        file_path: Path,
        start_time: float,
        end_time: float,
        split_path: str,
    ) -> ChunkTranscript:
        """Slice this chunk's own audio file in half and transcribe each half
        independently (recursing further if a half is still blocked), then
        stitch the two results back into one ChunkTranscript with correctly
        offset timestamps. split_path accumulates '0'/'1' per recursion
        level so temp filenames never collide across splits."""
        duration = end_time - start_time
        midpoint = duration / 2
        output_dir = file_path.parent
        left_id = f"{chunk_id}_{split_path}0"
        right_id = f"{chunk_id}_{split_path}1"

        left_path: Path | None = None
        right_path: Path | None = None
        # Generate two smaller audio chunks
        # for recursive transcription.
        try:
            left_manifest = await asyncio.to_thread(
                create_chunk, file_path, output_dir, self.settings, left_id, 0.0, midpoint
            )
            right_manifest = await asyncio.to_thread(
                create_chunk, file_path, output_dir, self.settings, right_id, midpoint, duration
            )
            left_path, right_path = left_manifest.path, right_manifest.path

            left_result, right_result = await asyncio.gather(
                self.transcribe_chunk(
                    chunk_id, left_path, start_time, start_time + midpoint, _split_path=split_path + "0"
                ),
                self.transcribe_chunk(
                    chunk_id, right_path, start_time + midpoint, end_time, _split_path=split_path + "1"
                ),
            )
        finally:
            for p in (left_path, right_path):
                if p is not None:
                    try:
                        p.unlink(missing_ok=True)
                    except Exception:
                        pass

        combined_confidences = [
            r.confidence for r in (left_result, right_result) if r.confidence is not None
        ]
        return ChunkTranscript(
            chunk_id=chunk_id,
            start_time=start_time,
            end_time=end_time,
            transcript=" ".join(t for t in (left_result.transcript, right_result.transcript) if t).strip(),
            language=left_result.language or right_result.language,
            detected_language=left_result.detected_language or right_result.detected_language,
            languages=list(dict.fromkeys([*left_result.languages, *right_result.languages])),
            confidence=(sum(combined_confidences) / len(combined_confidences)) if combined_confidences else None,
            words=[*left_result.words, *right_result.words],
            language_metadata={**left_result.language_metadata, **right_result.language_metadata},
            speakers=[*left_result.speakers, *right_result.speakers],
            error=left_result.error or right_result.error,
        )

    async def _transcribe_via_gemini(self, audio_b64: str, mime_type: str) -> tuple[dict[str, Any], str]:
        model = self.settings.gemini_model
        url = (
            f"{self.settings.gemini_base_url}/models/{model}:generateContent"
            f"?key={self.settings.gemini_api_key}"
        )
        # Prompt instructing Gemini to perform
        # transcription and speaker diarization.
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
                "temperature": 0,
                "responseMimeType": "application/json",  # Forces native structured JSON output
                # Long, densely-diarized chunks (many short speaker turns, each
                # with its own timestamps) can produce a large JSON transcript.
                # Without an explicit ceiling the response can hit the model's
                # implicit default and get cut off mid-JSON (finishReason
                # MAX_TOKENS), losing the whole chunk. gemini-2.5-flash supports
                # up to 65536 output tokens.
                "maxOutputTokens": 65536,
                # gemini-2.5-flash spends output-token budget on internal
                # "thinking" by default, ahead of the actual transcript. That
                # reasoning isn't useful for verbatim transcription and can
                # itself eat enough of maxOutputTokens to trigger MAX_TOKENS
                # even with a generous ceiling. Disable it so the full budget
                # goes to the transcript, and requests come back faster.
                "thinkingConfig": {"thinkingBudget": 0},
            }
        }

        client = self._get_client()
        limiter = get_gemini_rate_limiter(
            self.settings.gemini_max_concurrent_calls,
            self.settings.gemini_min_call_interval_seconds,
        )
        async with limiter:
            # Call the Gemini API
            # to transcribe the uploaded audio.
            response = await client.post(url, headers=headers, json=request_body)
        response.raise_for_status()

        

        res_json = response.json()

          # NEW — record real usage even on a blocked/MAX_TOKENS response,
        # since the audio input was still sent and billed regardless of
        # whether the output got cut off.
        if self.metrics is not None:
            usage = res_json.get("usageMetadata", {})
            prompt_details = usage.get("promptTokensDetails", [])

            audio_tokens = sum(d.get("tokenCount", 0) for d in prompt_details if d.get("modality") == "AUDIO")
            text_tokens  = sum(d.get("tokenCount", 0) for d in prompt_details if d.get("modality") == "TEXT")

            if prompt_details:
                # Accurate: priced by actual modality
                self.metrics.gemini_audio_input_tokens += audio_tokens
                self.metrics.gemini_input_tokens += text_tokens
            else:
                # Fallback if this API version/response omits the breakdown —
                # approximate as before (all-audio), better than losing the data entirely
                self.metrics.gemini_audio_input_tokens += usage.get("promptTokenCount", 0)

            self.metrics.gemini_output_tokens += (
                usage.get("candidatesTokenCount", 0)
                + usage.get("thoughtsTokenCount", 0)
            )

        print(json.dumps(res_json.get("usageMetadata", {}), indent=2))

        candidates = res_json.get("candidates") or []
        if not candidates:
            block_reason = res_json.get("promptFeedback", {}).get("blockReason", "UNKNOWN")
            raise GeminiTranscriptionBlockedError(block_reason)

        candidate = candidates[0]
        finish_reason = candidate.get("finishReason", "STOP")
        if finish_reason in {"RECITATION", "SAFETY", "MAX_TOKENS", "OTHER"}:
            raise GeminiTranscriptionBlockedError(finish_reason)

        parts = candidate.get("content", {}).get("parts") or []
        if not parts or not parts[0].get("text"):
            raise RuntimeError(f"Gemini returned empty content: finishReason={finish_reason}")

        raw_text = parts[0]["text"]

        # Clean off any markdown wrapping blocks if Gemini adds them
        clean_text = raw_text.strip()
        if clean_text.startswith("```"):
            clean_text = clean_text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        try:
           payload = json.loads(clean_text)
           return payload, finish_reason
        except Exception:
            return (
                {
                    "transcript": clean_text,
                    "language": "en",
                    "speakers": [],
                },
                finish_reason,
            )
    # Convert the Gemini response into
    # the application's transcript format.
    def _parse_gemini_payload(self, chunk_id: int, chunk_start: float, chunk_end: float, data: dict[str, Any]) -> ChunkTranscript:
        transcript = data.get("transcript", "").strip()
        language = data.get("language", "unknown")
        raw_speakers = data.get("speakers", [])

        speakers: list[SpeakerSegment] = []
        words: list[TranscriptWord] = []
        # Process each speaker segment and
        # convert relative timestamps to absolute timestamps.
        for item in raw_speakers:
            try:
                rel_start = float(item.get("start_time", 0.0))
            except (TypeError, ValueError):
                rel_start = 0.0
            try:
                rel_end = float(item.get("end_time", rel_start))
            except (TypeError, ValueError):
                rel_end = rel_start

            # Guard against a reversed pair from the model (end before start)
            if rel_end < rel_start:
                rel_start, rel_end = rel_end, rel_start

            # Clamp both ends to this chunk's own duration — never let a
            # segment claim to start before 0.0 (relative) or extend past
            # the chunk's actual length, regardless of what Gemini reports.
            chunk_duration = max(0.0, chunk_end - chunk_start)
            rel_start = max(0.0, min(rel_start, chunk_duration))
            rel_end = max(0.0, min(rel_end, chunk_duration))

            abs_start = chunk_start + rel_start
            abs_end = chunk_start + rel_end

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

        # NEW: If Gemini didn't return a transcript, rebuild it from the speakers
        if not transcript:
            transcript = " ".join(
                s.text.strip()
                for s in speakers
                if s.text.strip()
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
        # Return the final structured transcript
        # for this audio chunk.
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
