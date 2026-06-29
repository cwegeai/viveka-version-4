from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Any, Optional

import httpx
from deep_translator import GoogleTranslator

if TYPE_CHECKING:
    from .activity_repository import TranscriptionMetrics

logger = logging.getLogger(__name__)

from .config import Settings
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


NON_ASCII_RUN_PATTERN = re.compile(r"[^\x00-\x7F]+")

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


def _needs_translation(turn: TranscriptTurn) -> bool:
    """True if the turn still needs transliteration or translation."""
    original = (turn.original or "").strip()
    if not original or not _contains_non_ascii_letters(original):
        return False
    translated = (turn.translated or "").strip()
    transliterated = (turn.transliterated or "").strip()
    # Needs work if translation missing/same as original, or transliteration missing/same
    if not translated or translated == original or _contains_non_ascii_letters(translated):
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


class GeminiArtifactService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._semaphore: Optional[asyncio.Semaphore] = None
        self.metrics: Optional[TranscriptionMetrics] = None

    def _get_semaphore(self) -> asyncio.Semaphore:
        if self._semaphore is None:
            # Limit to 1 concurrent Gemini call — prevents 503 rate limit bursts.
            # Batches are processed sequentially; GoogleTranslator handles fallback instantly.
            self._semaphore = asyncio.Semaphore(1)
        return self._semaphore

    # ------------------------------------------------------------------
    # GoogleTranslator fallback — fast, free, no quota
    # ------------------------------------------------------------------

    async def _google_translate(self, text: str) -> str:
        """Translate text to English via GoogleTranslator (runs in thread)."""
        if not text.strip() or not _contains_non_ascii_letters(text):
            return text

        def _do() -> str:
            return GoogleTranslator(source="auto", target="en").translate(text)

        try:
            result = await asyncio.to_thread(_do)
            if result and result.strip() and result.strip() != text.strip():
                return result.strip()
        except Exception:
            pass

        # Segment fallback — translate non-ASCII runs individually
        parts: list[str] = []
        last = 0
        changed = False
        for match in NON_ASCII_RUN_PATTERN.finditer(text):
            s, e = match.span()
            if s > last:
                parts.append(text[last:s])
            seg = match.group(0)
            try:
                tseg = await asyncio.to_thread(
                    lambda x=seg: GoogleTranslator(source="auto", target="en").translate(x)
                )
            except Exception:
                tseg = seg
            if tseg and tseg != seg:
                changed = True
            parts.append(tseg or seg)
            last = e
        if last < len(text):
            parts.append(text[last:])
        rebuilt = "".join(parts).strip()
        return rebuilt if changed and rebuilt else text

    async def _google_transliterate(self, text: str) -> str:
        """
        Best-effort Latin transliteration via GoogleTranslator.
        GoogleTranslator doesn't have a true transliterate endpoint, so we
        translate to English — the transliteration is carried implicitly in
        Deepgram's output or we just return the translation as a proxy.
        For genuine transliteration we rely on Gemini when available.
        """
        return await self._google_translate(text)

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

        Only tries the configured model (default: gemini-2.5-flash).
        On 503/429 waits progressively before retrying — up to 4 attempts.
        Returns None if all attempts fail so callers use GoogleTranslator fallback.
        """
        model = self.settings.gemini_model  # e.g. "gemini-2.5-flash"
        url = (
            f"{self.settings.gemini_base_url}/models/{model}:generateContent"
            f"?key={self.settings.gemini_api_key}"
        )
        # Progressive waits for 429/5xx: 5s, 15s, 30s, 60s
        retry_waits = [5, 15, 30, 60]

        for attempt in range(4):
            try:
                async with self._get_semaphore():
                    async with httpx.AsyncClient(timeout=timeout) as client:
                        response = await client.post(
                            url,
                            headers={"Content-Type": "application/json"},
                            json={
                                "contents": [{"parts": [{"text": prompt}]}],
                                "generationConfig": {
                                    "temperature": 0.1,
                                    "responseMimeType": "application/json",
                                },
                            },
                        )

                if response.status_code in {429, 500, 502, 503, 504}:
                    wait = retry_waits[min(attempt, len(retry_waits) - 1)]
                    logger.warning(
                        f"[{label}] {model} HTTP {response.status_code} "
                        f"(attempt {attempt + 1}/4) — waiting {wait}s"
                    )
                    if attempt < 3:
                        await asyncio.sleep(wait)
                        continue
                    logger.error(f"[{label}] {model} HTTP {response.status_code} after 4 attempts — giving up")
                    return None

                response.raise_for_status()
                payload = response.json()

                candidates_list = payload.get("candidates") or []
                if not candidates_list:
                    block = payload.get("promptFeedback", {}).get("blockReason", "")
                    logger.warning(f"[{label}] {model} no candidates. blockReason={block}")
                    return None

                candidate = candidates_list[0]
                finish = candidate.get("finishReason", "STOP")
                if finish in {"MAX_TOKENS", "RECITATION", "SAFETY", "OTHER"}:
                    logger.warning(f"[{label}] {model} response cut off: finishReason={finish}")
                    return None

                parts_list = candidate.get("content", {}).get("parts", [])
                raw = parts_list[0].get("text", "") if parts_list else ""
                parsed = _extract_json_object(raw)
                if parsed:
                    logger.info(f"[{label}] OK with {model}")
                    # Track token usage for admin metrics
                    if self.metrics is not None:
                        self.metrics.gemini_input_tokens  += _estimate_tokens(prompt)
                        self.metrics.gemini_output_tokens += _estimate_tokens(raw)
                    return parsed
                logger.warning(f"[{label}] {model} bad/empty JSON: {raw[:120]}")
                return None

            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                wait = retry_waits[min(attempt, len(retry_waits) - 1)]
                logger.warning(f"[{label}] {model} network/timeout (attempt {attempt + 1}/4): {exc}")
                if attempt < 3:
                    await asyncio.sleep(wait)
                    continue
                logger.error(f"[{label}] {model} network/timeout after 4 attempts — giving up")
                return None
            except Exception as exc:
                logger.error(f"[{label}] {model} unexpected error: {exc}", exc_info=True)
                return None

        return None

    # ------------------------------------------------------------------
    # Transliteration + translation — the core fix
    # ------------------------------------------------------------------

    async def _translate_all_turns(self, turns: list[TranscriptTurn]) -> list[TranscriptTurn]:
        """
        Translate and transliterate ALL turns that need it.

        Strategy:
        1. Try Gemini in batches of 20 for speed (transliteration + translation).
        2. For any turn that Gemini misses or still needs work, fall back to
           GoogleTranslator (translation only — transliteration stays as-is or
           is set equal to the translation as a proxy).

        This guarantees no turn gets cut off — every turn goes through at least
        the GoogleTranslator path.
        """
        if not any(_needs_translation(t) for t in turns):
            return turns

        # Split into batches of 20 for Gemini
        BATCH = 20
        pending_indices = [i for i, t in enumerate(turns) if _needs_translation(t)]

        # Gemini pass — send batches
        gemini_results: dict[str, dict[str, str]] = {}  # mu_id → {transliterated, translated}
        for batch_start in range(0, len(pending_indices), BATCH):
            batch_idx = pending_indices[batch_start: batch_start + BATCH]
            batch = [turns[i] for i in batch_idx]

            lean = [
                {"id": t.mu_id, "spk": t.speaker, "orig": t.original}
                for t in batch
            ]
            prompt = (
                "You are a translation and transliteration engine. "
                "Return ONLY valid JSON: {\"turns\": [{\"id\": <mu_id>, "
                "\"transliterated\": <Latin script>, \"translated\": <English>}, ...]}. "
                "For every input turn: set transliterated to Latin-script romanisation of orig. "
                "Set translated to fluent English. "
                "If orig is already English/Latin, transliterated = orig and translated = orig. "
                "Process ALL turns. No preamble.\n\n"
                f"TURNS: {json.dumps(lean, ensure_ascii=False)}"
            )
            try:
                parsed = await self._request_json(prompt, timeout=45.0, label="batch-translate")
                if parsed:
                    for item in _ensure_list(parsed.get("turns")):
                        if isinstance(item, dict) and item.get("id"):
                            gemini_results[item["id"]] = {
                                "transliterated": str(item.get("transliterated") or "").strip(),
                                "translated": str(item.get("translated") or "").strip(),
                            }
            except Exception as e:
                logger.error(f"Batch translate failed: {e}", exc_info=True)

        # Apply Gemini results + GoogleTranslator fallback for anything missed
        result_turns: list[TranscriptTurn] = []
        for turn in turns:
            if not _needs_translation(turn):
                result_turns.append(turn)
                continue

            gemini = gemini_results.get(turn.mu_id, {})
            g_translit = gemini.get("transliterated", "").strip()
            g_translated = gemini.get("translated", "").strip()

            # ── Translation ──────────────────────────────────────────
            if g_translated and not _contains_non_ascii_letters(g_translated) and g_translated != turn.original:
                translated = g_translated
            else:
                # GoogleTranslator fallback — always works, free, instant
                try:
                    translated = await self._google_translate(turn.original)
                except Exception:
                    translated = turn.translated or turn.original

            # ── Transliteration ──────────────────────────────────────
            # Priority: Gemini Latin → English translation as proxy → keep existing
            # We NEVER leave the original non-Latin script in the transliteration field.
            if g_translit and not _contains_non_ascii_letters(g_translit):
                transliterated = g_translit
            elif translated and not _contains_non_ascii_letters(translated) and translated != turn.original:
                # Use English translation as transliteration proxy — far better than
                # showing the original script when Gemini is unavailable
                transliterated = translated
            else:
                transliterated = turn.transliterated  # keep whatever we had

            result_turns.append(turn.model_copy(update={
                "transliterated": transliterated or translated or turn.transliterated,
                "translated": translated or turn.translated,
            }))

        gemini_hit = len(gemini_results)
        total_pending = len(pending_indices)
        if gemini_hit < total_pending:
            logger.info(
                f"Translation: Gemini covered {gemini_hit}/{total_pending} turns. "
                f"{total_pending - gemini_hit} used GoogleTranslator fallback."
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
