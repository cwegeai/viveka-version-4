from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from pathlib import Path

import redis

from .config import get_settings
from .events import progress_event
from .models import PipelineStage
from .pipeline import PipelineRunner
from .progress_store import get_progress_store
from .redis_queue import QUEUE_KEY


logger = logging.getLogger(__name__)


def main() -> None:
    settings = get_settings()
    if not settings.redis_url:
        raise RuntimeError("REDIS_URL is required for backend:worker")

    client = redis.Redis.from_url(
        settings.redis_url,
        decode_responses=True,
        max_connections=settings.redis_max_connections,
        socket_timeout=10,
        socket_connect_timeout=5,
        retry_on_timeout=True,
        health_check_interval=30,
    )
    progress_store = get_progress_store(settings)
    runner = PipelineRunner(settings)

    while True:
        try:
            raw_payload = client.lpop(QUEUE_KEY)
            if raw_payload is None:
                time.sleep(1)
                continue
            try:
                payload = json.loads(raw_payload)
            except json.JSONDecodeError:
                logger.warning("Dropping malformed queue payload: %r", raw_payload)
                time.sleep(0.25)
                continue
            asyncio.run(_process_job(payload, progress_store, runner))
        except redis.RedisError as exc:
            logger.warning("Redis worker connection issue: %s", exc)
            time.sleep(2)
            client = redis.Redis.from_url(
                settings.redis_url,
                decode_responses=True,
                max_connections=settings.redis_max_connections,
                socket_timeout=10,
                socket_connect_timeout=5,
                retry_on_timeout=True,
                health_check_interval=30,
            )
        except Exception as exc:
            logger.exception("Worker loop recovered from unexpected error: %s", exc)
            time.sleep(1)


async def _process_job(
    payload: dict,
    progress_store,
    runner: PipelineRunner,
) -> None:
    job_id = payload["job_id"]
    source_path = Path(payload["source_path"])
    workspace = Path(payload["workspace_path"])
    file_size_bytes = int(payload["file_size_bytes"])

    try:
        async for event_payload in runner.run_saved_source(source_path, file_size_bytes, workspace):
            progress_store.append_event(job_id, event_payload)
    except Exception as exc:
        progress_store.append_event(job_id, progress_event(PipelineStage.error, f"Pipeline failed: {exc}"))
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    main()