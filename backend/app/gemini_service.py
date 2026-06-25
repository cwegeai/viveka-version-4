from __future__ import annotations

import asyncio
import json
import logging
import random
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
    FinalResult,
    MergedTranscript,
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
        # Semaphore is created lazily on first use so it is always bound to the
        # running event loop (module-level Semaphore creation breaks on Python ≥3.10).
        self._semaphore: asyncio.Semaphore | None = None

    def _get_semaphore(self) -> asyncio.Semaphore:
        """Return (creating if needed) a per-instance Semaphore.

        Allows up to 5 concurrent Gemini requests — safe now that artifact
        generation has been removed and overall request count is low.
        """
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(5)
        return self._semaphore

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
        timeout: float = 60.0,
        label: str = "Gemini request",
    ) -> dict[str, Any] | None:
        """
        Call Gemini generateContent and return the parsed JSON payload.
        Rotates through fallback models on HTTP 404, 429, 5xx, or network errors.
        """
        configured_model = self.settings.gemini_model
        models_to_try = [configured_model]
        for m in ["gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-pro", "gemini-pro-latest"]:
            if m not in models_to_try:
                models_to_try.append(m)

        last_error: Exception | None = None

        for model_name in models_to_try:
            url = (
                f"{self.settings.gemini_base_url}/models/{model_name}:generateContent"
                f"?key={self.settings.gemini_api_key}"
            )

            # Retry waits (seconds) for 429/5xx: 1.0s + jitter
            for attempt in range(2):
                try:
                    async with self._get_semaphore():
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

                        if response.status_code in {429, 500, 502, 503, 504}:
                            body_text = response.text[:200]
                            logger.warning(
                                f"[{label}] Model {model_name} HTTP {response.status_code} "
                                f"(attempt {attempt + 1}/2). Body: {body_text}"
                            )
                            if attempt < 1:
                                wait = random.uniform(0.5, 1.5)
                                await asyncio.sleep(wait)
                                continue
                            break  # Try next model

                        if response.status_code == 404:
                            logger.warning(f"[{label}] Model {model_name} returned 404. Trying next model.")
                            break  # Try next model immediately

                        response.raise_for_status()
                        payload = response.json()

                    # Inspect candidates and content
                    candidates = payload.get("candidates") or []
                    if not candidates:
                        prompt_feedback = payload.get("promptFeedback", {})
                        block_reason = prompt_feedback.get("blockReason", "")
                        logger.warning(
                            f"[{label}] Model {model_name} returned no candidates. "
                            f"blockReason={block_reason}"
                        )
                        break  # Try next model

                    candidate = candidates[0]
                    finish_reason = candidate.get("finishReason", "STOP")
                    if finish_reason in _TRUNCATED_FINISH_REASONS:
                        logger.warning(
                            f"[{label}] Model {model_name} response cut off. "
                            f"finishReason={finish_reason}"
                        )
                        break  # Try next model

                    parts_list = candidate.get("content", {}).get("parts", [])
                    raw_text = parts_list[0].get("text", "") if parts_list else ""
                    parsed = _extract_json_object(raw_text)
                    if parsed:
                        logger.info(f"[{label}] Success with model {model_name}")
                        return parsed
                    else:
                        logger.warning(
                            f"[{label}] Model {model_name} response did not contain "
                            f"valid JSON: {raw_text[:150]}"
                        )
                        break  # Try next model

                except httpx.HTTPStatusError as exc:
                    last_error = exc
                    logger.warning(f"[{label}] Model {model_name} HTTP error: {exc}")
                    break  # Try next model

                except (httpx.TimeoutException, httpx.NetworkError) as exc:
                    last_error = exc
                    logger.warning(
                        f"[{label}] Model {model_name} network/timeout error (attempt {attempt + 1}/2): {exc}"
                    )
                    if attempt < 1:
                        await asyncio.sleep(0.5)
                        continue
                    break  # Try next model

                except Exception as exc:
                    last_error = exc
                    logger.error(
                        f"[{label}] Unexpected error with model {model_name}: {exc}",
                        exc_info=True
                    )
                    break  # Try next model
        
        logger.error(f"[{label}] All Gemini candidate models failed to return parsed JSON.")
        return None

    # ------------------------------------------------------------------
    # Turn translation helpers
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

    async def _repair_turn_translations(self, turns: list[TranscriptTurn]) -> list[TranscriptTurn]:
        """Translate any turns that still have non-English text using GoogleTranslator."""
        if not any(_needs_turn_translation(turn) for turn in turns):
            return turns

        repaired: list[TranscriptTurn] = []
        for turn in turns:
            if _needs_turn_translation(turn):
                try:
                    translated = await self._fallback_translate_text(turn.original)
                    repaired.append(turn.model_copy(update={"translated": translated}))
                except Exception:
                    repaired.append(turn)
            else:
                repaired.append(turn)
        return repaired

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
            parsed = await self._request_json(translation_prompt, timeout=45.0, label="turn-translation-batch")
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
            parsed = await self._request_json(strict_prompt, timeout=30.0, label="single-turn-translation")
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

        # Build a compact input: for each chunk send up to 400 chars of transcript
        chunks_input = []
        for chunk in chunk_results:
            chunk_turns = _turns_for_chunk(turns, chunk)
            turn_texts = [_summary_source_text(t) for t in chunk_turns[:6] if _summary_source_text(t).strip()]
            chunks_input.append({
                "chunk_id": chunk.chunk_id,
                "start": f"{chunk.start_time:.0f}s",
                "end": f"{chunk.end_time:.0f}s",
                "excerpt": chunk_text_map.get(chunk.chunk_id, "")[:400],
                "turns": turn_texts[:4],
            })

        prompt = (
            "You are a qualitative research analyst. "
            "For EACH chunk, write one concise English executive synthesis paragraph (3-5 sentences). "
            "Return ONLY valid JSON: {\"executiveSynthesis\": [{\"chunk_id\": <int>, \"text\": \"<synthesis>\"}]}. "
            "One element per chunk. No preamble.\n\n"
            f"SUMMARY: {overall_summary[:300]}\n\n"
            f"CHUNKS:\n{json.dumps(chunks_input, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(prompt, timeout=40.0, label="chunk-executive-synthesis")
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
            turn_texts = [_summary_source_text(t) for t in chunk_turns[:6] if _summary_source_text(t).strip()]
            excerpt = (chunk.transcript or "")[:400]

            prompt = (
                "You are a qualitative research analyst. "
                f"Write ONE concise English paragraph (3-5 sentences) as the executive synthesis "
                f"for audio chunk {chunk.chunk_id} (time {chunk.start_time:.0f}s-{chunk.end_time:.0f}s). "
                "Return ONLY valid JSON: {\"chunk_id\": <int>, \"text\": \"<synthesis>\"}.\n\n"
                f"EXCERPT: {excerpt}\n"
                f"TURNS: {json.dumps(turn_texts, ensure_ascii=False)}"
            )

            try:
                parsed = await self._request_json(prompt, timeout=30.0, label=f"exec-synthesis-chunk-{chunk.chunk_id}")
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

        summary_turns = result.turns[:20]
        truncated_transcript = merged.transcript[:1500]
        summary_prompt = (
            "You are a qualitative research analyst. "
            "Return only JSON with keys: summary, keyPoints. "
            "summary: concise English summary of the interview (2-4 sentences). "
            "keyPoints: array of 3-5 concise English strings with key findings. "
            "Do not repeat raw transcript lines verbatim.\n\n"
            f"INPUT_JSON:\n{json.dumps({'transcript': truncated_transcript, 'languages': merged.languages, 'turns': [turn.model_dump() for turn in summary_turns]}, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(summary_prompt, timeout=45.0, label="interview-summary")
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
            result.summary = ""
            result.executiveSynthesis = []
            # Fast GoogleTranslator pass so the 80% partial result shows English
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
        combined_turns = result.turns[:100]
        combined_transcript = merged.transcript[:10000]
        combined_prompt = (
            "You are an expert translation, transliteration, and interview summarization engine. "
            "Return only JSON with keys: turns."#, summary, keyPoints. "
            "For every turn, preserve speaker, mu_id, timestamp, start_time_seconds, end_time_seconds, "
            "duration_seconds, confidence, language, and languages. "
            "Keep original exactly as given. "
            "IMPORTANT: transliterated MUST contain ONLY Latin (English) characters. "
            "Never return Hindi, Tamil, Telugu, Malayalam or any native script in transliterated. "
            "If the original is Hindi 'वह उसका प्रशिक्षण लिए हैं ना आपने?', the transliterated value MUST be "
            "'Wah uska prashikshan liye hain na aapne?'. "
            "Set translated to fluent English. If not English, translated must not repeat source text. "
            #"summary: 2-4 sentence English summary. "
            #"keyPoints: array of 3-5 concise English findings.\n\n"
            f"INPUT_JSON:\n{json.dumps({'transcript': combined_transcript, 'language': merged.language, 'languages': merged.languages, 'turns': [turn.model_dump() for turn in combined_turns]}, ensure_ascii=False)}"
        )
        try:
            parsed = await self._request_json(combined_prompt, timeout=60.0, label="combined-translation-summary")
            if parsed:
                normalized_payload = _normalize_model_payload(parsed)
                repaired_turns = [TranscriptTurn.model_validate(item) for item in normalized_payload.get("turns", [])]
                result.turns = _merge_turn_repairs(result.turns, repaired_turns)
            #    result.summary = normalized_payload.get("summary", "")
             #   result.keyPoints = normalized_payload.get("keyPoints", [])
                result.detected_language = merged.detected_language or merged.language
                result.languages = merged.languages
                result.language_metadata = merged.language_metadata
                result.chunk_results = merged.chunk_results
            else:
                logger.warning("Combined prompt returned empty response — will fall back to separate summary call.")
        except RuntimeError as e:
            logger.warning(
                f"Combined prompt cancelled by Gemini (token limit or safety): {e}. "
                "Will fall back to separate summary call."
            )
        except httpx.HTTPStatusError as e:
            logger.warning(
                f"Combined prompt HTTP {e.response.status_code} after retries — falling back to separate summary call."
            )
        except Exception as e:
            logger.error(f"Combined prompt failed unexpectedly: {e}", exc_info=True)

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

     #   try:
     #     if not result.summary:
     #           result = await self._generate_interview_summary(result, merged)
     #   except Exception as e:
     #       logger.error(f"Interview summary generation failed: {e}", exc_info=True)

        # Generate per-chunk executive synthesis if not already populated
    #    if not result.executiveSynthesis:
    #        try:
    #            result.executiveSynthesis = await self._generate_chunk_executive_synthesis(
    #                merged.chunk_results, result.turns, result.summary
    #            )
    #        except Exception as e:
    #            logger.error(f"Chunk executive synthesis failed: {e}", exc_info=True)
    #            if result.summary:
    #                result.executiveSynthesis = [ChunkSummary(chunk_id=1, text=result.summary)]

    #    result = await self._ensure_english_summary_content(result)

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
            summary="",#_fallback_interview_summary(base_turns),
            keyPoints=[],
            detected_language=merged.detected_language or merged.language,
            languages=merged.languages,
            language_metadata=merged.language_metadata,
            chunk_results=merged.chunk_results,
        )
