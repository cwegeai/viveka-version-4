from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import TYPE_CHECKING, Any, Optional

import httpx

if TYPE_CHECKING:
    from .activity_repository import TranscriptionMetrics

logger = logging.getLogger(__name__)

from .config import Settings
from .gemini_rate_limiter import get_gemini_rate_limiter
from .merge_engine import format_timestamp
from .models import (
    FinalResult,
    MergedTranscript,
    TranscriptTurn,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _contains_non_ascii_letters(text: str) -> bool:
    return any(ord(char) > 127 and char.isalpha() for char in (text or ""))


# Unicode block ranges for the Indic scripts this pipeline sees. Used to
# detect "Gemini just echoed the source script back" — the actual failure
# mode to reject — as distinct from "the output contains non-ASCII
# characters," which is also true of correct Latin transliteration (IAST
# diacritics like ā, ī, ū, ṃ, ḥ, ś, ṣ, ṇ all have ord() > 127 and are
# alphabetic). The old check rejected legitimate diacritic-bearing
# transliteration output as if it were untransliterated, silently falling
# back to the original-script placeholder — which read to users as
# "transliteration/translation didn't happen."
_INDIC_SCRIPT_RANGES: tuple[tuple[int, int], ...] = (
    (0x0900, 0x097F),  # Devanagari
    (0x0980, 0x09FF),  # Bengali
    (0x0A00, 0x0A7F),  # Gurmukhi
    (0x0A80, 0x0AFF),  # Gujarati
    (0x0B00, 0x0B7F),  # Oriya
    (0x0B80, 0x0BFF),  # Tamil
    (0x0C00, 0x0C7F),  # Telugu
    (0x0C80, 0x0CFF),  # Kannada
    (0x0D00, 0x0D7F),  # Malayalam
)


def _contains_indic_script(text: str) -> bool:
    return any(
        lo <= ord(char) <= hi
        for char in (text or "")
        for lo, hi in _INDIC_SCRIPT_RANGES
    )


_CHARS_PER_TOKEN = 4  # rough approximation for token cost estimation

def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN)


def _detect_script(text: str) -> str:
    """Return a human-readable script name for the dominant non-ASCII script."""
    if not text:
        return ""
    if re.search(r"[\u0D00-\u0D7F]", text): return "Malayalam"
    if re.search(r"[\u0900-\u097F]", text): return "Devanagari"
    if re.search(r"[\u0B80-\u0BFF]", text): return "Tamil"
    if re.search(r"[\u0C00-\u0C7F]", text): return "Telugu"
    if re.search(r"[\u0B00-\u0B7F]", text): return "Oriya"
    if re.search(r"[\u0980-\u09FF]", text): return "Bengali"
    if re.search(r"[\u0A00-\u0A7F]", text): return "Gurmukhi"
    if re.search(r"[\u0A80-\u0AFF]", text): return "Gujarati"
    if re.search(r"[\u0C80-\u0CFF]", text): return "Kannada"
    return ""


def _looks_untranslated(original: str, translated: str) -> bool:
    o = (original or "").strip()
    t = (translated or "").strip()
    if not o:
        return False
    if not t:
        return True
    return o == t


def _looks_summarized(original: str, translated: str) -> bool:
    """Heuristic: flag translations that are suspiciously short relative to
    the source. Long turns crammed into large batches sometimes cause Gemini
    to condense/summarize rather than translate verbatim, which reads to
    users as "the translation got cut off / summarized" instead of a full
    translation. Anything this flags is discarded — the turn is left as-is
    rather than accepting a condensed stand-in for a full translation."""
    o = (original or "").strip()
    t = (translated or "").strip()
    if len(o) < 40 or not t:
        return False
    o_words = len(o.split())
    t_words = len(t.split())
    return t_words < max(3, o_words * 0.35)


def _needs_translation(turn: TranscriptTurn) -> bool:
    """True if the turn still needs transliteration or translation."""
    original = (turn.original or "").strip()
    if not original or not _contains_non_ascii_letters(original):
        return False
    translated = (turn.translated or "").strip()
    transliterated = (turn.transliterated or "").strip()
    # Needs work if translation missing/same as original, or transliteration missing/same
    if not translated or translated == original or _contains_indic_script(translated):
        return True
    if not transliterated or transliterated == original:
        return True
    return False


