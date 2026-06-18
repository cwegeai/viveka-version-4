from __future__ import annotations

import re

from .models import ChunkTranscript, MergedTranscript, SpeakerSegment, TranscriptWord


TOKEN_PATTERN = re.compile(r"\w+|[^\w\s]", re.UNICODE)


def format_timestamp(seconds: float) -> str:
    whole_seconds = max(0, int(seconds))
    minutes = whole_seconds // 60
    remaining_seconds = whole_seconds % 60
    return f"{minutes:02d}:{remaining_seconds:02d}"


def _tokenize(text: str) -> list[str]:
    return TOKEN_PATTERN.findall(text or "")


def _normalize_token(token: str) -> str:
    return re.sub(r"\W+", "", token.lower())


def _ordered_unique(values: list[str]) -> list[str]:
    ordered: list[str] = []
    for value in values:
        normalized = value.strip() if isinstance(value, str) else ""
        if normalized and normalized not in ordered:
            ordered.append(normalized)
    return ordered


def _segment_text_from_words(words: list[TranscriptWord]) -> str:
    text = " ".join((word.punctuated_word or word.word).strip() for word in words if (word.punctuated_word or word.word).strip())
    return text.replace("  ", " ").replace(" ,", ",").replace(" .", ".").replace(" !", "!").replace(" ?", "?").strip()


def _find_word_overlap(prev_words: list[TranscriptWord], next_words: list[TranscriptWord], max_tokens: int = 80) -> int:
    prev_tokens = [_normalize_token(word.punctuated_word or word.word) for word in prev_words if _normalize_token(word.punctuated_word or word.word)]
    next_tokens = [_normalize_token(word.punctuated_word or word.word) for word in next_words if _normalize_token(word.punctuated_word or word.word)]
    search_limit = min(max_tokens, len(prev_tokens), len(next_tokens))

    for overlap_size in range(search_limit, 0, -1):
        if prev_tokens[-overlap_size:] == next_tokens[:overlap_size]:
            return overlap_size
    return 0


def _merge_language_metadata(previous: dict, candidate: dict) -> dict:
    if not previous:
        return dict(candidate or {})
    if not candidate:
        return dict(previous)

    merged = dict(previous)
    for key, value in candidate.items():
        if key not in merged:
            merged[key] = value
            continue

        previous_value = merged[key]
        if isinstance(previous_value, list) and isinstance(value, list):
            merged[key] = previous_value + value
        elif previous_value != value:
            merged[key] = [previous_value, value] if not isinstance(previous_value, list) else previous_value + [value]
    return merged


def _primary_language(languages: list[str], fallback: str = "unknown") -> str:
    return languages[0] if languages else fallback


def _find_overlap(prev_text: str, next_text: str, max_tokens: int = 80) -> int:
    prev_tokens = _tokenize(prev_text)
    next_tokens = _tokenize(next_text)
    search_limit = min(max_tokens, len(prev_tokens), len(next_tokens))

    for overlap_size in range(search_limit, 0, -1):
        prev_slice = [_normalize_token(token) for token in prev_tokens[-overlap_size:]]
        next_slice = [_normalize_token(token) for token in next_tokens[:overlap_size]]
        if prev_slice and prev_slice == next_slice:
            return overlap_size
    return 0


def _trim_overlap(next_text: str, overlap_size: int) -> str:
    if overlap_size <= 0:
        return next_text.strip()
    tokens = _tokenize(next_text)
    trimmed = tokens[overlap_size:]
    rebuilt = " ".join(trimmed)
    rebuilt = rebuilt.replace(" ,", ",").replace(" .", ".").replace(" !", "!").replace(" ?", "?")
    return rebuilt.strip()


def merge_chunk_results(chunk_results: list[ChunkTranscript]) -> MergedTranscript:
    ordered_results = sorted(chunk_results, key=lambda chunk: chunk.start_time)
    merged_segments: list[SpeakerSegment] = []
    collected_languages: list[str] = []
    confidence_values: list[float] = []
    merged_words: list[TranscriptWord] = []
    chunk_language_metadata: list[dict] = []

    for chunk in ordered_results:
        collected_languages.extend(chunk.languages or ([chunk.language] if chunk.language else []))
        if chunk.confidence is not None:
            confidence_values.append(chunk.confidence)
        if chunk.language_metadata:
            chunk_language_metadata.append(chunk.language_metadata)

        incoming_segments = chunk.speakers or [
            SpeakerSegment(
                speaker="Speaker 1",
                text=chunk.transcript,
                start_time=chunk.start_time,
                end_time=chunk.end_time,
                confidence=chunk.confidence,
                language=chunk.language,
                languages=chunk.languages,
                words=chunk.words,
                language_metadata=chunk.language_metadata,
            )
        ]

        for segment in incoming_segments:
            candidate = segment.model_copy(deep=True)
            candidate.text = candidate.text.strip()
            if not candidate.text:
                continue

            if not merged_segments:
                merged_segments.append(candidate)
                continue

            previous = merged_segments[-1]

            if candidate.end_time <= previous.end_time:
                continue

            if candidate.start_time < previous.end_time:
                overlap_size = 0
                if previous.words and candidate.words:
                    overlap_size = _find_word_overlap(previous.words, candidate.words)
                    if overlap_size > 0:
                        candidate.words = candidate.words[overlap_size:]
                        candidate.text = _segment_text_from_words(candidate.words)
                if overlap_size == 0:
                    overlap_size = _find_overlap(previous.text, candidate.text)
                    candidate.text = _trim_overlap(candidate.text, overlap_size)
                candidate.start_time = max(candidate.start_time, previous.end_time)

            if not candidate.text:
                continue

            if candidate.speaker == previous.speaker and candidate.start_time <= previous.end_time + 1.0:
                merged_text = f"{previous.text.rstrip()} {candidate.text.lstrip()}".strip()
                merged_text = merged_text.replace(" ,", ",").replace(" .", ".")
                merged_languages = _ordered_unique((previous.languages or []) + (candidate.languages or []))
                merged_word_list = [*previous.words, *candidate.words]
                merged_segments[-1] = previous.model_copy(
                    update={
                        "text": merged_text,
                        "end_time": max(previous.end_time, candidate.end_time),
                        "confidence": candidate.confidence or previous.confidence,
                        "language": _primary_language(merged_languages, candidate.language or previous.language or "unknown"),
                        "languages": merged_languages,
                        "words": merged_word_list,
                        "language_metadata": _merge_language_metadata(previous.language_metadata, candidate.language_metadata),
                    }
                )
            else:
                merged_segments.append(candidate)

        merged_words.extend(chunk.words)

    transcript = "\n".join(f"{segment.speaker}: {segment.text}" for segment in merged_segments).strip()
    merged_languages = _ordered_unique(collected_languages)
    dominant_language = _primary_language(merged_languages)
    average_confidence = (sum(confidence_values) / len(confidence_values)) if confidence_values else None

    return MergedTranscript(
        transcript=transcript,
        language=dominant_language,
        detected_language=dominant_language,
        languages=merged_languages,
        confidence=average_confidence,
        words=merged_words,
        language_metadata={"chunks": chunk_language_metadata},
        speakers=merged_segments,
        chunk_results=ordered_results,
    )