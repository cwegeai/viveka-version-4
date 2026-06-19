from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.config import Settings
from backend.app.pipeline import PipelineRunner


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
        small_file_limit_bytes=100 * 1024 * 1024,
        medium_file_limit_bytes=500 * 1024 * 1024,
        small_worker_count=4,
        medium_worker_count=4,
        large_worker_count=4,
        upload_retry_count=0,
        transcription_retry_count=0,
        chunk_request_timeout_seconds=60,
        deepgram_api_key="test-key",
        deepgram_model="nova-3",
        deepgram_language="multi",
        deepgram_base_url="https://api.deepgram.com",
        deepgram_listen_path="/v1/listen",
        gemini_api_key="",
        gemini_model="gemini-2.5-flash",
        gemini_base_url="https://generativelanguage.googleapis.com/v1beta",
        azure_openai_endpoint="",
        azure_openai_api_version="2024-12-01-preview",
        azure_openai_chat_deployment="",
        azure_openai_api_key="",
    )


class PipelineRuntimeGuardsTests(unittest.TestCase):
    def test_large_files_use_capped_parallelism(self) -> None:
        runner = PipelineRunner(make_settings())
        self.assertEqual(runner._worker_count_for_size(50 * 1024 * 1024), 4)
        self.assertEqual(runner._worker_count_for_size(200 * 1024 * 1024), 4)
        self.assertEqual(runner._worker_count_for_size(1200 * 1024 * 1024), 4)


if __name__ == "__main__":
    unittest.main()
