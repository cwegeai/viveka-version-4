from __future__ import annotations

from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row

from .config import Settings
from .models import JobStatus


@dataclass(frozen=True)
class JobRecord:
    job_id: str
    status: str
    file_name: str
    file_size_bytes: int
    workspace_path: str
    source_path: str
    error_message: str | None = None


class JobRepository:
    def __init__(self, settings: Settings):
        self.settings = settings

    def is_enabled(self) -> bool:
        return bool(self.settings.database_url)

    def ensure_schema(self) -> None:
        if not self.is_enabled():
            return
        with psycopg.connect(self.settings.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS transcription_jobs (
                        job_id TEXT PRIMARY KEY,
                        status TEXT NOT NULL,
                        file_name TEXT NOT NULL,
                        file_size_bytes BIGINT NOT NULL,
                        workspace_path TEXT NOT NULL,
                        source_path TEXT NOT NULL,
                        error_message TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
            connection.commit()

    def create_job(
        self,
        job_id: str,
        file_name: str,
        file_size_bytes: int,
        workspace_path: str,
        source_path: str,
    ) -> None:
        if not self.is_enabled():
            return
        with psycopg.connect(self.settings.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO transcription_jobs (
                        job_id,
                        status,
                        file_name,
                        file_size_bytes,
                        workspace_path,
                        source_path
                    ) VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        job_id,
                        JobStatus.queued.value,
                        file_name,
                        file_size_bytes,
                        workspace_path,
                        source_path,
                    ),
                )
            connection.commit()

    def mark_processing(self, job_id: str) -> None:
        self._update_status(job_id, JobStatus.processing.value)

    def mark_completed(self, job_id: str) -> None:
        self._update_status(job_id, JobStatus.complete.value, None)

    def mark_failed(self, job_id: str, error_message: str) -> None:
        self._update_status(job_id, JobStatus.error.value, error_message)

    def get_status(self, job_id: str) -> str | None:
        record = self.get_job(job_id)
        return record.status if record else None

    def get_job(self, job_id: str) -> JobRecord | None:
        if not self.is_enabled():
            return None
        with psycopg.connect(self.settings.database_url, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT job_id, status, file_name, file_size_bytes, workspace_path, source_path, error_message FROM transcription_jobs WHERE job_id = %s",
                    (job_id,),
                )
                row = cursor.fetchone()
        if not row:
            return None
        return JobRecord(**row)

    def _update_status(self, job_id: str, status: str, error_message: str | None = None) -> None:
        if not self.is_enabled():
            return
        with psycopg.connect(self.settings.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE transcription_jobs
                    SET status = %s,
                        error_message = %s,
                        updated_at = NOW()
                    WHERE job_id = %s
                    """,
                    (status, error_message, job_id),
                )
            connection.commit()