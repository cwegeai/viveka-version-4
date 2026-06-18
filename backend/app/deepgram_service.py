from __future__ import annotations

import asyncio
import mimetypes
from pathlib import Path
from typing import Any, Iterable, Mapping

import httpx

from .config import Settings
from .models import ChunkTranscript, SpeakerSegment, TranscriptWord


def _coerce_language(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return None


def _dedupe_languages(values: Iterable[str | None]) -> list[str]:
    deduped: list[str] = []
    for value in values:
        normalized = _coerce_language(value)
        if normalized and normalized not in deduped:
            deduped.append(normalized)
    return deduped


def _extract_language_metadata(source: Mapping[str, Any] | None) -> dict[str, Any]:
    if not source:
        return {}
    return {
        key: value
        for key, value in source.items()
        if "language" in key.lower() and value not in (None, "", [], {})
    }


def _primary_language(explicit_values: Iterable[str | None], fallback_languages: Iterable[str | None]) -> str:
    explicit = _dedupe_languages(explicit_values)
    if explicit:
        return explicit[0]
    fallback = _dedupe_languages(fallback_languages)
    if fallback:
        return fallback[0]
    return "unknown"


def _join_word_text(words: list[TranscriptWord]) -> str:
    text = " ".join(
        (word.punctuated_word or word.word).strip()
        for word in words
        if (word.punctuated_word or word.word).strip()
    )
    return text.replace("  ", " ").replace(" ,", ",").replace(" .", ".").replace(" !", "!").replace(" ?", "?").strip()


class DeepgramTranscriptionService:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def transcribe_chunk(self, chunk_id: int, file_path: Path, start_time: float, end_time: float) -> ChunkTranscript:
        last_error: Exception | None = None
        for attempt in range(self.settings.transcription_retry_count + 1):
            try:
                payload = await asyncio.to_thread(self._transcribe_sync, file_path)
                return self._parse_payload(chunk_id, start_time, end_time, payload)
            except Exception as exc:
                last_error = exc
                if attempt >= self.settings.transcription_retry_count:
                    break
                await asyncio.sleep(2 ** attempt)

        return ChunkTranscript(
            chunk_id=chunk_id,
            start_time=start_time,
            end_time=end_time,
            transcript=f"[Chunk {chunk_id} could not be transcribed after retries.]",
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

    def _transcribe_sync(self, file_path: Path) -> Any:
        if not self.settings.deepgram_api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is not configured.")

        url = f"{self.settings.deepgram_base_url}{self.settings.deepgram_listen_path}"
        params = {
            "model": self.settings.deepgram_model,
            "language": self.settings.deepgram_language,
            "smart_format": "true",
            "punctuate": "true",
            "diarize": "true",
            "filler_words": "false",
        }
        headers = {
            "Authorization": f"Token {self.settings.deepgram_api_key}",
            "Content-Type": mimetypes.guess_type(file_path.name)[0] or "application/octet-stream",
        }

        with file_path.open("rb") as file_handle:
            with httpx.Client(timeout=self.settings.chunk_request_timeout_seconds) as client:
                response = client.post(url, params=params, headers=headers, content=file_handle.read())
        response.raise_for_status()
        return response.json()

    def _parse_payload(self, chunk_id: int, start_time: float, end_time: float, payload: Any) -> ChunkTranscript:
        if hasattr(payload, "model_dump"):
            data = payload.model_dump()
        elif hasattr(payload, "dict"):
            data = payload.dict()
        else:
            data = payload

        channel = ((data.get("results") or {}).get("channels") or [{}])[0]
        alternative = (channel.get("alternatives") or [{}])[0]
        transcript = str(alternative.get("transcript") or "").strip()
        confidence = alternative.get("confidence")
        raw_words = alternative.get("words") or []

        channel_language_metadata = _extract_language_metadata(channel)
        alternative_language_metadata = _extract_language_metadata(alternative)

        words: list[TranscriptWord] = []
        for raw_word in raw_words:
            token = str(raw_word.get("punctuated_word") or raw_word.get("word") or "").strip()
            if not token:
                continue

            raw_start = float(raw_word.get("start", 0.0) or 0.0)
            raw_end = float(raw_word.get("end", raw_start) or raw_start)
            speaker_value = raw_word.get("speaker")
            words.append(
                TranscriptWord(
                    word=str(raw_word.get("word") or "").strip(),
                    punctuated_word=str(raw_word.get("punctuated_word") or "").strip() or None,
                    start_time=start_time + raw_start,
                    end_time=min(end_time, start_time + raw_end),
                    confidence=float(raw_word["confidence"]) if raw_word.get("confidence") is not None else None,
                    speaker=self._speaker_label(speaker_value) if speaker_value is not None else None,
                    language=_coerce_language(raw_word.get("language")),
                    language_metadata=_extract_language_metadata(raw_word),
                )
            )

        languages = _dedupe_languages(
            [
                channel.get("detected_language"),
                channel.get("language"),
                alternative.get("detected_language"),
                alternative.get("language"),
                *list(channel.get("languages") or []),
                *list(alternative.get("languages") or []),
                *(word.language for word in words),
            ]
        )
        detected_language = _coerce_language(channel.get("detected_language") or alternative.get("detected_language"))
        language = _primary_language(
            [detected_language, channel.get("language"), alternative.get("language")],
            languages,
        )

        speakers: list[SpeakerSegment] = []
        if words:
            current_words = [words[0]]
            current_speaker = words[0].speaker or "Speaker 1"

            for word in words[1:]:
                speaker = word.speaker or current_speaker

                if speaker != current_speaker:
                    speakers.append(self._build_segment(current_speaker, current_words))
                    current_speaker = speaker
                    current_words = [word]
                else:
                    current_words.append(word)

            speakers.append(self._build_segment(current_speaker, current_words))

        if not transcript:
            transcript = " ".join(segment.text for segment in speakers).strip()

        if not speakers and transcript:
            speakers = [
                SpeakerSegment(
                    speaker="Speaker 1",
                    text=transcript,
                    start_time=start_time,
                    end_time=end_time,
                    confidence=confidence,
                    language=language,
                    languages=languages,
                    words=words,
                    language_metadata=alternative_language_metadata or channel_language_metadata,
                )
            ]

        return ChunkTranscript(
            chunk_id=chunk_id,
            start_time=start_time,
            end_time=end_time,
            transcript=transcript,
            language=language,
            detected_language=detected_language,
            languages=languages,
            confidence=float(confidence) if confidence is not None else None,
            words=words,
            language_metadata={
                "channel": channel_language_metadata,
                "alternative": alternative_language_metadata,
            },
            speakers=speakers,
        )

    def _build_segment(self, speaker: str, words: list[TranscriptWord]) -> SpeakerSegment:
        text = _join_word_text(words)
        segment_languages = _dedupe_languages(word.language for word in words)
        confidence_values = [word.confidence for word in words if word.confidence is not None]
        return SpeakerSegment(
            speaker=speaker,
            text=text,
            start_time=words[0].start_time,
            end_time=words[-1].end_time,
            confidence=(sum(confidence_values) / len(confidence_values)) if confidence_values else None,
            language=_primary_language(segment_languages, segment_languages),
            languages=segment_languages,
            words=words,
            language_metadata={
                "words": [word.language_metadata for word in words if word.language_metadata],
            },
        )

    @staticmethod
    def _speaker_label(value: Any) -> str:
        if isinstance(value, int):
            return f"Speaker {value + 1}"
        if isinstance(value, str) and value.strip():
            return value.strip()
        return "Speaker 1"