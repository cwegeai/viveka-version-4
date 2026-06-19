from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.config import Settings
from backend.app.gemini_service import GeminiArtifactService
from backend.app.models import MergedTranscript, SpeakerSegment


def make_settings() -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8000,
        cors_origins=("http://localhost:3000",),
        temp_root=Path(".backend_runtime"),
        database_url="",
        redis_url="",
        background_jobs_enabled=False,
        background_job_min_bytes=0,
        background_job_max_bytes=30 * 1024 * 1024,
        background_job_start_timeout_seconds=15,
        progress_retention_seconds=3600,
        progress_poll_interval_seconds=0.25,
        redis_max_connections=6,
        auth_session_hours=24,
        password_reset_token_minutes=30,
        admin_emails=(),
        auth_expose_reset_token=True,
        upload_chunk_size_bytes=1024,
        direct_transcribe_max_seconds=1200,
        gemini_auto_max_seconds=900,
        normalized_sample_rate=16000,
        normalized_channels=1,
        chunk_minutes=10,
        overlap_seconds=60,
        small_file_limit_bytes=10,
        medium_file_limit_bytes=20,
        small_worker_count=1,
        medium_worker_count=1,
        large_worker_count=1,
        upload_retry_count=0,
        transcription_retry_count=0,
        chunk_request_timeout_seconds=60,
        deepgram_api_key="test-key",
        deepgram_model="nova-3",
        deepgram_language="multi",
        deepgram_base_url="https://api.deepgram.com",
        deepgram_listen_path="/v1/listen",
        gemini_api_key="test-gemini-key",
        gemini_model="gemini-2.5-flash",
        gemini_base_url="https://generativelanguage.googleapis.com/v1beta",
        azure_openai_endpoint="",
        azure_openai_api_version="2024-12-01-preview",
        azure_openai_chat_deployment="",
        azure_openai_api_key="",
    )


class GeminiTranslationRepairTests(unittest.TestCase):
    def test_generate_repairs_untranslated_non_english_turns(self) -> None:
        service = GeminiArtifactService(make_settings())
        merged = MergedTranscript(
            transcript="Speaker 1: साठ होने के लिए तीन साल जाएगी.",
            language="hi",
            detected_language="hi",
            languages=["hi"],
            speakers=[
                SpeakerSegment(
                    speaker="Speaker 1",
                    text="साठ होने के लिए तीन साल जाएगी.",
                    start_time=0.0,
                    end_time=3.0,
                    language="hi",
                    languages=["hi"],
                )
            ],
            chunk_results=[],
        )

        responses = [
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {
                                            "turns": [
                                                {
                                                    "speaker": "Speaker 1",
                                                    "original": "साठ होने के लिए तीन साल जाएगी.",
                                                    "transliterated": "saath hone ke liye teen saal jaayegi.",
                                                    "translated": "It will take three years to turn sixty.",
                                                    "mu_id": "MU-001",
                                                    "timestamp": "00:00",
                                                }
                                            ]
                                        },
                                        ensure_ascii=False,
                                    )
                                }
                            ]
                        }
                    }
                ]
            },
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {
                                            "summary": "The speaker says it will take three years to turn sixty.",
                                            "executiveSynthesis": [
                                                {
                                                    "chunk_id": 1,
                                                    "text": "The speaker says it will take three years to turn sixty."
                                                }
                                            ],
                                            "keyPoints": [
                                                "Three years remain before the speaker turns sixty."
                                            ]
                                        },
                                        ensure_ascii=False,
                                    )
                                }
                            ]
                        }
                    }
                ]
            },
        ]

        class FakeResponse:
            def __init__(self, payload):
                self._payload = payload

            def raise_for_status(self) -> None:
                return None

            def json(self):
                return self._payload

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                self._responses = responses

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, *args, **kwargs):
                return FakeResponse(self._responses.pop(0))

        import backend.app.gemini_service as gemini_module

        original_client = gemini_module.httpx.AsyncClient
        gemini_module.httpx.AsyncClient = FakeAsyncClient
        try:
            result = asyncio.run(service.generate(merged))
        finally:
            gemini_module.httpx.AsyncClient = original_client

        self.assertEqual(result.turns[0].translated, "It will take three years to turn sixty.")
        self.assertEqual(result.turns[0].transliterated, "saath hone ke liye teen saal jaayegi.")


if __name__ == "__main__":
    unittest.main()