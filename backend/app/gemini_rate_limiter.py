from __future__ import annotations

import asyncio
import time


class GeminiRateLimiter:
    """Process-wide gate for outbound Gemini API calls.

    Transcription, translation, and summary calls all draw on the same
    Gemini API key/quota, but previously only translation had its own
    (separate, lower) concurrency cap — nothing coordinated the actual
    request rate across all three. This enforces both a max number of
    calls in flight and a minimum spacing between call starts, so bursts
    from any part of the pipeline can't stack up and trigger 429s.
    """

    def __init__(self, max_concurrency: int, min_interval_seconds: float):
        self._semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self._min_interval = max(0.0, min_interval_seconds)
        self._lock = asyncio.Lock()
        self._last_call_started = 0.0

    async def __aenter__(self) -> "GeminiRateLimiter":
        await self._semaphore.acquire()
        async with self._lock:
            wait = self._min_interval - (time.monotonic() - self._last_call_started)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_call_started = time.monotonic()
        return self

    async def __aexit__(self, *exc_info) -> None:
        self._semaphore.release()


_shared_limiter: GeminiRateLimiter | None = None


def get_gemini_rate_limiter(max_concurrency: int, min_interval_seconds: float) -> GeminiRateLimiter:
    """Return the single process-wide limiter, created on first use.

    Settings are read from whichever caller happens to construct it first
    (both call sites pass the same values from Settings, so this is only
    a formality) — the point is that everyone shares one limiter instance.
    """
    global _shared_limiter
    if _shared_limiter is None:
        _shared_limiter = GeminiRateLimiter(max_concurrency, min_interval_seconds)
    return _shared_limiter