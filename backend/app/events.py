from __future__ import annotations

import json

from .models import PipelineStage, ProgressEvent


def sse_event(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def progress_event(
    stage: PipelineStage,
    message: str,
    progress: int | None = None,
    chunk_index: int | None = None,
    total_chunks: int | None = None,
) -> str:
    event = ProgressEvent(
        stage=stage,
        message=message,
        progress=progress,
        chunk_index=chunk_index,
        total_chunks=total_chunks,
    )
    return sse_event(stage.value, event.model_dump())