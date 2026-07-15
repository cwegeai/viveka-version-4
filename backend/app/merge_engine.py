from __future__ import annotations

import difflib
import re

from .models import ChunkTranscript, MergedTranscript, SpeakerSegment, TranscriptWord


TOKEN_PATTERN = re.compile(r"\w+|[^\w\s]", re.UNICODE)

# FIX: Only trim an overlap if it's at least this many tokens long.
# Short common words (e.g. "haan", "achha", "nahin") repeat naturally
# throughout a real conversation and are NOT reliable evidence of a
# chunk-boundary duplicate. A short coincidental match must never
# delete real, distinct content.
MIN_SAFE_OVERLAP_TOKENS = 4

# FIX: threshold for the FUZZY chunk-boundary duplicate check below.
# This is intentionally high (0.65) and is only ever evaluated inside
# the existing temporal-overlap gate (candidate.start_time <
# previous.end_time) - i.e. only for segments that genuinely sit at a
# real chunk boundary produced by our own overlap_seconds setting.
# It must NEVER be applied across the whole transcript, because two
# different speakers can legitimately say very similar things far
# apart in time (e.g. the same standardized survey question asked to
# two different household members) - that is real content, not a
# duplicate, and must never be deleted.
FUZZY_DUPLICATE_THRESHOLD = 0.65


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


# FIX: exact-token overlap detection (_find_overlap / _find_word_overlap
# above) only catches duplicates where OpenAI transcribed the SAME
# overlapping audio identically both times. In practice the model is
# not perfectly deterministic - re-transcribing the same few seconds of
# audio across two chunks can produce slightly different wording
# (alternate spelling, a misheard word, punctuation differences), so an
# exact match finds zero overlap and the duplicate slips through.
#
# This fuzzy check is a fallback for exactly that case. It is ONLY ever
# called from inside the existing temporal-overlap gate further down
# (candidate.start_time < previous.end_time), so it only ever compares
# segments that are genuinely adjacent in time at a real chunk
# boundary - never content minutes apart, which could coincidentally
# be worded similarly (e.g. the same standardized question asked to a
# different respondent) but is real, distinct content that must never
# be deleted.
def _is_fuzzy_duplicate(prev_text: str, next_text: str, max_tokens: int = 80, threshold: float = FUZZY_DUPLICATE_THRESHOLD) -> bool:
    prev_tokens = [_normalize_token(token) for token in _tokenize(prev_text) if _normalize_token(token)]
    next_tokens = [_normalize_token(token) for token in _tokenize(next_text) if _normalize_token(token)]

    if len(prev_tokens) < MIN_SAFE_OVERLAP_TOKENS or len(next_tokens) < MIN_SAFE_OVERLAP_TOKENS:
        return False

    # Compare against a tail window of the previous segment sized relative
    # to the candidate, not the whole (possibly very long, already-merged)
    # previous segment - otherwise a short real duplicate would get diluted
    # into a low similarity ratio against a long accumulated text.
    window = min(max_tokens, max(len(next_tokens) * 2, MIN_SAFE_OVERLAP_TOKENS))
    prev_window_tokens = prev_tokens[-window:]

    similarity = difflib.SequenceMatcher(None, " ".join(prev_window_tokens), " ".join(next_tokens)).ratio()
    return similarity >= threshold


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

            # FIX (was): `if candidate.end_time <= previous.end_time: continue`
            # That silently threw away the ENTIRE segment's text whenever
            # Gemini's estimated timestamps looked out of order - which
            # happens often in fast, overlapping, multi-speaker dialogue.
            # Gemini's timestamps are an estimate, not a reliable clock -
            # they must never be allowed to delete real transcribed text.
            # Instead: nudge the timestamp forward so ordering stays sane,
            # but KEEP the text.
            if candidate.end_time <= previous.end_time:
                original_span = max(0.1, candidate.end_time - candidate.start_time)
                candidate.start_time = previous.end_time
                candidate.end_time = previous.end_time + original_span

            if candidate.start_time < previous.end_time:
                overlap_size = 0
                if previous.words and candidate.words:
                    word_overlap_size = _find_word_overlap(previous.words, candidate.words)
                    # FIX: only trust a word-level overlap if it clears the
                    # minimum safe length. A 1-2 word match is very likely
                    # a coincidence (repeated common words), not a real
                    # chunk-boundary duplicate.
                    if word_overlap_size >= MIN_SAFE_OVERLAP_TOKENS:
                        overlap_size = word_overlap_size
                        candidate.words = candidate.words[overlap_size:]
                        candidate.text = _segment_text_from_words(candidate.words)
                if overlap_size == 0:
                    text_overlap_size = _find_overlap(previous.text, candidate.text)
                    # FIX: same minimum-length safety check on the
                    # text-level overlap path.
                    if text_overlap_size >= MIN_SAFE_OVERLAP_TOKENS:
                        candidate.text = _trim_overlap(candidate.text, text_overlap_size)
                    elif _is_fuzzy_duplicate(previous.text, candidate.text):
                        # FIX: exact matching found nothing, but the two
                        # segments are highly similar reworded text at a
                        # genuine chunk boundary (start_time overlap) -
                        # this is the same overlapping audio transcribed
                        # twice with slightly different wording. Drop the
                        # duplicate candidate rather than appending it
                        # again.
                        candidate.text = ""
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