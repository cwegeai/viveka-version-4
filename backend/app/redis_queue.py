from __future__ import annotations

import json

import redis

from .config import Settings


QUEUE_KEY = "viveka:jobs"
_queue_clients: dict[str, redis.Redis] = {}


def _get_queue_client(settings: Settings) -> redis.Redis:
    key = settings.redis_url
    client = _queue_clients.get(key)
    if client is None:
        client = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            max_connections=settings.redis_max_connections,
            socket_timeout=10,
            socket_connect_timeout=5,
            retry_on_timeout=True,
            health_check_interval=30,
        )
        _queue_clients[key] = client
    return client


def enqueue_job(
    settings: Settings,
    job_id: str,
    source_path: str,
    file_size_bytes: int,
    workspace_path: str,
    original_filename: str,
) -> None:
    client = _get_queue_client(settings)
    client.rpush(
        QUEUE_KEY,
        json.dumps(
            {
                "job_id": job_id,
                "source_path": source_path,
                "file_size_bytes": file_size_bytes,
                "workspace_path": workspace_path,
                "original_filename": original_filename,
            }
        ),
    )