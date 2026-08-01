from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import dramatiq
from dramatiq.brokers.redis import RedisBroker
from dramatiq.brokers.stub import StubBroker

from .config import get_settings
from .events import progress_event
from .job_repository import JobRepository
from .models import PipelineStage
from .pipeline import PipelineRunner
from .progress_store import get_progress_store


settings = get_settings()
broker = RedisBroker(url=settings.redis_url) if settings.redis_url else StubBroker()
dramatiq.set_broker(broker)


@dramatiq.actor(max_retries=0, queue_name="transcription")
def run_transcription_job(
    job_id: str,
    source_path: str,
    file_size_bytes: int,
    workspace_path: str,
    original_filename: str,
) -> None:
    asyncio.run(
        _run_transcription_job(
            job_id,
            Path(source_path),
            file_size_bytes,
            Path(workspace_path),
            original_filename,
        )
    )


async def _run_transcription_job(
    job_id: str,
    source_path: Path,
    file_size_bytes: int,
    workspace: Path,
    _original_filename: str,
) -> None:
    settings = get_settings()
    repository = JobRepository(settings)
    progress_store = get_progress_store(settings)
    runner = PipelineRunner(settings)

    try:
        repository.mark_processing(job_id)
        async for event_payload in runner.run_saved_source(source_path, file_size_bytes, workspace):
            progress_store.append_event(job_id, event_payload)
        repository.mark_completed(job_id)
    except Exception as exc:
        repository.mark_failed(job_id, str(exc))
        progress_store.append_event(job_id, progress_event(PipelineStage.error, f"Pipeline failed: {exc}"))
    finally:
        shutil.rmtree(workspace, ignore_errors=True)