"""Everything about talking to Gemini (plain REST via httpx): prompt, call, JSON validation."""
import json
import logging
import re

import httpx
from fastapi import HTTPException

from core.config import (
    ALLOWED_CODES,
    CODEBOOK_TEXT,
    GEMINI_API_KEY,
    GEMINI_BASE_URL,
    GEMINI_MODEL,
    GEMINI_TIMEOUT_SECONDS,
)

logger = logging.getLogger("gemini")

SYSTEM_INSTRUCTION = """
You are a qualitative-research coder. You are given one transcript segment from a semi-structured interview with a devotee of Amma. 
Your task is to classify MULTIPLE interview segments using ONLY the supplied PRISM codebook.

Rules:
1. Use only codes that exist in the codebook.
2. Multi-label classification is allowed.
3. Do not invent or rename codes.
4. If no code is supported for a segment, return an empty codes list for that segment.
5. Procedure, consent, logistics, stage directions, laughter and one-word reactions get NO codes.return an empty codes list for that segment.
6. Use the code definitions, not simple keyword matching.
7. Evidence must be a short exact phrase from that segment.
8 Confidence must be a number from 0 to 1.
9. You MUST return one result for EVERY supplied segment_id.
10. Never merge two segment_ids.
11. Never classify a segment using information from another segment.
13. Return valid JSON only.

Example few shot:
{
"principal_code": "Personal Life",
"sub_code": "Relation with mother",
"text": "And then, uh, so that was a big shift in her life and a lot happened. That’s like the 70s, there’s like a lot of feminism and all this kind of stuff going on and a lot of change for her internally through this all—this learning and becoming more independent and stuff. So it actually led to my—I mean, my parents separated and divorced when I was 12."
},
        {
          "principal_code": "Personal Life",
          "sub_code": "Relation with parents and other members (aunts, grandparents, etc.)",
          "text": "becoming more independent and stuff. So it actually led to my—I mean, my parents separated and divorced when I was 12."
        },
        {
          "principal_code": "Turning Points",
          "sub_code": "Divorce or separation (of parents, or of interviewee, if something that impacted)",
          "text": "becoming more independent and stuff. So it actually led to my—I mean, my parents separated and divorced when I was 12."
}

        {
          "principal_code": "IN VIVO",
          "sub_code": "Archana",
          "coded_text": "I would go to Archana and I would feel fully depressed because I would"
        },
        {
          "principal_code": "AMMA",
          "sub_code": "Personal relation to Amma",
          "coded_text": "I would go to Archana and I would feel fully depressed because I would just be fully Tamasic. Just like—I couldn't enjoy the Archana, I would have to walk and even if I was walking, I might walk right into something, you know? Like I was so, like, out of it. And I lost what I had gained. Like just this spiritual connection that I had been feeling back, you know?"
        },
        {
          "principal_code": "AMMA",
          "sub_code": "Experiences with Amma or related to Amma (darshan or other)",
          "coded_text": "I would go to Archana and I would feel fully depressed because I would just be fully Tamasic. Just like—I couldn't enjoy the Archana, I would have to walk and even if I was walking, I might walk right into something, you know? Like I was so, like, out of it. And I lost what I had gained. Like just this spiritual connection that I had been feeling back, you know?"
        },
        {
          "principal_code": "IN VIVO",
          "sub_code": "Archana",
          "coded_text": "just be fully Tamasic. Just like—I couldn't enjoy the Archana, I would have"
        }
Output format:

{
  "segments": [
    {
      "segment_id": "MU001",
      "codes": [
        {
          "principal_code": "...",
          "sub_code": "...",
          "confidence": 0.0,
          "evidence": "..."
        }
      ]
    }
  ]
}

"""


# Shape Gemini must follow. With a schema the reply is almost always valid JSON.
RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "segments": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "segment_id": {"type": "STRING"},
                    "codes": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "principal_code": {"type": "STRING"},
                                "sub_code": {"type": "STRING"},
                                "confidence": {"type": "NUMBER"},
                                "evidence": {"type": "STRING"},
                            },
                            "required": ["principal_code", "sub_code", "confidence", "evidence"],
                        },
                    },
                },
                "required": ["segment_id", "codes"],
            },
        }
    },
    "required": ["segments"],
}


