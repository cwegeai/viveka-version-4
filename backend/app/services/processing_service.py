"""Batching + parallel Gemini calls + building the final output rows."""
import asyncio
import logging
from typing import Any, Callable

from ..core.config import (
    BATCH_CHAR_LIMIT,
    GEMINI_INPUT_PRICE_PER_M,
    GEMINI_MODEL,
    GEMINI_OUTPUT_PRICE_PER_M,
    MAX_CONCURRENT_GEMINI_BATCHES,
    USD_TO_INR,
)
from ..services.file_service import MU_ID_NAMES, SPEAKER_NAMES, find_field
from ..services.gemini_service import code_batch

logger = logging.getLogger("processing")

# Receives progress events (dicts) while a file is being coded.
ProgressCallback = Callable[[dict[str, Any]], None]


def build_batches(segments: list[dict[str, Any]], char_limit: int = BATCH_CHAR_LIMIT) -> list[list[dict[str, str]]]:
    """
    Group segments by CHARACTER COUNT. A segment is never split; one longer than
    the limit is sent alone.
    """
    batches, current, chars = [], [], 0

    for item in segments:
        text = str(item.get("text", "")).strip()
        if not text:
            continue

        if current and chars + len(text) > char_limit:
            batches.append(current)
            current, chars = [], 0

        current.append({"segment_id": str(item.get("segment_id", "")).strip(), "text": text})
        chars += len(text)

    if current:
        batches.append(current)
    return batches


async def _run_batches_parallel(
    batches: list[list[dict[str, str]]],
    on_progress: ProgressCallback | None = None,
) -> list[tuple[dict[str, list[dict]], dict[str, int]]]:
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_GEMINI_BATCHES)
    counts = {"total": len(batches), "pending": len(batches), "running": 0, "completed": 0, "failed": 0}

    def emit(batch_number: int, status: str) -> None:
        if on_progress:
            on_progress({"type": "batch", "batch": batch_number, "status": status, **counts})

    async def run_one(number: int, batch: list[dict[str, str]]):
        async with semaphore:
            counts["pending"] -= 1
            counts["running"] += 1
            emit(number, "running")
            try:
                # Gemini call is synchronous -> worker thread keeps FastAPI responsive.
                result = await asyncio.to_thread(code_batch, batch, number)
            except asyncio.CancelledError:
                counts["running"] -= 1
                raise
            except Exception:
                counts["running"] -= 1
                counts["failed"] += 1
                emit(number, "failed")
                raise
            counts["running"] -= 1
            counts["completed"] += 1
            emit(number, "done")
            return result

    tasks = [asyncio.create_task(run_one(n, b)) for n, b in enumerate(batches, start=1)]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        # One batch failed (or the user cancelled): stop the batches that have not started yet.
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


def print_cost_summary(usages: list[dict[str, int]]) -> None:
    """Print the Gemini cost of one finished run in USD and INR (ASCII only: safe for Windows consoles)."""
    input_tokens = sum(u["input_tokens"] for u in usages)
    output_tokens = sum(u["output_tokens"] for u in usages)
    thinking_tokens = sum(u["thinking_tokens"] for u in usages)

    cost_usd = (
        input_tokens * GEMINI_INPUT_PRICE_PER_M
        + (output_tokens + thinking_tokens) * GEMINI_OUTPUT_PRICE_PER_M
    ) / 1_000_000
    cost_inr = cost_usd * USD_TO_INR

    print(
        "\n"
        f"======== Gemini cost ({GEMINI_MODEL}) ========\n"
        f"Gemini calls  : {sum(u['requests'] for u in usages)} (batches: {len(usages)})\n"
        f"Input tokens  : {input_tokens:,}\n"
        f"Output tokens : {output_tokens + thinking_tokens:,} (answer {output_tokens:,} + thinking {thinking_tokens:,})\n"
        f"Cost (USD)    : $ {cost_usd:.6f}\n"
        f"Cost (INR)    : Rs {cost_inr:.4f}   (1 USD = {USD_TO_INR} INR)\n"
        "=========================================\n",
        flush=True,
    )


async def process_segments(
    rows: list[dict[str, Any]],
    on_progress: ProgressCallback | None = None,
) -> list[dict[str, Any]]:
    """Input rows -> original row data + AI labels (one output row per code)."""
    valid_rows = [r for r in rows if str(r.get("text", "")).strip()]
    batches = build_batches(valid_rows)
    logger.info("%d rows (%d with text) -> %d Gemini batches", len(rows), len(valid_rows), len(batches))

    if on_progress:
        on_progress(
            {
                "type": "start",
                "total_batches": len(batches),
                "total_segments": len(valid_rows),
                "max_parallel": MAX_CONCURRENT_GEMINI_BATCHES,
                "batches": [
                    {"batch": n, "segments": len(b), "chars": sum(len(item["text"]) for item in b)}
                    for n, b in enumerate(batches, start=1)
                ],
            }
        )

    all_codes: dict[str, list[dict]] = {}
    usages: list[dict[str, int]] = []
    for batch_result, usage in await _run_batches_parallel(batches, on_progress):
        all_codes.update(batch_result)
        usages.append(usage)
    print_cost_summary(usages)

    output = []
    for row in rows:
        original = row.get("original", {})
        base = dict(original)
        segment_id = str(row.get("segment_id", "")).strip()

        # Add our own ID column only if the upload has no ID column of its own
        # (so an uploaded "Segment_ID" column is kept and not duplicated).
        id_column = find_field(list(original), MU_ID_NAMES)
        if id_column is None or id_column == "MU_ID":
            base["MU_ID"] = segment_id
        elif not str(base.get(id_column, "") or "").strip():
            base[id_column] = segment_id  # empty ID cell in the upload -> show the generated number

        # Keys starting with "_" are internal (used by the Word output); Excel skips them.
        base["_segment_id"] = segment_id
        base["_text"] = str(row.get("text", "")).strip()

        # Speaker column of a CSV/Excel upload (if it has one)
        speaker_column = find_field(list(original), SPEAKER_NAMES)
        if speaker_column:
            base["_speaker"] = str(original.get(speaker_column, "") or "").strip()

        codes = all_codes.get(segment_id, [])
        if not codes:
            output.append({**base, "principal_code": "", "sub_code": "", "confidence": "", "evidence": ""})
        else:
            output.extend({**base, **code} for code in codes)

    return output