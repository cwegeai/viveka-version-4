from __future__ import annotations

import json
from typing import Any

import httpx

from .config import Settings
from .merge_engine import format_timestamp
from .models import FinalResult, MergedTranscript, TranscriptTurn


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
            "Preserve the existing turns by mu_id and speaker, add English translations when useful, "
            "and return these top-level keys: turns, summary, executiveSynthesis, keyPoints, "
            "artifact1_evidence, artifact2_context, artifact3_chains, artifact5_hotspots, strategies. "
            "If a section has no content, return an empty array or empty string.\n\n"
            f"INPUT_JSON:\n{json.dumps(prompt_payload, ensure_ascii=False)}"
        )

        url = (
            f"{self.settings.gemini_base_url}/models/{self.settings.gemini_model}:generateContent"
            f"?key={self.settings.gemini_api_key}"
        )

        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
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

            parsed = _extract_json_object(raw_text)
            if not parsed:
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

            if not result.summary and result.executiveSynthesis:
                result.summary = "\n\n".join(item.text for item in result.executiveSynthesis)
            if not result.keyPoints and result.artifact1_evidence:
                result.keyPoints = [item.evidence for item in result.artifact1_evidence if item.evidence]

            return result
        except Exception:
            return default_result