def _fallback_summary(turns: list[TranscriptTurn]) -> str:
    snippets = []
    for turn in turns[:3]:
        t = (turn.translated or turn.original or "").strip()
        if t:
            snippets.append(t)
    return " ".join(snippets) if snippets else "Interview transcript generated."


def _extract_json_object(raw_text: str) -> dict[str, Any] | None:
    raw_text = raw_text.strip()
    if not raw_text:
        return None
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            return json.loads(raw_text[start: end + 1])
        except json.JSONDecodeError:
            return None


def _ensure_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value in (None, ""):
        return []
    return [value]


def _extract_turns_payload(parsed: Any) -> list[Any]:
    """Pull the turns list out of a parsed Gemini response.

    The prompt asks for {"turns": [...]}, but the model sometimes returns the
    bare array instead of wrapping it in an object — parsed is then a list,
    not a dict, and parsed.get(...) would raise AttributeError. Accept both
    shapes so one batch's formatting choice doesn't blow up the whole pass."""
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        return _ensure_list(parsed.get("turns"))
    return []


class GeminiBlockedError(Exception):
    """Raised when Gemini returns a blocked/cutoff finishReason (MAX_TOKENS,
    RECITATION, SAFETY, OTHER). Distinct from a plain None return (network
    error, rate limit exhausted after retries): a block is often caused by
    one specific turn's content or a batch being too large, and splitting
    the batch into smaller pieces and retrying those individually can
    isolate and recover the rest — whereas retrying identically, or
    splitting after a plain rate-limit exhaustion, wouldn't help and would
    only spend more of the request budget."""

    def __init__(self, finish_reason: str):
        self.finish_reason = finish_reason
        super().__init__(f"Gemini blocked: finishReason={finish_reason}")


