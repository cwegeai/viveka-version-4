from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

import httpx
from deep_translator import GoogleTranslator

logger = logging.getLogger(__name__)

from .config import Settings
from .merge_engine import format_timestamp
from .models import (
    ChunkSummary,
    ChunkTranscript,
    ContextMatrixRow,
    EvidenceMatrixRow,
    FinalResult,
    HotspotItem,
    MechanismChain,
    MergedTranscript,
    SmartStrategy,
    TranscriptTurn,
)


# ---------------------------------------------------------------------------
# Gemini finish-reason / error constants that mean "content cut off"
# ---------------------------------------------------------------------------
_TRUNCATED_FINISH_REASONS = {"MAX_TOKENS", "RECITATION", "SAFETY", "OTHER"}


def _contains_non_ascii_letters(text: str) -> bool:
    return any(ord(char) > 127 and char.isalpha() for char in (text or ""))


NON_ASCII_RUN_PATTERN = re.compile(r"[^\x00-\x7F]+")


def _looks_untranslated(original: str, translated: str) -> bool:
    normalized_original = (original or "").strip()
    normalized_translated = (translated or "").strip()
    if not normalized_original:
        return False
    if not normalized_translated:
        return True
    return normalized_original == normalized_translated


def _summary_source_text(turn: TranscriptTurn) -> str:
    translated = (turn.translated or "").strip()
    original = (turn.original or "").strip()
    if translated and translated != original:
        return translated
    return original


def _fallback_interview_summary(turns: list[TranscriptTurn]) -> str:
    snippets = [_summary_source_text(turn).strip() for turn in turns[:3] if _summary_source_text(turn).strip()]
    if snippets:
        return " ".join(snippets)
    return "Interview transcript generated."


def _fallback_key_points(turns: list[TranscriptTurn]) -> list[str]:
    points: list[str] = []
    for turn in turns[:3]:
        text = _summary_source_text(turn).strip()
        if text and text not in points:
            points.append(text)
    return points


def _needs_turn_translation(turn: TranscriptTurn) -> bool:
    original = (turn.original or "").strip()
    translated = (turn.translated or "").strip()
    transliterated = (turn.transliterated or "").strip()

    if not original or not _contains_non_ascii_letters(original):
        return False

    if not translated or translated == original or _contains_non_ascii_letters(translated):
        return True

    if not transliterated or transliterated == original:
        return True

    return False


def _merge_turn_repairs(source_turns: list[TranscriptTurn], repaired_turns: list[TranscriptTurn]) -> list[TranscriptTurn]:
    repairs_by_id = {turn.mu_id: turn for turn in repaired_turns if turn.mu_id}
    merged_turns: list[TranscriptTurn] = []

    for index, source_turn in enumerate(source_turns):
        repaired_turn = repairs_by_id.get(source_turn.mu_id)
        if repaired_turn is None and index < len(repaired_turns):
            repaired_turn = repaired_turns[index]

        if repaired_turn is None:
            merged_turns.append(source_turn)
            continue

        merged_turns.append(
            source_turn.model_copy(
                update={
                    "transliterated": repaired_turn.transliterated or source_turn.transliterated,
                    "translated": repaired_turn.translated or source_turn.translated,
                    "language": repaired_turn.language or source_turn.language,
                    "languages": repaired_turn.languages or source_turn.languages,
                }
            )
        )

    return merged_turns


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
            return json.loads(raw_text[start : end + 1])
        except json.JSONDecodeError:
            return None


def _ensure_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value in (None, ""):
        return []
    return [value]


def _coerce_object_list(value: Any, mapper: Any) -> list[dict[str, Any]]:
    items = _ensure_list(value)
    normalized_items: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, dict):
            normalized_items.append(item)
        elif isinstance(item, str) and item.strip():
            normalized_items.append(mapper(item.strip()))
    return normalized_items


