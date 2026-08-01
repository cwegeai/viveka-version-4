# backend/app/hybrid_transcription_service.py
#
# Tries Gemini first for every chunk (free tier, no cost). Only if
# Gemini's own internal retries all fail for that specific chunk does
# it fall through to OpenAI as a paid safety net. In normal operation
# (Gemini healthy) this keeps OpenAI spend at ~$0, since OpenAI is only
# ever called on chunks Gemini genuinely could not handle.
#
# Both underlying services already share the exact same interface:
#   __init__(settings: Settings)
#   async transcribe_chunk(chunk_id, file_path, start_time, end_time) -> ChunkTranscript
# and both fail *gracefully* (return a ChunkTranscript with `.error` set,
# never raise) after their own retries - which is what makes a clean
# fallback possible here without extra try/except plumbing.
#
# Same public interface as GeminiTranscriptionService /
# OpenAITranscriptionService, so it drops into pipeline.py with a
# one-line change:
#   self.transcriber = HybridTranscriptionService(settings)

from __future__ import annotations

import logging
from pathlib import Path

from .config import Settings
from .gemini_transcription_service import GeminiTranscriptionService
from .openai_transcription_service import OpenAITranscriptionService
from .models import ChunkTranscript

logger = logging.getLogger(__name__)


class HybridTranscriptionService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.primary = GeminiTranscriptionService(settings)
        self.fallback = OpenAITranscriptionService(settings)

    @property
    def metrics(self):
        return self.primary.metrics

    @metrics.setter
    def metrics(self, value):
        self.primary.metrics = value

    async def transcribe_chunk(self, chunk_id: int, file_path: Path, start_time: float, end_time: float) -> ChunkTranscript:
        primary_result = await self.primary.transcribe_chunk(chunk_id, file_path, start_time, end_time)

        # Gemini succeeded (or at least didn't hit its own retry-exhausted
        # error path) - use it as-is. No OpenAI call, no cost.
        if not primary_result.error:
            return primary_result

        logger.warning(
            f"Gemini failed for chunk {chunk_id} after its own retries "
            f"({primary_result.error}) - falling back to OpenAI for this "
            f"chunk only."
        )

        fallback_result = await self.fallback.transcribe_chunk(chunk_id, file_path, start_time, end_time)

        if fallback_result.error:
            # Both providers failed for this chunk. Don't hide either
            # error - log both so it's clear this wasn't just an OpenAI
            # problem or just a Gemini problem.
            logger.error(
                f"Both providers failed for chunk {chunk_id}. "
                f"Gemini error: {primary_result.error} | "
                f"OpenAI error: {fallback_result.error}"
            )
        else:
            logger.info(f"OpenAI fallback succeeded for chunk {chunk_id}.")

        return fallback_result