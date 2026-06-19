from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from .config import Settings
from .merge_engine import format_timestamp
from .models import ChunkSummary, FinalResult, MergedTranscript, TranscriptTurn


def _contains_non_ascii_letters(text: str) -> bool:
    return any(ord(char) > 127 and char.isalpha() for char in (text or ""))


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

    list_fields = [
        "turns",
    ]
    for field_name in list_fields:
        normalized[field_name] = _ensure_list(normalized.get(field_name))

    if not isinstance(normalized.get("summary"), str):
        normalized["summary"] = str(normalized.get("summary") or "")

    return normalized


class GeminiArtifactService:
    def __init__(self, settings: Settings):
        self.settings = settings

    def _has_azure_fallback(self) -> bool:
        return bool(
            self.settings.azure_openai_endpoint
            and self.settings.azure_openai_api_key
            and self.settings.azure_openai_chat_deployment
        )

    async def _request_json_via_azure(self, prompt: str, *, timeout: float = 180.0) -> dict[str, Any] | None:
        if not self._has_azure_fallback():
            return None

        url = (
            f"{self.settings.azure_openai_endpoint}/openai/deployments/"
            f"{self.settings.azure_openai_chat_deployment}/chat/completions"
            f"?api-version={self.settings.azure_openai_api_version}"
        )

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "api-key": self.settings.azure_openai_api_key,
                },
                json={
                    "messages": [
                        {
                            "role": "user",
                            "content": prompt,
                        }
                    ],
                    "temperature": 0.2,
                    "response_format": {"type": "json_object"},
                },
            )
            response.raise_for_status()
            payload = response.json()

        choices = payload.get("choices") or []
        if not choices:
            return None

        content = choices[0].get("message", {}).get("content", "")
        return _extract_json_object(content)

    async def _request_json(self, prompt: str, *, timeout: float = 180.0) -> dict[str, Any] | None:
        url = (
            f"{self.settings.gemini_base_url}/models/{self.settings.gemini_model}:generateContent"
            f"?key={self.settings.gemini_api_key}"
        )

        last_error: Exception | None = None
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
                if exc.response.status_code not in {429, 500, 502, 503, 504} or attempt >= 3:
                    raise
                await asyncio.sleep(2 ** attempt)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                if attempt >= 3:
                    raise
                await asyncio.sleep(2 ** attempt)
        else:
            if last_error:
                if self._has_azure_fallback():
                    return await self._request_json_via_azure(prompt, timeout=timeout)
                raise last_error
            return None

        raw_text = ""
        candidates = payload.get("candidates") or []
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            if parts:
                raw_text = parts[0].get("text", "")

        parsed = _extract_json_object(raw_text)
        if parsed is None and self._has_azure_fallback():
            return await self._request_json_via_azure(prompt, timeout=timeout)
        return parsed

    async def _repair_turn_translations(self, turns: list[TranscriptTurn]) -> list[TranscriptTurn]:
        if not self.settings.gemini_api_key or not any(_needs_turn_translation(turn) for turn in turns):
            return turns

        batch_size = 6
        repaired_turns = turns
        pending_turns = [turn for turn in turns if _needs_turn_translation(turn)]

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
            parsed = await self._request_json(translation_prompt, timeout=120.0)
        except Exception:
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
            parsed = await self._request_json(strict_prompt, timeout=120.0)
            if not parsed:
                return turn
            normalized_payload = _normalize_model_payload(parsed)
            repaired_turns = [TranscriptTurn.model_validate(item) for item in normalized_payload.get('turns', [])]
            if not repaired_turns:
                return turn
            repaired_turn = repaired_turns[0]
            if _needs_turn_translation(repaired_turn):
                return turn
            return turn.model_copy(
                update={
                    'transliterated': repaired_turn.transliterated or turn.transliterated,
                    'translated': repaired_turn.translated or turn.translated,
                    'language': repaired_turn.language or turn.language,
                    'languages': repaired_turn.languages or turn.languages,
                }
            )
        except Exception:
            return turn

    async def _generate_interview_summary(self, result: FinalResult, merged: MergedTranscript) -> FinalResult:
        fallback_summary = _fallback_interview_summary(result.turns)
        if not self.settings.gemini_api_key or not merged.transcript.strip():
            if not result.summary:
                result.summary = fallback_summary
            if not result.executiveSynthesis:
                result.executiveSynthesis = [ChunkSummary(chunk_id=1, text=result.summary)]
            return result

        summary_prompt = (
            "You are an expert qualitative interview summarizer. "
            "Return only JSON with these top-level keys: summary, executiveSynthesis, keyPoints. "
            "summary must be a concise interview summary in English. "
            "executiveSynthesis must be an array with 1 to 3 short English paragraphs summarizing the interview. "
            "Do not repeat raw transcript lines unless necessary.\n\n"
            f"INPUT_JSON:\n{json.dumps({'transcript': merged.transcript, 'languages': merged.languages, 'turns': [turn.model_dump() for turn in result.turns]}, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(summary_prompt, timeout=90.0)
            if not parsed:
                raise ValueError("No summary payload returned")

            normalized_payload = _normalize_model_payload(parsed)
            summary = str(normalized_payload.get("summary") or "").strip() or fallback_summary
            executive = normalized_payload.get("executiveSynthesis") or []
            if not executive:
                executive = [{"chunk_id": 1, "text": summary}]
            key_points = normalized_payload.get("keyPoints") or []

            result.summary = summary
            result.executiveSynthesis = [ChunkSummary.model_validate(item) for item in executive]
            result.keyPoints = [str(item).strip() for item in key_points if str(item).strip()]
            return result
        except Exception:
            if not result.summary:
                result.summary = fallback_summary
            if not result.executiveSynthesis:
                result.executiveSynthesis = [ChunkSummary(chunk_id=1, text=result.summary)]
            return result

    async def build_transcript_ready_result(self, merged: MergedTranscript, *, include_summary: bool = False) -> FinalResult:
        result = self.build_default_result(merged)
        try:
            result.turns = await self._repair_turn_translations(result.turns)
        except Exception:
            pass
        if include_summary:
            try:
                result = await self._generate_interview_summary(result, merged)
            except Exception:
                pass
        else:
            result.summary = result.summary or _fallback_interview_summary(result.turns)
        if not result.executiveSynthesis and result.summary:
            result.executiveSynthesis = [ChunkSummary(chunk_id=1, text=result.summary)]
        return result

    async def _generate_artifact_sections(self, result: FinalResult, merged: MergedTranscript) -> FinalResult:
        if not self.settings.gemini_api_key or not merged.transcript.strip():
            return result

        artifact_prompt = (
            "You are an expert qualitative research analysis engine using the AWESOME framework. "
            "Return only JSON with these top-level keys: keyPoints, artifact1_evidence, artifact2_context, artifact3_chains, artifact5_hotspots, strategies. "
            "Use concise English throughout. If there is insufficient evidence for a section, return an empty array for that section.\n\n"
            f"INPUT_JSON:\n{json.dumps({'summary': result.summary, 'executiveSynthesis': [item.model_dump() for item in result.executiveSynthesis], 'turns': [turn.model_dump() for turn in result.turns], 'transcript': merged.transcript}, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(artifact_prompt, timeout=120.0)
            if not parsed:
                return result

            normalized_payload = _normalize_model_payload(parsed)
            return FinalResult.model_validate(
                {
                    **result.model_dump(),
                    'keyPoints': normalized_payload.get('keyPoints', result.keyPoints),
                    'artifact1_evidence': normalized_payload.get('artifact1_evidence', result.artifact1_evidence),
                    'artifact2_context': normalized_payload.get('artifact2_context', result.artifact2_context),
                    'artifact3_chains': normalized_payload.get('artifact3_chains', result.artifact3_chains),
                    'artifact5_hotspots': normalized_payload.get('artifact5_hotspots', result.artifact5_hotspots),
                    'strategies': normalized_payload.get('strategies', result.strategies),
                }
            )
        except Exception:
            return result

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

    async def generate(self, merged: MergedTranscript) -> FinalResult:
        result = await self.build_transcript_ready_result(merged, include_summary=True)
        result = await self._generate_artifact_sections(result, merged)

        if not result.keyPoints and result.artifact1_evidence:
            result.keyPoints = [item.evidence for item in result.artifact1_evidence if item.evidence]

        return result