def _normalize_model_payload(parsed: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(parsed)

    executive = normalized.get("executiveSynthesis")
    if isinstance(executive, str):
        normalized["executiveSynthesis"] = [{"chunk_id": 1, "text": executive}] if executive.strip() else []
    else:
        normalized["executiveSynthesis"] = _ensure_list(executive)

    if isinstance(normalized.get("keyPoints"), str):
        key_points = normalized.get("keyPoints", "")
        normalized["keyPoints"] = [key_points] if key_points else []
    else:
        normalized["keyPoints"] = _ensure_list(normalized.get("keyPoints"))

    normalized["artifact1_evidence"] = _coerce_object_list(
        normalized.get("artifact1_evidence"),
        lambda text: {"dimension": "", "domain": "", "evidence": text, "reasoning": ""},
    )
    normalized["artifact2_context"] = _coerce_object_list(
        normalized.get("artifact2_context"),
        lambda text: {"contextLevel": "", "domain": "", "finding": text},
    )
    normalized["artifact3_chains"] = _coerce_object_list(
        normalized.get("artifact3_chains"),
        lambda text: {"chain_id": "", "pathway": text, "impacts": ""},
    )
    normalized["artifact5_hotspots"] = _coerce_object_list(
        normalized.get("artifact5_hotspots"),
        lambda text: {"vulnerable": text, "drivers": ""},
    )
    normalized["strategies"] = _coerce_object_list(
        normalized.get("strategies"),
        lambda text: {"strategy": text, "indicator": ""},
    )

    list_fields = ["turns"]
    for field_name in list_fields:
        normalized[field_name] = _ensure_list(normalized.get(field_name))

    if not isinstance(normalized.get("summary"), str):
        normalized["summary"] = str(normalized.get("summary") or "")

    return normalized


# ---------------------------------------------------------------------------
# Chunk-level executive synthesis helpers
# ---------------------------------------------------------------------------

def _build_chunk_text_map(chunk_results: list[ChunkTranscript]) -> dict[int, str]:
    """Return a mapping of chunk_id → transcript text (capped at 800 chars each)."""
    mapping: dict[int, str] = {}
    for chunk in chunk_results:
        mapping[chunk.chunk_id] = (chunk.transcript or "").strip()[:800]
    return mapping


def _turns_for_chunk(turns: list[TranscriptTurn], chunk: ChunkTranscript) -> list[TranscriptTurn]:
    """Return the subset of turns whose timestamps fall within this chunk's time window."""
    return [
        t for t in turns
        if t.start_time_seconds >= chunk.start_time and t.end_time_seconds <= chunk.end_time + 1.0
    ]


class GeminiArtifactService:
    def __init__(self, settings: Settings):
        self.settings = settings

    # ------------------------------------------------------------------
    # Internal HTTP helper
    # ------------------------------------------------------------------

    async def _fallback_translate_text(self, text: str) -> str:
        if not text.strip() or not _contains_non_ascii_letters(text):
            return text

        def _translate() -> str:
            return GoogleTranslator(source="auto", target="en").translate(text)

        try:
            translated = await asyncio.to_thread(_translate)
            if translated and translated.strip() and translated.strip() != text.strip():
                return translated.strip()
        except Exception:
            pass

        parts: list[str] = []
        last_index = 0
        changed = False
        for match in NON_ASCII_RUN_PATTERN.finditer(text):
            start, end = match.span()
            if start > last_index:
                parts.append(text[last_index:start])
            segment = match.group(0)
            try:
                translated_segment = await asyncio.to_thread(
                    lambda s=segment: GoogleTranslator(source="auto", target="en").translate(s)
                )
            except Exception:
                translated_segment = segment
            if translated_segment and translated_segment != segment:
                changed = True
            parts.append(translated_segment or segment)
            last_index = end

        if last_index < len(text):
            parts.append(text[last_index:])

        rebuilt = "".join(parts).strip()
        if changed and rebuilt:
            return rebuilt
        return text

    async def _request_json(
        self,
        prompt: str,
        *,
        timeout: float = 180.0,
        label: str = "Gemini request",
    ) -> dict[str, Any] | None:
        """
        Call Gemini generateContent and return the parsed JSON payload.

        Raises a descriptive RuntimeError if Gemini returns a non-STOP finishReason
        (MAX_TOKENS, RECITATION, SAFETY, etc.) so callers can apply graceful fallbacks
        instead of silently returning empty results.
        """
        url = (
            f"{self.settings.gemini_base_url}/models/{self.settings.gemini_model}:generateContent"
            f"?key={self.settings.gemini_api_key}"
        )

        last_error: Exception | None = None
        payload: dict[str, Any] = {}

        for attempt in range(4):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    response = await client.post(
                        url,
                        headers={"Content-Type": "application/json"},
                        json={
                            "contents": [{"parts": [{"text": prompt}]}],
                            "generationConfig": {
                                "temperature": 0.2,
                                "responseMimeType": "application/json",
                            },
                        },
                    )
                    response.raise_for_status()
                    payload = response.json()
                break
            except httpx.HTTPStatusError as exc:
                last_error = exc
                status = exc.response.status_code
                # 429 = quota, 5xx = transient — retry those
                if status not in {429, 500, 502, 503, 504} or attempt >= 3:
                    logger.error(
                        f"[{label}] Gemini HTTP {status} on attempt {attempt + 1}: {exc.response.text[:300]}"
                    )
                    raise
                wait = 2 ** attempt
                logger.warning(f"[{label}] Gemini HTTP {status}, retrying in {wait}s (attempt {attempt + 1})")
                await asyncio.sleep(wait)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                if attempt >= 3:
                    logger.error(f"[{label}] Gemini network/timeout error after {attempt + 1} attempts: {exc}")
                    raise
                wait = 2 ** attempt
                logger.warning(f"[{label}] Gemini timeout/network error, retrying in {wait}s (attempt {attempt + 1})")
                await asyncio.sleep(wait)
        else:
            if last_error:
                raise last_error
            return None

        # ---------------------------------------------------------------
        # Inspect finish reason BEFORE extracting text — this is the main
        # way to detect token-limit cancellations and safety blocks.
        # ---------------------------------------------------------------
        candidates = payload.get("candidates") or []
        if not candidates:
            # promptFeedback with blockReason means the whole request was blocked
            prompt_feedback = payload.get("promptFeedback", {})
            block_reason = prompt_feedback.get("blockReason", "")
            if block_reason:
                raise RuntimeError(
                    f"[{label}] Gemini blocked the entire prompt. blockReason={block_reason}"
                )
            logger.warning(f"[{label}] Gemini returned no candidates and no blockReason.")
            return None

        candidate = candidates[0]
        finish_reason: str = candidate.get("finishReason", "STOP")

        if finish_reason in _TRUNCATED_FINISH_REASONS:
            raise RuntimeError(
                f"[{label}] Gemini response was cut off (finishReason={finish_reason}). "
                "The prompt or response exceeded the token limit, or was blocked by a safety filter. "
                "Consider reducing the amount of transcript sent to Gemini."
            )

        parts_list = candidate.get("content", {}).get("parts", [])
        raw_text = parts_list[0].get("text", "") if parts_list else ""

        return _extract_json_object(raw_text)

    # ------------------------------------------------------------------
    # Turn translation helpers (unchanged logic, improved error messages)
    # ------------------------------------------------------------------

    async def _ensure_english_summary_content(self, result: FinalResult) -> FinalResult:
        if _contains_non_ascii_letters(result.summary):
            result.summary = await self._fallback_translate_text(result.summary)

        normalized_exec: list[ChunkSummary] = []
        for item in result.executiveSynthesis:
            text = item.text
            if _contains_non_ascii_letters(text):
                text = await self._fallback_translate_text(text)
            normalized_exec.append(ChunkSummary(chunk_id=item.chunk_id, text=text))
        result.executiveSynthesis = normalized_exec

        if not result.executiveSynthesis and result.summary:
            result.executiveSynthesis = [ChunkSummary(chunk_id=1, text=result.summary)]

        normalized_points: list[str] = []
        for point in result.keyPoints:
            if _contains_non_ascii_letters(point):
                point = await self._fallback_translate_text(point)
            point = point.strip()
            if point and point not in normalized_points:
                normalized_points.append(point)
        result.keyPoints = normalized_points

        if not result.keyPoints:
            result.keyPoints = _fallback_key_points(result.turns)

        return result

    def _build_fallback_artifacts(self, result: FinalResult) -> FinalResult:
        if not result.artifact1_evidence:
            result.artifact1_evidence = [
                EvidenceMatrixRow(
                    dimension="Interview Excerpt",
                    domain="Transcript",
                    evidence=_summary_source_text(turn),
                    reasoning="Auto-generated fallback from translated transcript turn.",
                )
                for turn in result.turns[:2]
                if _summary_source_text(turn).strip()
            ]

        if not result.artifact2_context and result.summary:
            result.artifact2_context = [
                ContextMatrixRow(
                    contextLevel="Interview Summary",
                    domain="Conversation",
                    finding=result.summary,
                )
            ]

        if not result.artifact3_chains and result.keyPoints:
            result.artifact3_chains = [
                MechanismChain(
                    chain_id="C1",
                    pathway=result.keyPoints[0],
                    impacts="Auto-generated fallback pathway from the current interview output.",
                )
            ]

        if not result.artifact5_hotspots and result.keyPoints:
            result.artifact5_hotspots = [
                HotspotItem(
                    vulnerable=result.keyPoints[0],
                    drivers="Auto-generated fallback hotspot from the current interview output.",
                )
            ]

        if not result.strategies and result.keyPoints:
            result.strategies = [
                SmartStrategy(
                    strategy="Review key interview themes",
                    indicator=result.keyPoints[0],
                )
            ]

        return result

    async def _repair_turn_translations(self, turns: list[TranscriptTurn]) -> list[TranscriptTurn]:
        if not self.settings.gemini_api_key or not any(_needs_turn_translation(turn) for turn in turns):
            return turns

        batch_size = 6
        repaired_turns = turns
        # Cap repairs to the first 40 turns — beyond that the transcript is large
        # enough that GoogleTranslator fallback is acceptable for tail turns.
        pending_turns = [turn for turn in turns[:40] if _needs_turn_translation(turn)]

        for start_index in range(0, len(pending_turns), batch_size):
            batch = pending_turns[start_index : start_index + batch_size]
            repaired_batch = await self._translate_turn_batch(batch)
            if repaired_batch:
                repaired_turns = _merge_turn_repairs(repaired_turns, repaired_batch)

        return repaired_turns

    async def _translate_turn_batch(self, batch: list[TranscriptTurn]) -> list[TranscriptTurn]:
        translation_prompt = (
            "You are an expert translation and transliteration engine. "
            "Return only JSON with a top-level key named turns. For each input turn, preserve speaker, mu_id, timestamp, "
            "and original exactly as given. Set transliterated to a Latin-script transliteration when original is not already in Latin script. "
            "Set translated to a faithful English translation for every turn. "
            "If original is already English, translated may match original. "
            "If original is not English, translated must not repeat the source-language text.\n\n"
            f"INPUT_JSON:\n{json.dumps({'turns': [turn.model_dump() for turn in batch]}, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(translation_prompt, timeout=75.0, label="turn-translation-batch")
        except RuntimeError as e:
            logger.warning(f"Turn translation batch cancelled by Gemini: {e}. Falling back to single-turn mode.")
            parsed = None
        except Exception as e:
            logger.error(f"Turn translation batch failed unexpectedly: {e}", exc_info=True)
            parsed = None

        repaired_batch: list[TranscriptTurn] = []
        if parsed:
            repaired_payload = _normalize_model_payload(parsed)
            repaired_batch = [TranscriptTurn.model_validate(item) for item in repaired_payload.get("turns", [])]

        if repaired_batch and not any(_needs_turn_translation(turn) for turn in repaired_batch):
            return repaired_batch

        if len(batch) == 1:
            strict_single = await self._translate_single_turn_strict(batch[0])
            return [strict_single]

        fallback_repairs: list[TranscriptTurn] = []
        for turn in batch:
            single_result = await self._translate_turn_batch([turn])
            fallback_repairs.extend(single_result)
        return fallback_repairs

    async def _translate_single_turn_strict(self, turn: TranscriptTurn) -> TranscriptTurn:
        strict_prompt = (
            "You are a translation and transliteration engine. Return only JSON with one top-level key named turns containing exactly one item. "
            "Preserve speaker, mu_id, timestamp, original, start_time_seconds, end_time_seconds, duration_seconds, confidence, language, and languages exactly as given. "
            "Set transliterated to Latin script. Set translated to English. "
            "Do not repeat the source-language text in translated unless the original is already English.\n\n"
            f"INPUT_JSON:\n{json.dumps({'turns': [turn.model_dump()]}, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(strict_prompt, timeout=60.0, label="single-turn-translation")
            if not parsed:
                return turn
            normalized_payload = _normalize_model_payload(parsed)
            repaired_turns = [TranscriptTurn.model_validate(item) for item in normalized_payload.get("turns", [])]
            if not repaired_turns:
                return turn
            repaired_turn = repaired_turns[0]
            if _needs_turn_translation(repaired_turn):
                fallback_translated = await self._fallback_translate_text(turn.original)
                return turn.model_copy(update={"translated": fallback_translated})
            return turn.model_copy(
                update={
                    "transliterated": repaired_turn.transliterated or turn.transliterated,
                    "translated": repaired_turn.translated or turn.translated,
                    "language": repaired_turn.language or turn.language,
                    "languages": repaired_turn.languages or turn.languages,
                }
            )
        except RuntimeError as e:
            logger.warning(f"Single-turn translation cancelled by Gemini: {e}. Using GoogleTranslator fallback.")
            fallback_translated = await self._fallback_translate_text(turn.original)
            return turn.model_copy(update={"translated": fallback_translated})
        except Exception:
            fallback_translated = await self._fallback_translate_text(turn.original)
            return turn.model_copy(update={"translated": fallback_translated})

    # ------------------------------------------------------------------
    # Executive synthesis — one ChunkSummary per audio chunk
    # ------------------------------------------------------------------

    async def _generate_chunk_executive_synthesis(
        self,
        chunk_results: list[ChunkTranscript],
        turns: list[TranscriptTurn],
        overall_summary: str,
    ) -> list[ChunkSummary]:
        """
        Generate one executive synthesis paragraph per audio chunk.
        Falls back to splitting the overall summary evenly if Gemini fails.
        """
        if not chunk_results:
            if overall_summary:
                return [ChunkSummary(chunk_id=1, text=overall_summary)]
            return []

        chunk_text_map = _build_chunk_text_map(chunk_results)

        # Build a compact input: for each chunk send up to 600 chars of transcript
        chunks_input = []
        for chunk in chunk_results:
            chunk_turns = _turns_for_chunk(turns, chunk)
            turn_texts = [_summary_source_text(t) for t in chunk_turns[:10] if _summary_source_text(t).strip()]
            chunks_input.append({
                "chunk_id": chunk.chunk_id,
                "start_time": f"{chunk.start_time:.1f}s",
                "end_time": f"{chunk.end_time:.1f}s",
                "transcript_excerpt": chunk_text_map.get(chunk.chunk_id, "")[:600],
                "turns_excerpt": turn_texts[:6],
            })

        prompt = (
            "You are AWESOME-Qual-Mapping-GPT, a social science and implementation science analyst "
            "applying the AWESOME framework (Advancing Women's Empowerment through Systems-Oriented "
            "Model Expansion) to qualitative audio transcripts.\n\n"
            "AWESOME DIMENSIONS: Health | Economic Vitality | Education & Skill Development | "
            "Environmental Quality | Social/Political/Cultural Environments | Safety & Security\n"
            "AWESOME DOMAINS: Access | Opportunities | Awareness | Mental Space\n"
            "  (Mental Space = beliefs/norms/values shaping behavior; treat as foundational and often "
            "upstream of other domains)\n"
            "CONTEXT LEVELS: Individual | Household | Community | Beyond\n"
            "MECHANISM TAGS: Factor | Constraint | Intervention | Impact/Feedback | Indicator\n\n"
            "TASK: For EACH chunk in the input, write one concise English executive synthesis paragraph "
            "(3–5 sentences) that:\n"
            "  - Names the primary AWESOME dimension(s) and domain(s) active in that segment\n"
            "  - Identifies whether empowering, disempowering, or mixed signals are present\n"
            "  - Notes any Mental Space (norms/beliefs) acting as upstream constraints\n"
            "  - Flags mechanism type (Factor / Constraint / Intervention / Impact) where evident\n"
            "  - References key speaker turns by MU_ID where available\n\n"
            "Return ONLY valid JSON with a single top-level key 'executiveSynthesis' whose value is an array. "
            "Each element: {\"chunk_id\": <int>, \"text\": \"<synthesis paragraph>\"}. "
            "One element per chunk. No merged chunks. No preamble.\n\n"
            f"OVERALL_SUMMARY: {overall_summary[:500]}\n\n"
            f"CHUNKS_JSON:\n{json.dumps(chunks_input, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(prompt, timeout=120.0, label="chunk-executive-synthesis")
            if parsed:
                raw_exec = _ensure_list(parsed.get("executiveSynthesis"))
                result_summaries: list[ChunkSummary] = []
                seen_ids: set[int] = set()
                for item in raw_exec:
                    if not isinstance(item, dict):
                        continue
                    cid = item.get("chunk_id")
                    text = str(item.get("text") or "").strip()
                    if isinstance(cid, int) and text and cid not in seen_ids:
                        seen_ids.add(cid)
                        result_summaries.append(ChunkSummary(chunk_id=cid, text=text))
                if result_summaries:
                    logger.info(
                        f"Generated executive synthesis for {len(result_summaries)} chunk(s) "
                        f"out of {len(chunk_results)} total."
                    )
                    return result_summaries
            logger.warning("Chunk executive synthesis returned empty/invalid JSON — falling back.")
        except RuntimeError as e:
            logger.warning(
                f"Chunk executive synthesis cancelled by Gemini (token limit or safety): {e}. "
                "Will attempt smaller per-chunk calls."
            )
        except Exception as e:
            logger.error(f"Chunk executive synthesis failed: {e}", exc_info=True)

        # Fallback: call Gemini once per chunk with a minimal prompt
        return await self._generate_executive_synthesis_per_chunk(chunk_results, turns, overall_summary)

    async def _generate_executive_synthesis_per_chunk(
        self,
        chunk_results: list[ChunkTranscript],
        turns: list[TranscriptTurn],
        overall_summary: str,
    ) -> list[ChunkSummary]:
        """Per-chunk fallback: one small Gemini call per chunk."""
        summaries: list[ChunkSummary] = []
        for chunk in chunk_results:
            chunk_turns = _turns_for_chunk(turns, chunk)
            turn_texts = [_summary_source_text(t) for t in chunk_turns[:8] if _summary_source_text(t).strip()]
            excerpt = (chunk.transcript or "")[:500]

            prompt = (
                "You are AWESOME-Qual-Mapping-GPT, a social science analyst applying the AWESOME framework.\n"
                "AWESOME DIMENSIONS: Health | Economic Vitality | Education & Skill Development | "
                "Environmental Quality | Social/Political/Cultural Environments | Safety & Security\n"
                "AWESOME DOMAINS: Access | Opportunities | Awareness | Mental Space\n"
                "CONTEXT LEVELS: Individual | Household | Community | Beyond\n\n"
                f"Write ONE concise English paragraph (3–5 sentences) as the executive synthesis "
                f"for audio chunk {chunk.chunk_id} (time {chunk.start_time:.0f}s–{chunk.end_time:.0f}s). "
                "Name the active AWESOME dimension(s) and domain(s), note empowering/disempowering signals, "
                "flag any Mental Space constraints, and identify the mechanism type (Factor/Constraint/"
                "Intervention/Impact) where evident. "
                "Return ONLY valid JSON: {\"chunk_id\": <int>, \"text\": \"<synthesis>\"}.\n\n"
                f"TRANSCRIPT_EXCERPT: {excerpt}\n"
                f"TURN_TEXTS: {json.dumps(turn_texts, ensure_ascii=False)}"
            )

            try:
                parsed = await self._request_json(prompt, timeout=60.0, label=f"exec-synthesis-chunk-{chunk.chunk_id}")
                if parsed:
                    text = str(parsed.get("text") or "").strip()
                    if text:
                        summaries.append(ChunkSummary(chunk_id=chunk.chunk_id, text=text))
                        continue
            except RuntimeError as e:
                logger.warning(
                    f"Per-chunk exec synthesis for chunk {chunk.chunk_id} cancelled by Gemini: {e}. "
                    "Using GoogleTranslator excerpt as fallback."
                )
            except Exception as e:
                logger.error(f"Per-chunk exec synthesis for chunk {chunk.chunk_id} failed: {e}", exc_info=True)

            # Last-resort: use the raw excerpt (translated if needed)
            fallback_text = excerpt or overall_summary or "Transcript segment generated."
            if _contains_non_ascii_letters(fallback_text):
                try:
                    fallback_text = await self._fallback_translate_text(fallback_text)
                except Exception:
                    pass
            summaries.append(ChunkSummary(chunk_id=chunk.chunk_id, text=fallback_text[:400]))

        return summaries

    # ------------------------------------------------------------------
    # Overall interview summary
    # ------------------------------------------------------------------

    async def _generate_interview_summary(self, result: FinalResult, merged: MergedTranscript) -> FinalResult:
        fallback_summary = _fallback_interview_summary(result.turns)
        if not self.settings.gemini_api_key or not merged.transcript.strip():
            if not result.summary:
                result.summary = fallback_summary
            if not result.executiveSynthesis:
                result.executiveSynthesis = await self._generate_chunk_executive_synthesis(
                    merged.chunk_results, result.turns, result.summary
                )
            return result

        summary_turns = result.turns[:30]
        truncated_transcript = merged.transcript[:2500]
        summary_prompt = (
            "You are AWESOME-Qual-Mapping-GPT, a social science analyst applying the AWESOME framework "
            "(Advancing Women's Empowerment through Systems-Oriented Model Expansion). "
            "Return only JSON with these top-level keys: summary, keyPoints. "
            "summary: a concise English summary of the interview (2–4 sentences) that names the primary "
            "AWESOME dimensions active (Health | Economic Vitality | Education & Skill Development | "
            "Environmental Quality | Social/Political/Cultural Environments | Safety & Security) and "
            "notes dominant domain signals (Access | Opportunities | Awareness | Mental Space). "
            "keyPoints: array of 3–6 concise English strings, each framed as an AWESOME finding "
            "(e.g. naming dimension, domain, valence, and mechanism where evident). "
            "Do not repeat raw transcript lines verbatim.\n\n"
            f"INPUT_JSON:\n{json.dumps({'transcript': truncated_transcript, 'languages': merged.languages, 'turns': [turn.model_dump() for turn in summary_turns]}, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(summary_prompt, timeout=60.0, label="interview-summary")
            if not parsed:
                logger.warning("Gemini summary generation returned empty response")
                raise ValueError("No summary payload returned")

            normalized_payload = _normalize_model_payload(parsed)
            summary = str(normalized_payload.get("summary") or "").strip() or fallback_summary
            key_points = normalized_payload.get("keyPoints") or []

            result.summary = summary
            result.keyPoints = [str(item).strip() for item in key_points if str(item).strip()]
        except RuntimeError as e:
            logger.warning(
                f"Interview summary cancelled by Gemini (token limit or safety): {e}. "
                "Using fallback summary."
            )
            if not result.summary:
                result.summary = fallback_summary
        except Exception as e:
            logger.error(f"Gemini summary generation failed: {e}", exc_info=True)
            if not result.summary:
                result.summary = fallback_summary

        # Always generate per-chunk executive synthesis separately
        result.executiveSynthesis = await self._generate_chunk_executive_synthesis(
            merged.chunk_results, result.turns, result.summary
        )
        return result

    # ------------------------------------------------------------------
    # Full pipeline entry point (transcript + summary)
    # ------------------------------------------------------------------

    async def build_transcript_ready_result(self, merged: MergedTranscript, *, include_summary: bool = False) -> FinalResult:
        result = self.build_default_result(merged)
        if not self.settings.gemini_api_key or not merged.transcript.strip():
            result.summary = result.summary or _fallback_interview_summary(result.turns)
            if not result.executiveSynthesis and result.summary:
                result.executiveSynthesis = [ChunkSummary(chunk_id=1, text=result.summary)]
            return result

        if not include_summary:
            result.summary = result.summary or _fallback_interview_summary(result.turns)
            if not result.executiveSynthesis and result.summary:
                result.executiveSynthesis = [ChunkSummary(chunk_id=1, text=result.summary)]
            # Fast GoogleTranslator pass so the 80 % partial result shows English
            fast_turns: list[TranscriptTurn] = []
            for turn in result.turns:
                if _looks_untranslated(turn.original, turn.translated) and _contains_non_ascii_letters(turn.original):
                    try:
                        fallback = await self._fallback_translate_text(turn.original)
                        fast_turns.append(turn.model_copy(update={"translated": fallback}))
                    except Exception:
                        fast_turns.append(turn)
                else:
                    fast_turns.append(turn)
            result.turns = fast_turns
            return result

        # include_summary=True: send combined prompt for translation + summary
        combined_turns = result.turns[:30]
        combined_transcript = merged.transcript[:2500]
        combined_prompt = (
            "You are AWESOME-Qual-Mapping-GPT, an expert translation, transliteration, and interview "
            "summarization engine applying the AWESOME framework (Advancing Women's Empowerment through "
            "Systems-Oriented Model Expansion). "
            "Return only JSON with these top-level keys: turns, summary, keyPoints. "
            "For every turn, preserve speaker, mu_id, timestamp, start_time_seconds, end_time_seconds, "
            "duration_seconds, confidence, language, and languages. "
            "Keep original exactly as given. Set transliterated to Latin script when the original is not already in Latin script. "
            "Set translated to fluent English. If the original turn is not English, translated must not repeat the source-language text. "
            "summary: a 2–4 sentence English summary naming the primary AWESOME dimensions active "
            "(Health | Economic Vitality | Education & Skill Development | Environmental Quality | "
            "Social/Political/Cultural Environments | Safety & Security) and dominant domain signals "
            "(Access | Opportunities | Awareness | Mental Space). "
            "keyPoints: array of 3–6 concise English strings, each framed as an AWESOME finding "
            "(naming dimension, domain, valence, and mechanism where evident).\n\n"
            f"INPUT_JSON:\n{json.dumps({'transcript': combined_transcript, 'language': merged.language, 'languages': merged.languages, 'turns': [turn.model_dump() for turn in combined_turns]}, ensure_ascii=False)}"
        )
        try:
            parsed = await self._request_json(combined_prompt, timeout=90.0, label="combined-translation-summary")
            if parsed:
                normalized_payload = _normalize_model_payload(parsed)
                result = FinalResult.model_validate(
                    {
                        **result.model_dump(),
                        **normalized_payload,
                        "chunk_results": [chunk.model_dump() for chunk in merged.chunk_results],
                        "detected_language": merged.detected_language or merged.language,
                        "languages": merged.languages,
                        "language_metadata": merged.language_metadata,
                    }
                )
            else:
                logger.warning("Combined prompt returned empty response — will fall back to separate summary call.")
        except RuntimeError as e:
            logger.warning(
                f"Combined prompt cancelled by Gemini (token limit or safety): {e}. "
                "Will fall back to separate summary call."
            )
        except Exception as e:
            logger.error(f"Combined prompt failed: {e}", exc_info=True)

        try:
            result.turns = await self._repair_turn_translations(result.turns)
        except Exception as e:
            logger.error(f"Turn translation repair failed: {e}", exc_info=True)

        normalized_turns: list[TranscriptTurn] = []
        for turn in result.turns:
            if _looks_untranslated(turn.original, turn.translated) and _contains_non_ascii_letters(turn.original):
                fallback_translated = await self._fallback_translate_text(turn.original)
                normalized_turns.append(turn.model_copy(update={"translated": fallback_translated}))
            else:
                normalized_turns.append(turn)
        result.turns = normalized_turns

        try:
            if not result.summary or not result.executiveSynthesis:
                result = await self._generate_interview_summary(result, merged)
        except Exception as e:
            logger.error(f"Interview summary generation failed: {e}", exc_info=True)

        # Always ensure per-chunk executive synthesis is populated
        if not result.executiveSynthesis:
            result.executiveSynthesis = await self._generate_chunk_executive_synthesis(
                merged.chunk_results, result.turns, result.summary
            )

        result = await self._ensure_english_summary_content(result)
        return result

    # ------------------------------------------------------------------
    # AWESOME artifact generation
    # ------------------------------------------------------------------

    async def _generate_artifact_sections(self, result: FinalResult, merged: MergedTranscript) -> FinalResult:
        """
        Generate all five AWESOME analytical artifacts from the interview transcript.

        Artifacts:
          1. Evidence Matrix — quotes mapped to AWESOME dimensions × domains
          2. Context Matrix — contextLevel × domain × finding
          3. Mechanism Chains — feedback loops and vulnerability pathways
          5. Hotspot Map — vulnerable groups and drivers
          + SMART Strategies for each identified leverage point

        Falls back gracefully if Gemini hits a token limit or safety block.
        """
        if not self.settings.gemini_api_key or not merged.transcript.strip():
            return result

        artifact_turns = result.turns[:30]
        artifact_transcript = merged.transcript[:2500]

        # Build per-chunk summaries text to give Gemini richer context
        exec_synthesis_text = "\n".join(
            f"Chunk {cs.chunk_id}: {cs.text}" for cs in result.executiveSynthesis
        )[:1200]

        artifact_prompt = (
            # ── PERSONA & FRAMEWORK ────────────────────────────────────────────
            "You are \"AWESOME-Qual-Mapping-GPT,\" a social science + implementation science analyst "
            "applying the AWESOME framework (Advancing Women's Empowerment through Systems-Oriented "
            "Model Expansion) to qualitative data (audio transcripts, interviews, FGDs, field debriefs).\n\n"

            "FRAMEWORK DEFINITIONS\n"
            "Women's empowerment = a process of increasing women's choices and capacity to make "
            "discerning decisions toward sustainability and resilience.\n\n"

            "AWESOME DIMENSIONS (use these labels exactly):\n"
            "  Health | Economic Vitality | Education & Skill Development | "
            "Environmental Quality | Social/Political/Cultural Environments | Safety & Security\n"
            "(These are interconnected — multi-tag when evidence spans more than one.)\n\n"

            "AWESOME DOMAINS (use these labels exactly):\n"
            "  Access = ability/right/privilege to obtain or use opportunities.\n"
            "  Opportunities = resources/assets (material, financial, human, social, political, etc.).\n"
            "  Awareness = consciousness/knowledge/understanding of constraints and processes.\n"
            "  Mental Space = beliefs/norms/values that influence attitudes/behavior (often subconscious "
            "and upstream of other domains — ALWAYS check whether Mental Space is present).\n\n"

            "CONTEXT LEVELS (scale of observation):\n"
            "  Individual | Household | Community | Beyond (State/Nation/Global when relevant)\n"
            "(Larger contexts shape smaller ones and vice versa.)\n\n"

            "MECHANISM TAGS (identify directionality; note time/trajectory when possible):\n"
            "  Factor | Constraint | Intervention | Impact/Feedback | Indicator\n"
            "  (Factors/constraints can be 'resistance' or 'resilience' related; "
            "impacts/feedback can be delayed or immediate, positive or negative.)\n\n"

            "VALENCE: Empowering | Disempowering | Mixed\n"
            "TIME SIGNAL: Past | Ongoing | Emerging | Seasonal | Shock event | Long-term\n\n"

            # ── OUTPUT SCHEMA ──────────────────────────────────────────────────
            "Return ONLY valid JSON (no preamble, no markdown) with these exact top-level keys:\n\n"

            "  keyPoints\n"
            "    Array of 3–6 concise English strings — the key interview findings.\n\n"

            "  artifact1_evidence\n"
            "    AWESOME Evidence Matrix — primary crosswalk of quotes/paraphrases across dimensions × domains.\n"
            "    Each object:\n"
            "      dimension   — one primary AWESOME dimension (string)\n"
            "      domain      — one primary AWESOME domain: Access | Opportunities | Awareness | Mental Space\n"
            "      evidence    — direct quote or close paraphrase from the transcript (≤25 words)\n"
            "      reasoning   — 1–2 sentences: (a) why this dimension/domain classification, "
            "(b) valence (Empowering/Disempowering/Mixed), (c) context level (Individual/Household/"
            "Community/Beyond), (d) mechanism tag (Factor/Constraint/Intervention/Impact/Indicator), "
            "(e) time signal\n"
            "    Aim for ≥2 entries; multi-tag when one quote spans multiple dimensions.\n\n"

            "  artifact2_context\n"
            "    Context × Domain Matrix — where change 'lives'; power dynamics and gatekeepers.\n"
            "    Each object:\n"
            "      contextLevel — Individual | Household | Community | Beyond\n"
            "      domain       — Access | Opportunities | Awareness | Mental Space\n"
            "      finding      — concise English description of the contextual factor or constraint; "
            "explicitly note gatekeepers (who controls access/opportunities; who shapes norms) where evident\n"
            "    Aim for ≥2 entries.\n\n"

            "  artifact3_chains\n"
            "    Mechanism Chain Table — implementation-ready causal tracing.\n"
            "    Format: Constraint(s) → (Mental Space/Awareness shifts) → Access/Opportunities change "
            "→ Decision/Choice outcomes → Impacts (intended/unintended).\n"
            "    Each object:\n"
            "      chain_id   — e.g. C1, C2\n"
            "      pathway    — the full causal chain as a concise narrative (include feedback loops "
            "where data supports, even qualitatively)\n"
            "      impacts    — downstream consequences on women's empowerment; note if delayed/immediate, "
            "intended/unintended\n"
            "    Aim for ≥2 chains.\n\n"

            "  artifact5_hotspots\n"
            "    Vulnerability/Empowerment Hotspot Register.\n"
            "    Each object:\n"
            "      vulnerable — who is vulnerable (use intersectional descriptors: age, caste, marital "
            "status, geography etc. where evident from transcript)\n"
            "      drivers    — structural or contextual drivers of that vulnerability (primary constraints + "
            "which AWESOME dimension/domain they sit in)\n"
            "    Aim for ≥2 hotspots.\n\n"

            "  artifact4_link_map\n"
            "    Link Map — systems view as a compact Mermaid flowchart string.\n"
            "    Return a single string containing a valid Mermaid 'graph LR' diagram that shows:\n"
            "      - Key factors, constraints, interventions, and impacts as nodes\n"
            "      - Directed edges showing causal relationships\n"
            "      - Feedback loops where data supports them (use bidirectional arrows)\n"
            "      - Hub variables (high-connectivity nodes) should be visually central\n"
            "    Keep it concise: 6–12 nodes maximum. Use short node labels (≤4 words each).\n"
            "    Example format: \"graph LR\\n  A[Male Elder Presence] --> B[Restricted Mobility]\\n  B --> C[Health Risks]\\n  D[Household Tap] --> B\"\n"
            "    If evidence is insufficient, return an empty string.\n\n"

            "  strategies\n"
            "    SMART Strategies — Implementation Science layer: translate findings into determinants "
            "and concrete strategies.\n"
            "    Each object:\n"
            "      strategy  — a concrete, context-sensitive intervention recommendation that avoids "
            "one-size-fits-all; name who must act and at which context level\n"
            "      indicator — a measurable monitoring indicator for this strategy\n"
            "    Aim for 5–8 strategies mapped to the top leverage points. "
            "Explicitly anticipate unintended consequences (e.g. backlash, elite capture) "
            "by appending an 'equity_risk' note inside the strategy string.\n\n"

            "RULES\n"
            "- If evidence is thin for a section, return an empty array (or empty string for artifact4_link_map) — do NOT fabricate.\n"
            "- Never invent facts not present in the transcript; label uncertainty explicitly.\n"
            "- Anonymize: do not reveal identifying details.\n"
            "- Always check whether Mental Space (norms/beliefs) is acting as an upstream constraint "
            "even when the surface topic is Economic or Health.\n"
            "- Output raw JSON only — no explanation, no markdown fences.\n\n"

            # ── INPUT ──────────────────────────────────────────────────────────
            f"OVERALL_SUMMARY:\n{result.summary[:600]}\n\n"
            f"CHUNK_SYNTHESES:\n{exec_synthesis_text}\n\n"
            f"INPUT_JSON:\n"
            f"{json.dumps({'turns': [turn.model_dump() for turn in artifact_turns], 'transcript': artifact_transcript}, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(artifact_prompt, timeout=120.0, label="awesome-artifacts")
            if not parsed:
                logger.warning(
                    "AWESOME artifact generation returned empty response from Gemini. "
                    "Fallback artifacts will be used."
                )
                return result

            normalized_payload = _normalize_model_payload(parsed)
            link_map_raw = normalized_payload.get("artifact4_link_map")
            link_map = str(link_map_raw).strip() if isinstance(link_map_raw, str) and link_map_raw.strip() else result.artifact4_link_map
            updated = FinalResult.model_validate(
                {
                    **result.model_dump(),
                    "keyPoints": normalized_payload.get("keyPoints") or result.keyPoints,
                    "artifact1_evidence": normalized_payload.get("artifact1_evidence") or result.artifact1_evidence,
                    "artifact2_context": normalized_payload.get("artifact2_context") or result.artifact2_context,
                    "artifact3_chains": normalized_payload.get("artifact3_chains") or result.artifact3_chains,
                    "artifact4_link_map": link_map,
                    "artifact5_hotspots": normalized_payload.get("artifact5_hotspots") or result.artifact5_hotspots,
                    "strategies": normalized_payload.get("strategies") or result.strategies,
                }
            )
            logger.info(
                f"AWESOME artifacts generated: "
                f"evidence={len(updated.artifact1_evidence)}, "
                f"context={len(updated.artifact2_context)}, "
                f"chains={len(updated.artifact3_chains)}, "
                f"link_map={'yes' if updated.artifact4_link_map else 'no'}, "
                f"hotspots={len(updated.artifact5_hotspots)}, "
                f"strategies={len(updated.strategies)}"
            )
            return updated

        except RuntimeError as e:
            # Token limit, RECITATION, SAFETY, etc.
            logger.warning(
                f"AWESOME artifact generation cancelled by Gemini: {e}. "
                "Attempting retry with a shorter transcript excerpt."
            )
            return await self._generate_artifacts_with_reduced_context(result, merged)

        except Exception as e:
            logger.error(f"AWESOME artifact generation failed with unexpected error: {e}", exc_info=True)
            return result

    async def _generate_artifacts_with_reduced_context(
        self, result: FinalResult, merged: MergedTranscript
    ) -> FinalResult:
        """
        Retry artifact generation with a heavily truncated context when the first
        attempt was cancelled due to Gemini's token or safety limits.
        """
        artifact_turns = result.turns[:20]
        artifact_transcript = merged.transcript[:1500]

        short_prompt = (
            "You are AWESOME-Qual-Mapping-GPT, a social science analyst applying the AWESOME framework "
            "(Advancing Women's Empowerment through Systems-Oriented Model Expansion).\n\n"
            "AWESOME DIMENSIONS: Health | Economic Vitality | Education & Skill Development | "
            "Environmental Quality | Social/Political/Cultural Environments | Safety & Security\n"
            "AWESOME DOMAINS: Access | Opportunities | Awareness | Mental Space\n"
            "  (Mental Space = beliefs/norms/values; treat as foundational and often upstream.)\n"
            "CONTEXT LEVELS: Individual | Household | Community | Beyond\n"
            "MECHANISM TAGS: Factor | Constraint | Intervention | Impact/Feedback | Indicator\n"
            "VALENCE: Empowering | Disempowering | Mixed\n\n"
            "Return ONLY valid JSON with these top-level keys:\n"
            "  keyPoints           — array of 3–6 concise English strings\n"
            "  artifact1_evidence  — array of {dimension, domain, evidence (≤25 words), reasoning "
            "(include valence + context level + mechanism tag)}\n"
            "  artifact2_context   — array of {contextLevel (Individual|Household|Community|Beyond), "
            "domain (Access|Opportunities|Awareness|Mental Space), finding (note gatekeepers)}\n"
            "  artifact3_chains    — array of {chain_id, pathway (Constraint→Mental Space→Access/"
            "Opportunities→Decision→Impact), impacts (note if delayed/unintended)}\n"
            "  artifact5_hotspots  — array of {vulnerable (intersectional descriptors), "
            "drivers (with dimension/domain)}\n"
            "  strategies          — array of {strategy (name who must act + equity_risk note), "
            "indicator}\n\n"
            "Minimum 1–2 entries per array where evidence exists. "
            "Return empty array if evidence is truly absent — do not fabricate. "
            "No preamble, no markdown.\n\n"
            f"SUMMARY: {result.summary[:400]}\n\n"
            f"TRANSCRIPT_EXCERPT: {artifact_transcript}\n\n"
            f"TURNS: {json.dumps([t.model_dump() for t in artifact_turns], ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(short_prompt, timeout=90.0, label="awesome-artifacts-reduced")
            if not parsed:
                logger.warning(
                    "AWESOME artifact retry (reduced context) also returned empty. "
                    "Fallback artifacts will be applied."
                )
                return result

            normalized_payload = _normalize_model_payload(parsed)
            link_map_raw2 = normalized_payload.get("artifact4_link_map")
            link_map2 = str(link_map_raw2).strip() if isinstance(link_map_raw2, str) and link_map_raw2.strip() else result.artifact4_link_map
            updated = FinalResult.model_validate(
                {
                    **result.model_dump(),
                    "keyPoints": normalized_payload.get("keyPoints") or result.keyPoints,
                    "artifact1_evidence": normalized_payload.get("artifact1_evidence") or result.artifact1_evidence,
                    "artifact2_context": normalized_payload.get("artifact2_context") or result.artifact2_context,
                    "artifact3_chains": normalized_payload.get("artifact3_chains") or result.artifact3_chains,
                    "artifact4_link_map": link_map2,
                    "artifact5_hotspots": normalized_payload.get("artifact5_hotspots") or result.artifact5_hotspots,
                    "strategies": normalized_payload.get("strategies") or result.strategies,
                }
            )
            logger.info("AWESOME artifacts generated successfully on reduced-context retry.")
            return updated

        except RuntimeError as e:
            logger.error(
                f"AWESOME artifact reduced-context retry also cancelled by Gemini: {e}. "
                "Fallback artifacts will be applied by _build_fallback_artifacts."
            )
            return result
        except Exception as e:
            logger.error(f"AWESOME artifact reduced-context retry failed: {e}", exc_info=True)
            return result

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
            summary=_fallback_interview_summary(base_turns),
            keyPoints=[],
            artifact1_evidence=[],
            artifact2_context=[],
            artifact3_chains=[],
            artifact5_hotspots=[],
            strategies=[],
            detected_language=merged.detected_language or merged.language,
            languages=merged.languages,
            language_metadata=merged.language_metadata,
            chunk_results=merged.chunk_results,
        )

    # ------------------------------------------------------------------
    # Top-level generate entry point
    # ------------------------------------------------------------------

    async def generate(self, merged: MergedTranscript) -> FinalResult:
        result = await self.build_transcript_ready_result(merged, include_summary=True)

        # ── Parallelise exec synthesis + artifact generation ────────────────
        # These two are independent of each other; running them concurrently
        # cuts the post-transcription Gemini wall-time roughly in half.
        async def _safe_exec_synthesis() -> list[ChunkSummary]:
            if result.executiveSynthesis:
                return result.executiveSynthesis
            try:
                return await self._generate_chunk_executive_synthesis(
                    merged.chunk_results, result.turns, result.summary
                )
            except Exception as e:
                logger.error(f"Top-level chunk executive synthesis failed: {e}", exc_info=True)
                return [ChunkSummary(chunk_id=1, text=result.summary)] if result.summary else []

        async def _safe_artifacts() -> FinalResult:
            try:
                return await self._generate_artifact_sections(result, merged)
            except Exception as e:
                logger.error(f"Top-level artifact generation failed: {e}", exc_info=True)
                return result

        exec_synthesis, result_with_artifacts = await asyncio.gather(
            _safe_exec_synthesis(),
            _safe_artifacts(),
        )

        result = result_with_artifacts
        if exec_synthesis:
            result.executiveSynthesis = exec_synthesis

        result = await self._ensure_english_summary_content(result)
        result = self._build_fallback_artifacts(result)

        if not result.keyPoints and result.artifact1_evidence:
            result.keyPoints = [item.evidence for item in result.artifact1_evidence if item.evidence]

        return result