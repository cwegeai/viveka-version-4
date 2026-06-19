from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.config import Settings
from backend.app.main import _supports_background_jobs
from backend.app.main import _background_queue_stalled


class BackgroundQueueStallTests(unittest.TestCase):
    def test_start_timeout_before_worker_event(self) -> None:
        self.assertFalse(_background_queue_stalled(False, 0.0, 0.0, 10.0, 15))
        self.assertTrue(_background_queue_stalled(False, 0.0, 0.0, 15.0, 15))

    def test_idle_timeout_after_worker_event(self) -> None:
        self.assertFalse(_background_queue_stalled(True, 0.0, 40.0, 80.0, 15))
        self.assertTrue(_background_queue_stalled(True, 0.0, 0.0, 60.0, 15))
        self.assertTrue(_background_queue_stalled(True, 0.0, 0.0, 61.0, 15))

    def test_background_jobs_use_30mb_cap(self) -> None:
        from backend.app import main as main_module

        original_settings = main_module.settings
        main_module.settings = Settings(
            host="127.0.0.1",
            port=8000,
            cors_origins=("http://localhost:3000",),
            temp_root=Path(".backend_runtime"),
            database_url="",
            redis_url="redis://127.0.0.1:6379/0",
            background_jobs_enabled=True,
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
            gemini_api_key="",
            gemini_model="gemini-2.5-flash",
            gemini_base_url="https://generativelanguage.googleapis.com/v1beta",
            azure_openai_endpoint="",
            azure_openai_api_version="2024-12-01-preview",
            azure_openai_chat_deployment="",
            azure_openai_api_key="",
        )
        try:
            self.assertTrue(_supports_background_jobs(5 * 1024 * 1024))
            self.assertTrue(_supports_background_jobs(30 * 1024 * 1024))
            self.assertFalse(_supports_background_jobs((30 * 1024 * 1024) + 1))
        finally:
            main_module.settings = original_settings


if __name__ == "__main__":
    unittest.main()