def call_gemini(prompt: str) -> tuple[str, dict[str, int]]:
    """POST to {GEMINI_BASE_URL}/models/{model}:generateContent -> (reply text, token usage)."""
    if not GEMINI_API_KEY:
        raise HTTPException(500, "GEMINI_API_KEY is not configured.")

    url = f"{GEMINI_BASE_URL}/models/{GEMINI_MODEL}:generateContent"
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }
    headers = {"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"}

    try:
        response = httpx.post(url, json=payload, headers=headers, timeout=GEMINI_TIMEOUT_SECONDS)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Could not reach Gemini: {e}")

    if response.status_code != 200:
        raise HTTPException(502, f"Gemini API error {response.status_code}: {response.text[:500]}")

    data = response.json()
    candidates = data.get("candidates") or []
    if not candidates:
        raise ValueError(f"Gemini returned no candidates: {data.get('promptFeedback', data)}")

    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts)
    if not text.strip():
        raise ValueError(f"Gemini returned empty text (finishReason={candidates[0].get('finishReason')}).")

    meta = data.get("usageMetadata") or {}
    usage = {
        "input_tokens": int(meta.get("promptTokenCount", 0) or 0),
        # Thinking tokens are billed at the output price.
        "output_tokens": int(meta.get("candidatesTokenCount", 0) or 0),
        "thinking_tokens": int(meta.get("thoughtsTokenCount", 0) or 0),
        "requests": 1,
    }
    return text, usage


def build_prompt(batch: list[dict[str, str]]) -> str:
    blocks = "\n\n".join(
        f"SEGMENT_ID: {item['segment_id']}\nINTERVIEW_TEXT:\n{item['text']}" for item in batch
    )
    return f"""
PRISM CODEBOOK
==============

{CODEBOOK_TEXT}

INTERVIEW BATCH
===============

The following contains multiple independent interview segments.

IMPORTANT:
- Classify EACH segment independently.
- Preserve every SEGMENT_ID exactly.
- Do not combine segments.
- Return one JSON result for every SEGMENT_ID.

{blocks}

Return JSON only.
"""


def extract_json(text: str) -> dict:
    text = re.sub(r"^```json\s*", "", text.strip(), flags=re.I)
    text = re.sub(r"\s*```$", "", text)
    match = re.search(r"\{.*\}", text, flags=re.S)
    if not match:
        raise ValueError("Model did not return valid JSON.")
    return json.loads(match.group(0))


def validate_results(result: dict) -> dict[str, list[dict]]:
    """Drop invented codes, clamp confidence to 0-1, de-duplicate labels per segment."""
    validated = {}

    for seg in result.get("segments", []):
        segment_id = str(seg.get("segment_id", "")).strip()
        if not segment_id:
            continue

        unique = {}
        for item in seg.get("codes", []):
            principal = str(item.get("principal_code", "")).strip()
            sub = str(item.get("sub_code", "")).strip()
            if (principal, sub) not in ALLOWED_CODES:
                continue
            try:
                confidence = max(0.0, min(1.0, float(item.get("confidence", 0))))
            except Exception:
                confidence = 0.0
            unique[(principal, sub)] = {
                "principal_code": principal,
                "sub_code": sub,
                "confidence": confidence,
                "evidence": str(item.get("evidence", "")).strip(),
            }

        validated[segment_id] = list(unique.values())

    return validated


def _empty_usage() -> dict[str, int]:
    return {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "requests": 0}


def _ask_gemini(batch: list[dict[str, str]], label: str, total_usage: dict[str, int], attempts: int = 2) -> dict[str, list[dict]]:
    """
    Code one batch. If Gemini returns broken JSON: try again, and if it still fails
    split the batch in two halves and code each half on its own.
    Every attempt is added to total_usage (retries cost tokens too).
    """
    for attempt in range(1, attempts + 1):
        response_text, usage = call_gemini(build_prompt(batch))
        for key, value in usage.items():
            total_usage[key] += value

        try:
            validated = validate_results(extract_json(response_text))
        except ValueError as e:  # includes json.JSONDecodeError
            logger.warning("Batch %s: invalid JSON from Gemini (attempt %d/%d): %s", label, attempt, attempts, e)
            continue

        # Keep segments the model forgot as unlabelled instead of losing them.
        missing = {i["segment_id"] for i in batch} - set(validated)
        if missing:
            logger.warning("Batch %s: Gemini skipped %d segment(s): %s", label, len(missing), sorted(missing))
            for segment_id in missing:
                validated[segment_id] = []
        return validated

    if len(batch) > 1:
        middle = len(batch) // 2
        logger.warning("Batch %s: splitting %d segments into two smaller requests.", label, len(batch))
        result = _ask_gemini(batch[:middle], f"{label}a", total_usage, attempts)
        result.update(_ask_gemini(batch[middle:], f"{label}b", total_usage, attempts))
        return result

    raise ValueError(f"Gemini kept returning invalid JSON for segment {batch[0]['segment_id']}.")


def code_batch(batch: list[dict[str, str]], batch_number: int) -> tuple[dict[str, list[dict]], dict[str, int]]:
    """Send ONE batch of segments to Gemini -> ({segment_id: [codes]}, token usage)."""
    logger.info(
        "Batch %d: %d segments, %d chars -> %s",
        batch_number, len(batch), sum(len(i["text"]) for i in batch), GEMINI_MODEL,
    )

    total_usage = _empty_usage()
    validated = _ask_gemini(batch, str(batch_number), total_usage)

    logger.info("Batch %d done.", batch_number)
    return validated, total_usage