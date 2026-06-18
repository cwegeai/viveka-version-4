from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def _env_bool(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    cors_origins: tuple[str, ...]
    temp_root: Path
    database_url: str
    redis_url: str
    background_jobs_enabled: bool
    background_job_min_bytes: int
    background_job_max_bytes: int
    background_job_start_timeout_seconds: int
    progress_retention_seconds: int
    progress_poll_interval_seconds: float
    redis_max_connections: int
    auth_session_hours: int
    password_reset_token_minutes: int
    admin_emails: tuple[str, ...]
    auth_expose_reset_token: bool
    upload_chunk_size_bytes: int
    direct_transcribe_max_seconds: int
    gemini_auto_max_seconds: int
    normalized_sample_rate: int
    normalized_channels: int
    chunk_minutes: int
    overlap_seconds: int
    small_file_limit_bytes: int
    medium_file_limit_bytes: int
    small_worker_count: int
    medium_worker_count: int
    large_worker_count: int
    upload_retry_count: int
    transcription_retry_count: int
    chunk_request_timeout_seconds: int
    deepgram_api_key: str
    deepgram_model: str
    deepgram_language: str
    deepgram_base_url: str
    deepgram_listen_path: str
    gemini_api_key: str
    gemini_model: str
    gemini_base_url: str


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    common_dev_origins = (
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )
    configured_origins = tuple(
        origin.strip()
        for origin in os.getenv("VIVEKA_BACKEND_CORS", ",".join(common_dev_origins)).split(",")
        if origin.strip()
    )
    origins = tuple(
        dict.fromkeys((*common_dev_origins, *configured_origins))
    )

    admin_emails = tuple(
        email.strip().lower()
        for email in os.getenv("VIVEKA_ADMIN_EMAILS", "").split(",")
        if email.strip()
    )

    temp_root = Path(os.getenv("VIVEKA_TEMP_ROOT", ".backend_runtime"))
    temp_root.mkdir(parents=True, exist_ok=True)

    return Settings(
        host=os.getenv("VIVEKA_BACKEND_HOST", "127.0.0.1"),
        port=int(os.getenv("VIVEKA_BACKEND_PORT", "8000")),
        cors_origins=origins,
        temp_root=temp_root,
        database_url=os.getenv("DATABASE_URL", "").strip(),
        redis_url=os.getenv("REDIS_URL", "").strip(),
        background_jobs_enabled=_env_bool("VIVEKA_BACKGROUND_JOBS_ENABLED", "true"),
        background_job_min_bytes=int(os.getenv("VIVEKA_BACKGROUND_JOB_MIN_BYTES", "0")),
        background_job_max_bytes=int(os.getenv("VIVEKA_BACKGROUND_JOB_MAX_BYTES", str(30 * 1024 * 1024))),
        background_job_start_timeout_seconds=int(os.getenv("VIVEKA_BACKGROUND_JOB_START_TIMEOUT_SECONDS", "15")),
        progress_retention_seconds=int(os.getenv("VIVEKA_PROGRESS_RETENTION_SECONDS", str(24 * 60 * 60))),
        progress_poll_interval_seconds=float(os.getenv("VIVEKA_PROGRESS_POLL_INTERVAL_SECONDS", "0.25")),
        redis_max_connections=int(os.getenv("VIVEKA_REDIS_MAX_CONNECTIONS", "6")),
        auth_session_hours=int(os.getenv("VIVEKA_AUTH_SESSION_HOURS", "24")),
        password_reset_token_minutes=int(os.getenv("VIVEKA_PASSWORD_RESET_TOKEN_MINUTES", "30")),
        admin_emails=admin_emails,
        auth_expose_reset_token=_env_bool("VIVEKA_AUTH_EXPOSE_RESET_TOKEN", "true"),
        upload_chunk_size_bytes=1024 * 1024,
        direct_transcribe_max_seconds=int(os.getenv("VIVEKA_DIRECT_TRANSCRIBE_MAX_SECONDS", str(20 * 60))),
        gemini_auto_max_seconds=int(os.getenv("VIVEKA_GEMINI_AUTO_MAX_SECONDS", str(15 * 60))),
        normalized_sample_rate=16000,
        normalized_channels=1,
        chunk_minutes=int(os.getenv("VIVEKA_CHUNK_MINUTES", "10")),
        overlap_seconds=int(os.getenv("VIVEKA_OVERLAP_SECONDS", "60")),
        small_file_limit_bytes=100 * 1024 * 1024,
        medium_file_limit_bytes=500 * 1024 * 1024,
        small_worker_count=int(os.getenv("VIVEKA_SMALL_WORKER_COUNT", "4")),
        medium_worker_count=int(os.getenv("VIVEKA_MEDIUM_WORKER_COUNT", "4")),
        large_worker_count=int(os.getenv("VIVEKA_LARGE_WORKER_COUNT", "4")),
        upload_retry_count=4,
        transcription_retry_count=3,
        chunk_request_timeout_seconds=int(os.getenv("STT_REQUEST_TIMEOUT_SECONDS", "600")),
        deepgram_api_key=os.getenv("DEEPGRAM_API_KEY", ""),
        deepgram_model=os.getenv("DEEPGRAM_MODEL", "nova-3"),
        deepgram_language=os.getenv("DEEPGRAM_LANGUAGE", "multi").strip() or "multi",
        deepgram_base_url=os.getenv("DEEPGRAM_BASE_URL", "https://api.deepgram.com").rstrip("/"),
        deepgram_listen_path=os.getenv("DEEPGRAM_LISTEN_PATH", "/v1/listen"),
        gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        gemini_base_url=os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/"),
    )