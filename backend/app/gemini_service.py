from __future__ import annotations

import json
from typing import Any

import httpx

from .config import Settings
from .merge_engine import format_timestamp
from .models import FinalResult, MergedTranscript, TranscriptTurn


def _contains_non_ascii_letters(text: str) -> bool:
    return any(ord(char) > 127 and char.isalpha() for char in (text or ""))


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

    async def _request_json(self, prompt: str, *, timeout: float = 180.0) -> dict[str, Any] | None:
        url = (
            f"{self.settings.gemini_base_url}/models/{self.settings.gemini_model}:generateContent"
            f"?key={self.settings.gemini_api_key}"
        )

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

        raw_text = ""
        candidates = payload.get("candidates") or []
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            if parts:
                raw_text = parts[0].get("text", "")

        return _extract_json_object(raw_text)

    async def _repair_turn_translations(self, turns: list[TranscriptTurn]) -> list[TranscriptTurn]:
        if not self.settings.gemini_api_key or not any(_needs_turn_translation(turn) for turn in turns):
            return turns

        translation_prompt = (
            "You are an expert translation and transliteration engine. "
            "Return only JSON with a top-level key named turns. For each input turn, preserve speaker, mu_id, timestamp, "
            "and original exactly as given. Set transliterated to a Latin-script transliteration when original is not already in Latin script. "
            "Set translated to a faithful English translation for every turn. "
            "If original is already English, translated may match original. "
            "If original is not English, translated must not repeat the source-language text.\n\n"
            f"INPUT_JSON:\n{json.dumps({'turns': [turn.model_dump() for turn in turns]}, ensure_ascii=False)}"
        )

        parsed = await self._request_json(translation_prompt, timeout=120.0)
        if not parsed:
            return turns

        repaired_payload = _normalize_model_payload(parsed)
        repaired_turns = [TranscriptTurn.model_validate(item) for item in repaired_payload.get("turns", [])]
        if not repaired_turns:
            return turns

        return _merge_turn_repairs(turns, repaired_turns)

    def build_default_result(self, merged: MergedTranscript) -> FinalResult:
        base_turns = [
            TranscriptTurn(
                speaker=segment.speaker,
                original=segment.text,
                transliterated=segment.text,
                translated=segment.text,
                mu_id=f"MU-{index + 1:03d}",
                timestamp=format_timestamp(segment.start_time),
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
            summary="\n\n".join(turn.original for turn in base_turns[:3]),
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
        default_result = self.build_default_result(merged)
        base_turns = default_result.turns

        if not self.settings.gemini_api_key or not merged.transcript.strip():
            return default_result

        prompt_payload = {
            "transcript": merged.transcript,
            "language": merged.language,
            "languages": merged.languages,
            "turns": [
                {
                    "speaker": turn.speaker,
                    "original": turn.original,
                    "transliterated": turn.transliterated,
                    "translated": turn.translated,
                    "mu_id": turn.mu_id,
                    "timestamp": turn.timestamp,
                    "language": turn.language,
                    "languages": turn.languages,
                }
                for turn in base_turns
            ],
        }

        prompt = (
            "You are an expert qualitative research analysis engine. "
            "Using the AWESOME framework, analyze the merged transcript and return only JSON. "
            "Preserve the existing turns by mu_id and speaker. For every turn, keep original as-is, produce transliterated in Latin script when needed, and produce translated as fluent English. "
            "If the original turn is not English, translated must not repeat the source-language text. "
            "and return these top-level keys: turns, summary, executiveSynthesis, keyPoints, "
            "artifact1_evidence, artifact2_context, artifact3_chains, artifact5_hotspots, strategies. "
            "If a section has no content, return an empty array or empty string.\n\n"
            f"INPUT_JSON:\n{json.dumps(prompt_payload, ensure_ascii=False)}"
        )

        try:
            parsed = await self._request_json(prompt)
            if not parsed:
                default_result.turns = await self._repair_turn_translations(default_result.turns)
                return default_result

            normalized_payload = _normalize_model_payload(parsed)

            result = FinalResult.model_validate(
                {
                    **default_result.model_dump(),
                    **normalized_payload,
                    "chunk_results": [chunk.model_dump() for chunk in merged.chunk_results],
                    "detected_language": merged.detected_language or merged.language,
                    "languages": merged.languages,
                    "language_metadata": merged.language_metadata,
                }
            )

            result.turns = await self._repair_turn_translations(result.turns or base_turns)

            if not result.summary and result.executiveSynthesis:
                result.summary = "\n\n".join(item.text for item in result.executiveSynthesis)
            if not result.keyPoints and result.artifact1_evidence:
                result.keyPoints = [item.evidence for item in result.artifact1_evidence if item.evidence]

            return result
        except Exception:
            default_result.turns = await self._repair_turn_translations(default_result.turns)
            return default_result