class GeminiArtifactService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.metrics: Optional[TranscriptionMetrics] = None
        self.total_gemini_seconds: float = 0.0

    # ------------------------------------------------------------------
    # Gemini HTTP helper
    # ------------------------------------------------------------------

    async def _request_json(
        self,
        prompt: str,
        *,
        timeout: float = 60.0,
        label: str = "Gemini request",
    ) -> dict[str, Any] | None:
        """Call Gemini and return parsed JSON.

        Only tries the configured model (default: gemini-2.5-flash). There is
        no non-Gemini fallback anywhere upstream of this — translation and
        transliteration are Gemini-only — so transient failures (429/5xx,
        timeouts) get a generous retry budget with backoff rather than
        giving up quickly. A blocked/cut-off response (MAX_TOKENS,
        RECITATION, SAFETY, OTHER) raises GeminiBlockedError instead of
        returning None, so the caller can distinguish "worth splitting the
        batch and retrying the pieces" from "exhausted retries, nothing more
        to try." Returns None only when transient retries are exhausted.
        """
        model = self.settings.gemini_model  # e.g. "gemini-2.5-flash"
        url = (
            f"{self.settings.gemini_base_url}/models/{model}:generateContent"
            f"?key={self.settings.gemini_api_key}"
        )
        # Progressive waits for 429/5xx/network errors. No fallback exists
        # upstream anymore, so this affords more patience than a quick give-up.
        retry_waits = [5, 10, 20, 30, 45, 60]
        max_attempts = len(retry_waits)
        limiter = get_gemini_rate_limiter(
            self.settings.gemini_max_concurrent_calls,
            self.settings.gemini_min_call_interval_seconds,
        )

        for attempt in range(max_attempts):
            call_started = time.monotonic()
            try:
                async with limiter:
                    logger.info(f"[{label}] {model} calling Gemini (attempt {attempt + 1}/{max_attempts})...")
                    async with httpx.AsyncClient(timeout=timeout) as client:
                        response = await client.post(
                            url,
                            headers={"Content-Type": "application/json"},
                            json={
                                "contents": [{"parts": [{"text": prompt}]}],
                                "generationConfig": {
                                    "temperature": 0.1,
                                    "responseMimeType": "application/json",
                                    "maxOutputTokens": 65536,
                                    # gemini-2.5-flash spends output-token
                                    # budget on internal "thinking" by default,
                                    # ahead of the actual JSON. That's wasted
                                    # cost/latency for a mechanical translate
                                    # batch and can itself trigger MAX_TOKENS
                                    # cutoffs — disable it.
                                    "thinkingConfig": {"thinkingBudget": 0},
                                },
                            },
                        )
                self.total_gemini_seconds += time.monotonic() - call_started

                if response.status_code in {429, 500, 502, 503, 504}:
                    wait = retry_waits[attempt]
                    logger.warning(
                        f"[{label}] {model} HTTP {response.status_code} "
                        f"(attempt {attempt + 1}/{max_attempts}) — waiting {wait}s"
                    )
                    if attempt < max_attempts - 1:
                        await asyncio.sleep(wait)
                        continue
                    logger.error(f"[{label}] {model} HTTP {response.status_code} after {max_attempts} attempts — giving up")
                    return None

                response.raise_for_status()
                payload = response.json()

                candidates_list = payload.get("candidates") or []
                if not candidates_list:
                    block = payload.get("promptFeedback", {}).get("blockReason", "")
                    logger.warning(f"[{label}] {model} no candidates. blockReason={block}")
                    raise GeminiBlockedError(block or "NO_CANDIDATES")

                candidate = candidates_list[0]
                finish = candidate.get("finishReason", "STOP")
                if finish in {"MAX_TOKENS", "RECITATION", "SAFETY", "OTHER"}:
                    logger.warning(f"[{label}] {model} response blocked/cut off: finishReason={finish}")
                    raise GeminiBlockedError(finish)

                parts_list = candidate.get("content", {}).get("parts", [])
                raw = parts_list[0].get("text", "") if parts_list else ""
                parsed = _extract_json_object(raw)
                if parsed:
                    logger.info(
                        f"[{label}] {model} OK in {time.monotonic() - call_started:.1f}s "
                        f"(attempt {attempt + 1}/{max_attempts})"
                    )
                    # Track token usage for admin metrics
                    if self.metrics is not None:
                        usage = payload.get("usageMetadata", {})

                        self.metrics.gemini_input_tokens += usage.get("promptTokenCount", 0)

                        self.metrics.gemini_output_tokens += (
                            usage.get("candidatesTokenCount", 0)
                            + usage.get("thoughtsTokenCount", 0)
                        )
                    return parsed
                logger.warning(f"[{label}] {model} bad/empty JSON: {raw[:120]}")
                return None

            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                self.total_gemini_seconds += time.monotonic() - call_started
                wait = retry_waits[attempt]
                logger.warning(f"[{label}] {model} network/timeout (attempt {attempt + 1}/{max_attempts}): {exc}")
                if attempt < max_attempts - 1:
                    await asyncio.sleep(wait)
                    continue
                logger.error(f"[{label}] {model} network/timeout after {max_attempts} attempts — giving up")
                return None

        return None

    # ------------------------------------------------------------------
    # Transliteration + translation — the core fix
    # ------------------------------------------------------------------

    async def _translate_all_turns(self, turns: list[TranscriptTurn]) -> list[TranscriptTurn]:
        """
        Translate and transliterate ALL turns that need it — Gemini only.

        Strategy:
        1. Try Gemini in batches (capped by turn count and character volume).
        2. If a batch comes back blocked/cut off (MAX_TOKENS, RECITATION,
           SAFETY, OTHER), split it in half and retry the pieces — this is
           usually one turn's content or a batch being too large, and
           isolating it lets the rest of the batch still succeed. Recurses
           down to single turns if needed.
        3. Anything that still doesn't come back from Gemini after that is
           left as-is (original text in both fields) rather than being
           padded out with a non-Gemini substitute — no other translation or
           transliteration source is used anywhere in this pipeline.
        """
        if not any(_needs_translation(t) for t in turns):
            return turns

        # Batch turns for Gemini, capped by both count and total character
        # volume. A fixed turn-count cap alone isn't enough — files with long
        # monologue-style turns can still blow past the model's comfortable
        # output budget in one call, which pushes it toward truncating or
        # silently condensing (summarizing) turns instead of translating them
        # verbatim. Splitting on characters too keeps each call's expected
        # output small enough to come back complete.
        BATCH_TURNS = 20
        BATCH_CHARS = 6000
        pending_indices = [i for i, t in enumerate(turns) if _needs_translation(t)]

        def _make_batches(indices: list[int]) -> list[list[int]]:
            batches: list[list[int]] = []
            current: list[int] = []
            current_chars = 0
            for idx in indices:
                turn_chars = len(turns[idx].original or "")
                if current and (
                    len(current) >= BATCH_TURNS or current_chars + turn_chars > BATCH_CHARS
                ):
                    batches.append(current)
                    current = []
                    current_chars = 0
                current.append(idx)
                current_chars += turn_chars
            if current:
                batches.append(current)
            return batches

        # Gemini pass — batches run concurrently (bounded + spaced by the
        # shared rate limiter inside _request_json), so a large file's many
        # batches don't run fully serially, and don't burst past quota either.
        gemini_results: dict[str, dict[str, str]] = {}  # mu_id → {transliterated, translated}
        batches = _make_batches(pending_indices)
        total_batches = len(batches)
        phase_started = time.monotonic()
        logger.info(
            f"Translation: {len(pending_indices)} turn(s) needing work across "
            f"{total_batches} batch(es), up to {self.settings.gemini_max_concurrent_calls} "
            f"concurrent Gemini call(s)"
        )

        def _build_prompt(batch: list[TranscriptTurn]) -> str:
            lean = [
                {"id": t.mu_id, "spk": t.speaker, "orig": t.original}
                for t in batch
            ]
            return (
                "You are a translation and transliteration engine. "
                "Return ONLY valid JSON: {\"turns\": [{\"id\": <mu_id>, "
                "\"transliterated\": <Latin script>, \"translated\": <English>}, ...]}. "
                "For every input turn: set transliterated to Latin-script romanisation of orig. "
                "Set translated to fluent English. "
                "translated must be a full, verbatim, line-by-line translation of orig — "
                "never summarize, condense, paraphrase away detail, or shorten it. "
                "It should read as a complete translation of the same length and detail as orig, "
                "not a synopsis. "
                "If orig is already English/Latin, transliterated = orig and translated = orig. "
                "Process ALL turns. No preamble.\n\n"
                f"TURNS: {json.dumps(lean, ensure_ascii=False)}"
            )

        async def _translate_batch(label: str, batch_idx: list[int]) -> None:
            batch = [turns[i] for i in batch_idx]
            prompt = _build_prompt(batch)
            try:
                parsed = await self._request_json(prompt, timeout=45.0, label=label)
                if parsed:
                    items = _extract_turns_payload(parsed)
                    matched_ids: set[str] = set()
                    for item in items:
                        if isinstance(item, dict) and item.get("id"):
                            item_id = str(item["id"]).strip()
                            gemini_results[item_id] = {
                                "transliterated": str(item.get("transliterated") or "").strip(),
                                "translated": str(item.get("translated") or "").strip(),
                            }
                            matched_ids.add(item_id)
                    # If ids didn't line up (Gemini renamed/dropped them) but the
                    # item count matches the batch, fall back to positional
                    # matching rather than losing the whole batch's work.
                    unmatched = [t for t in batch if t.mu_id not in matched_ids]
                    if unmatched and len(items) == len(batch):
                        logger.warning(
                            f"[{label}] {len(unmatched)}/{len(batch)} turn id(s) didn't "
                            f"match Gemini's response ids — matching positionally instead"
                        )
                        for turn_obj, item in zip(batch, items):
                            if isinstance(item, dict) and turn_obj.mu_id not in gemini_results:
                                gemini_results[turn_obj.mu_id] = {
                                    "transliterated": str(item.get("transliterated") or "").strip(),
                                    "translated": str(item.get("translated") or "").strip(),
                                }
                    elif unmatched:
                        logger.warning(
                            f"[{label}] {len(unmatched)}/{len(batch)} turn(s) missing from "
                            f"Gemini's response (got {len(items)} item(s) for {len(batch)} "
                            f"turn(s)) — left as original text"
                        )
            except GeminiBlockedError as e:
                if len(batch_idx) > 1:
                    mid = len(batch_idx) // 2
                    logger.warning(
                        f"[{label}] blocked ({e.finish_reason}) — splitting "
                        f"{len(batch_idx)} turns and retrying the halves"
                    )
                    await asyncio.gather(
                        _translate_batch(f"{label}.a", batch_idx[:mid]),
                        _translate_batch(f"{label}.b", batch_idx[mid:]),
                    )
                else:
                    logger.warning(
                        f"[{label}] turn {turns[batch_idx[0]].mu_id} blocked "
                        f"({e.finish_reason}) even alone — leaving as original text"
                    )
            except Exception as e:
                logger.error(f"[{label}] translate failed: {e}", exc_info=True)

        await asyncio.gather(
            *(
                _translate_batch(f"batch-translate {i + 1}/{total_batches}", batch_idx)
                for i, batch_idx in enumerate(batches)
            )
        )
        logger.info(
            f"Translation: all {total_batches} batch(es) finished in "
            f"{time.monotonic() - phase_started:.1f}s wall time "
            f"({self.total_gemini_seconds:.1f}s cumulative Gemini call time)"
        )

        # Apply Gemini results. Gemini-only, by design: anything it didn't
        # come back with is left exactly as it was (original text in both
        # fields) rather than being patched from a different, lesser source —
        # that's what was silently duplicating translation into
        # transliteration before.
        result_turns: list[TranscriptTurn] = []
        for turn in turns:
            if not _needs_translation(turn):
                result_turns.append(turn)
                continue

            gemini = gemini_results.get(turn.mu_id, {})
            g_translit = gemini.get("transliterated", "").strip()
            g_translated = gemini.get("translated", "").strip()

            # ── Translation ──────────────────────────────────────────
            # Reject only if Gemini echoed the source script back untouched —
            # not merely "contains non-ASCII," which is also true of correct
            # transliteration/translation output (diacritics, accented
            # proper nouns).
            if (
                g_translated
                and not _contains_indic_script(g_translated)
                and g_translated != turn.original
                and not _looks_summarized(turn.original, g_translated)
            ):
                translated = g_translated
            else:
                translated = turn.translated

            # ── Transliteration ──────────────────────────────────────
            # Gemini's output only — never derived from the translation.
            # Correct Latin transliteration of Indic scripts (IAST-style)
            # legitimately contains diacritics (ā, ī, ū, ṃ, ḥ, ś, ṣ, ṇ, ...),
            # which are non-ASCII but not the source script — only reject if
            # the source script itself is still present.
            if g_translit and not _contains_indic_script(g_translit) and g_translit != translated:
                transliterated = g_translit
            else:
                transliterated = turn.transliterated

            # Never let translated leak into transliterated (or vice versa) —
            # that substitution is exactly the bug being fixed here.
            result_turns.append(turn.model_copy(update={
                "transliterated": transliterated,
                "translated": translated,
            }))

        gemini_hit = len(gemini_results)
        total_pending = len(pending_indices)
        if gemini_hit < total_pending:
            logger.info(
                f"Translation: Gemini covered {gemini_hit}/{total_pending} turns. "
                f"{total_pending - gemini_hit} left as original text (no non-Gemini fallback)."
            )
        return result_turns

    # ------------------------------------------------------------------
    # Summary generation (Gemini, no executive synthesis)
    # ------------------------------------------------------------------

    async def _generate_summary(self, merged: MergedTranscript, turns: list[TranscriptTurn]) -> tuple[str, list[str]]:
        """Generate interview summary and key points. Returns (summary, keyPoints)."""
        fallback = _fallback_summary(turns)
        if not self.settings.gemini_api_key or not merged.transcript.strip():
            return fallback, []

        sample_turns = turns[:20]
        prompt = (
            "You are a qualitative research analyst. "
            "Return ONLY valid JSON: {\"summary\": \"<2-4 sentence English summary>\", "
            "\"keyPoints\": [\"<finding 1>\", ...]}. "
            "keyPoints: 3-5 concise English strings. No preamble.\n\n"
            f"TRANSCRIPT: {merged.transcript[:1500]}\n"
            f"TURNS: {json.dumps([{'spk': t.speaker, 'text': t.translated or t.original} for t in sample_turns], ensure_ascii=False)}"
        )
        try:
            parsed = await self._request_json(prompt, timeout=40.0, label="summary")
            if parsed:
                summary = str(parsed.get("summary") or "").strip() or fallback
                kp = [str(k).strip() for k in _ensure_list(parsed.get("keyPoints")) if str(k).strip()]
                return summary, kp
        except Exception as e:
            logger.error(f"Summary generation failed: {e}", exc_info=True)
        return fallback, []

    # ------------------------------------------------------------------
    # Default result builder
    # ------------------------------------------------------------------

    def build_default_result(self, merged: MergedTranscript) -> FinalResult:
        base_turns = [
            TranscriptTurn(
                speaker=segment.speaker,
                original=segment.text,
                transliterated=segment.text,
                translated=segment.text,
                mu_id=f"MU-{index + 1:03d}",
                timestamp=format_timestamp(segment.start_time),
                start_time_seconds=segment.start_time,
                end_time_seconds=segment.end_time,
                duration_seconds=max(0.0, segment.end_time - segment.start_time),
                confidence=segment.confidence,
                language=segment.language,
                languages=segment.languages,
                words=segment.words,
                language_metadata=segment.language_metadata,
            )
            for index, segment in enumerate(merged.speakers)
        ]
        return FinalResult(
            turns=base_turns,
            executiveSynthesis=[],
            summary=_fallback_summary(base_turns),
            keyPoints=[],
            detected_language=merged.detected_language or merged.language,
            languages=merged.languages,
            language_metadata=merged.language_metadata,
            chunk_results=merged.chunk_results,
        )

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def generate(self, merged: MergedTranscript) -> FinalResult:
        result = self.build_default_result(merged)
        phase_started = time.monotonic()
        logger.info(f"Gemini artifact generation starting for {len(result.turns)} turn(s)...")

        # 1. Translate + transliterate ALL turns
        try:
            result.turns = await self._translate_all_turns(result.turns)
        except Exception as e:
            logger.error(f"Translation pass failed: {e}", exc_info=True)

        # 2. Generate summary
        try:
            summary, key_points = await self._generate_summary(merged, result.turns)
            result.summary = summary
            result.keyPoints = key_points
        except Exception as e:
            logger.error(f"Summary failed: {e}", exc_info=True)

        result.detected_language = merged.detected_language or merged.language
        result.languages = merged.languages
        result.language_metadata = merged.language_metadata
        result.chunk_results = merged.chunk_results
        result.gemini_processing_seconds = round(self.total_gemini_seconds, 1)
        logger.info(
            f"Gemini artifact generation done in {time.monotonic() - phase_started:.1f}s wall time "
            f"({self.total_gemini_seconds:.1f}s cumulative Gemini call time)"
        )

        # 3. Populate metrics from result
        if self.metrics is not None:
            self.metrics.detected_language = result.detected_language or ""
            scripts: set[str] = set()
            for t in result.turns:
                s = _detect_script(t.original)
                if s:
                    scripts.add(s)
            self.metrics.script_used = ", ".join(sorted(scripts)) if scripts else ""
            self.metrics.num_transcript_turns = len(result.turns)
            translated_turns = [t for t in result.turns if t.translated and t.translated != t.original]
            translit_turns   = [t for t in result.turns if t.transliterated and t.transliterated != t.original]
            self.metrics.translation_generated     = len(translated_turns) > 0
            self.metrics.transliteration_generated = len(translit_turns) > 0
            self.metrics.executive_summary_generated = bool(result.summary)
            self.metrics.num_speakers = len({t.speaker for t in result.turns})

        return result

    # Keep backward-compat alias used by pipeline.py
    async def build_transcript_ready_result(
        self, merged: MergedTranscript, *, include_summary: bool = False
    ) -> FinalResult:
        return await self.generate(merged)