from __future__ import annotations

from threading import Lock

import redis

from .config import Settings


class MemoryProgressStore:
    def __init__(self):
        self._lock = Lock()
        self._events: dict[str, list[str]] = {}

    def append_event(self, job_id: str, event_payload: str) -> None:
        with self._lock:
            self._events.setdefault(job_id, []).append(event_payload)

    def read_events(self, job_id: str, offset: int) -> list[str]:
        with self._lock:
            return list(self._events.get(job_id, [])[offset:])

    def clear_job(self, job_id: str) -> None:
        with self._lock:
            self._events.pop(job_id, None)


class RedisProgressStore:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._client = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            max_connections=settings.redis_max_connections,
            socket_timeout=10,
            socket_connect_timeout=5,
            retry_on_timeout=True,
            health_check_interval=30,
        )

    def append_event(self, job_id: str, event_payload: str) -> None:
        key = self._key(job_id)
        with self._client.pipeline() as pipeline:
            pipeline.rpush(key, event_payload)
            pipeline.expire(key, self._settings.progress_retention_seconds)
            pipeline.execute()

    def read_events(self, job_id: str, offset: int) -> list[str]:
        return [value for value in self._client.lrange(self._key(job_id), offset, -1)]

    def clear_job(self, job_id: str) -> None:
        self._client.delete(self._key(job_id))

    @staticmethod
    def _key(job_id: str) -> str:
        return f"viveka:progress:{job_id}"


_progress_store: MemoryProgressStore | RedisProgressStore | None = None


def get_progress_store(settings: Settings) -> MemoryProgressStore | RedisProgressStore:
    global _progress_store
    if _progress_store is None:
        _progress_store = RedisProgressStore(settings) if settings.redis_url else MemoryProgressStore()
    return _progress_store