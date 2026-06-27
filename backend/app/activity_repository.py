"""
Viveka AI — Activity & Metrics Repository
==========================================
Implements all fields from the Admin Panel Data Schema doc:
  1. User Identity
  2. File & Upload Metrics
  3. Language & Transcription
  4. Analysis Artifacts (stubbed — artifacts removed from pipeline)
  5. Processing Performance
  6. Input Source & Export Actions
  7. Device & Access Context
  8. Dashboard Metrics (aggregated queries)

Token cost estimation uses Gemini 2.5 Flash pricing:
  Input:  $0.15 / 1M tokens  (≈ 4 chars/token)
  Output: $0.60 / 1M tokens
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .config import Settings


# ---------------------------------------------------------------------------
# Gemini 2.5 Flash pricing (USD per token, as of 2025)
# ---------------------------------------------------------------------------
_INPUT_COST_PER_TOKEN  = 0.15  / 1_000_000   # $0.15 / 1M input tokens
_OUTPUT_COST_PER_TOKEN = 0.60  / 1_000_000   # $0.60 / 1M output tokens
_CHARS_PER_TOKEN       = 4                    # rough approximation


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    """Convert datetime/Decimal to JSON-safe types."""
    import decimal
    out: dict[str, Any] = {}
    for k, v in row.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, decimal.Decimal):
            out[k] = float(v)
        else:
            out[k] = v
    return out




# ---------------------------------------------------------------------------
# Dataclasses for in-flight tracking (populated by pipeline hooks)
# ---------------------------------------------------------------------------

@dataclass
class TranscriptionMetrics:
    """Accumulated during a single transcription run; written on completion."""
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    # --- identity ---
    user_id:    str | None = None
    user_email: str | None = None

    # --- file ---
    original_filename: str = ""
    file_size_mb:      float = 0.0
    audio_duration_mins: float = 0.0
    audio_format:      str = ""
    input_method:      str = "file_upload"   # or "live_recording"
    live_recording_duration_secs: float = 0.0

    # --- processing performance ---
    processing_start:  datetime | None = None
    processing_end:    datetime | None = None
    processing_status: str = "success"       # success / failed / partial
    error_message:     str = ""
    chunked_processing: bool = False
    num_chunks:        int = 0

    # --- language & transcription ---
    detected_language:         str = ""
    script_used:               str = ""
    translation_generated:     bool = False
    transliteration_generated: bool = False
    num_speakers:              int = 0
    num_transcript_turns:      int = 0

    # --- artifacts (all false — generation removed) ---
    executive_summary_generated: bool = False
    pdf_dossier_downloaded:      bool = False

    # --- exports ---
    email_sent:          bool = False
    synced_google_drive: bool = False
    synced_google_sheets: bool = False

    # --- device context ---
    user_agent:   str = ""
    device_type:  str = ""
    ip_address:   str = ""

    # --- gemini token tracking ---
    gemini_input_tokens:  int = 0
    gemini_output_tokens: int = 0

    @property
    def gemini_cost_usd(self) -> float:
        return (
            self.gemini_input_tokens  * _INPUT_COST_PER_TOKEN +
            self.gemini_output_tokens * _OUTPUT_COST_PER_TOKEN
        )

    @property
    def processing_duration_secs(self) -> float:
        if self.processing_start and self.processing_end:
            return (self.processing_end - self.processing_start).total_seconds()
        return 0.0

    def add_gemini_call(self, prompt: str, response_text: str) -> None:
        """Call after every Gemini response to accumulate token estimates."""
        self.gemini_input_tokens  += _estimate_tokens(prompt)
        self.gemini_output_tokens += _estimate_tokens(response_text)


# ---------------------------------------------------------------------------
# Repository
# ---------------------------------------------------------------------------

class ActivityRepository:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ok = False

    def _connect(self):
        if not self.settings.database_url:
            raise RuntimeError("DATABASE_URL is required for activity tracking")
        return psycopg.connect(self.settings.database_url, row_factory=dict_row)

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def ensure_schema(self) -> None:
        if self._schema_ok:
            return
        with self._connect() as conn:
            with conn.cursor() as cur:
                # --- session login tracking (extends auth_sessions) ---
                cur.execute("""
                    ALTER TABLE auth_sessions
                        ADD COLUMN IF NOT EXISTS login_at    TIMESTAMPTZ,
                        ADD COLUMN IF NOT EXISTS logout_at   TIMESTAMPTZ,
                        ADD COLUMN IF NOT EXISTS user_agent  TEXT,
                        ADD COLUMN IF NOT EXISTS ip_address  TEXT,
                        ADD COLUMN IF NOT EXISTS device_type TEXT
                """)

                # --- main activity / transcription log ---
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS transcription_activity (
                        id                        TEXT PRIMARY KEY,
                        user_id                   TEXT REFERENCES app_users(id) ON DELETE SET NULL,
                        user_email                TEXT,
                        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

                        -- File & Upload Metrics
                        original_filename         TEXT,
                        file_size_mb              NUMERIC(10,3),
                        audio_duration_mins       NUMERIC(10,3),
                        audio_format              TEXT,
                        input_method              TEXT DEFAULT 'file_upload',
                        live_recording_duration_secs NUMERIC(10,1) DEFAULT 0,

                        -- Processing Performance
                        processing_start          TIMESTAMPTZ,
                        processing_end            TIMESTAMPTZ,
                        processing_duration_secs  NUMERIC(10,1),
                        processing_status         TEXT DEFAULT 'success',
                        error_message             TEXT,
                        chunked_processing        BOOLEAN DEFAULT FALSE,
                        num_chunks                INT DEFAULT 0,

                        -- Language & Transcription
                        detected_language         TEXT,
                        script_used               TEXT,
                        translation_generated     BOOLEAN DEFAULT FALSE,
                        transliteration_generated BOOLEAN DEFAULT FALSE,
                        num_speakers              INT DEFAULT 0,
                        num_transcript_turns      INT DEFAULT 0,

                        -- Analysis Artifacts
                        executive_summary_generated BOOLEAN DEFAULT FALSE,
                        pdf_dossier_downloaded    BOOLEAN DEFAULT FALSE,

                        -- Export Actions
                        email_sent                BOOLEAN DEFAULT FALSE,
                        synced_google_drive       BOOLEAN DEFAULT FALSE,
                        synced_google_sheets      BOOLEAN DEFAULT FALSE,

                        -- Device Context
                        user_agent                TEXT,
                        ip_address                TEXT,
                        device_type               TEXT,

                        -- Gemini Token / Cost
                        gemini_input_tokens       INT DEFAULT 0,
                        gemini_output_tokens      INT DEFAULT 0,
                        gemini_cost_usd           NUMERIC(12,6) DEFAULT 0
                    )
                """)

                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_ta_user_id
                        ON transcription_activity (user_id)
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_ta_created_at
                        ON transcription_activity (created_at DESC)
                """)

            conn.commit()

            # Backfill user_id on existing rows that have user_email but no user_id
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE transcription_activity ta
                    SET user_id = u.id
                    FROM app_users u
                    WHERE ta.user_id IS NULL
                      AND ta.user_email = u.email
                """)
            conn.commit()
        self._schema_ok = True

    # ------------------------------------------------------------------
    # Session / login tracking
    # ------------------------------------------------------------------

    def record_login(
        self,
        session_token_hash: str,
        *,
        user_agent: str = "",
        ip_address: str = "",
        device_type: str = "",
    ) -> None:
        """Call immediately after a session token is created."""
        try:
            self.ensure_schema()
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        UPDATE auth_sessions
                        SET login_at   = NOW(),
                            user_agent = %s,
                            ip_address = %s,
                            device_type = %s
                        WHERE token_hash = %s
                    """, (user_agent, ip_address, device_type, session_token_hash))
                conn.commit()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(f"record_login failed: {exc}")

    def record_logout(self, session_token_hash: str) -> None:
        """Call when session is revoked."""
        try:
            self.ensure_schema()
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        UPDATE auth_sessions
                        SET logout_at = NOW()
                        WHERE token_hash = %s
                    """, (session_token_hash,))
                conn.commit()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(f"record_logout failed: {exc}")

    # ------------------------------------------------------------------
    # Transcription activity
    # ------------------------------------------------------------------

    def record_transcription(self, m: TranscriptionMetrics) -> None:
        """Upsert a transcription activity record."""
        try:
            self.ensure_schema()
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO transcription_activity (
                            id, user_id, user_email, created_at,
                            original_filename, file_size_mb, audio_duration_mins, audio_format,
                            input_method, live_recording_duration_secs,
                            processing_start, processing_end, processing_duration_secs,
                            processing_status, error_message, chunked_processing, num_chunks,
                            detected_language, script_used,
                            translation_generated, transliteration_generated,
                            num_speakers, num_transcript_turns,
                            executive_summary_generated, pdf_dossier_downloaded,
                            email_sent, synced_google_drive, synced_google_sheets,
                            user_agent, ip_address, device_type,
                            gemini_input_tokens, gemini_output_tokens, gemini_cost_usd
                        ) VALUES (
                            %s, %s, %s, NOW(),
                            %s, %s, %s, %s,
                            %s, %s,
                            %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s,
                            %s, %s,
                            %s, %s,
                            %s, %s,
                            %s, %s, %s,
                            %s, %s, %s,
                            %s, %s, %s
                        )
                        ON CONFLICT (id) DO UPDATE SET
                            processing_end             = EXCLUDED.processing_end,
                            processing_duration_secs   = EXCLUDED.processing_duration_secs,
                            processing_status          = EXCLUDED.processing_status,
                            error_message              = EXCLUDED.error_message,
                            detected_language          = EXCLUDED.detected_language,
                            script_used                = EXCLUDED.script_used,
                            translation_generated      = EXCLUDED.translation_generated,
                            transliteration_generated  = EXCLUDED.transliteration_generated,
                            num_speakers               = EXCLUDED.num_speakers,
                            num_transcript_turns       = EXCLUDED.num_transcript_turns,
                            executive_summary_generated = EXCLUDED.executive_summary_generated,
                            pdf_dossier_downloaded     = EXCLUDED.pdf_dossier_downloaded,
                            email_sent                 = EXCLUDED.email_sent,
                            synced_google_drive        = EXCLUDED.synced_google_drive,
                            synced_google_sheets       = EXCLUDED.synced_google_sheets,
                            gemini_input_tokens        = EXCLUDED.gemini_input_tokens,
                            gemini_output_tokens       = EXCLUDED.gemini_output_tokens,
                            gemini_cost_usd            = EXCLUDED.gemini_cost_usd
                    """, (
                        m.session_id, m.user_id, m.user_email,
                        m.original_filename, m.file_size_mb, m.audio_duration_mins, m.audio_format,
                        m.input_method, m.live_recording_duration_secs,
                        m.processing_start, m.processing_end, m.processing_duration_secs,
                        m.processing_status, m.error_message, m.chunked_processing, m.num_chunks,
                        m.detected_language, m.script_used,
                        m.translation_generated, m.transliteration_generated,
                        m.num_speakers, m.num_transcript_turns,
                        m.executive_summary_generated, m.pdf_dossier_downloaded,
                        m.email_sent, m.synced_google_drive, m.synced_google_sheets,
                        m.user_agent, m.ip_address, m.device_type,
                        m.gemini_input_tokens, m.gemini_output_tokens, round(m.gemini_cost_usd, 6),
                    ))
                conn.commit()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).error(f"record_transcription failed: {exc}", exc_info=True)

    def update_export_flag(self, session_id: str, flag: str, value: bool = True) -> None:
        """Flip a single boolean export/artifact flag after the fact."""
        allowed = {
            "pdf_dossier_downloaded", "email_sent",
            "synced_google_drive", "synced_google_sheets",
            "executive_summary_generated",
        }
        if flag not in allowed:
            return
        try:
            self.ensure_schema()
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        f"UPDATE transcription_activity SET {flag} = %s WHERE id = %s",
                        (value, session_id)
                    )
                conn.commit()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(f"update_export_flag failed: {exc}")

    # ------------------------------------------------------------------
    # Admin queries
    # ------------------------------------------------------------------

    def get_dashboard_stats(self) -> dict[str, Any]:
        """Section 8 — Dashboard Metrics."""
        try:
            self.ensure_schema()
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT COUNT(*) AS n FROM app_users")
                    total_users = (cur.fetchone() or {}).get("n", 0)

                    cur.execute("""
                        SELECT COUNT(DISTINCT user_id) AS n
                        FROM auth_sessions
                        WHERE login_at >= NOW() - INTERVAL '24 hours'
                          AND revoked_at IS NULL
                    """)
                    active_users_today = (cur.fetchone() or {}).get("n", 0)

                    cur.execute("SELECT COUNT(*) AS n FROM transcription_activity")
                    total_files = (cur.fetchone() or {}).get("n", 0)

                    cur.execute("""
                        SELECT
                            COUNT(*) FILTER (WHERE processing_status = 'success') AS success_n,
                            COUNT(*) AS total_n,
                            COALESCE(SUM(audio_duration_mins), 0) AS total_audio_mins,
                            COALESCE(SUM(gemini_input_tokens), 0)  AS total_input_tokens,
                            COALESCE(SUM(gemini_output_tokens), 0) AS total_output_tokens,
                            COALESCE(SUM(gemini_cost_usd), 0)      AS total_cost_usd
                        FROM transcription_activity
                    """)
                    row = cur.fetchone() or {}
                    total_n     = row.get("total_n", 0) or 1
                    success_n   = row.get("success_n", 0)
                    success_rate = round(success_n / total_n * 100, 1)
                    failure_rate = round(100 - success_rate, 1)

            return {
                "total_users":          total_users,
                "active_users_today":   active_users_today,
                "total_files_processed": total_files,
                "success_rate_pct":     success_rate,
                "failure_rate_pct":     failure_rate,
                "total_audio_mins":     float(row.get("total_audio_mins", 0)),
                "total_gemini_input_tokens":  int(row.get("total_input_tokens", 0)),
                "total_gemini_output_tokens": int(row.get("total_output_tokens", 0)),
                "total_gemini_cost_usd": float(row.get("total_cost_usd", 0)),
            }
        except Exception as exc:
            import logging
            logging.getLogger(__name__).error(f"get_dashboard_stats failed: {exc}", exc_info=True)
            return {}

    def list_users(self, limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        """List all users with their aggregate activity stats."""
        try:
            self.ensure_schema()
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT
                            u.id, u.email, u.full_name, u.role,
                            u.affiliation, u.nationality_name,
                            u.created_at,
                            COUNT(ta.id)                               AS total_files,
                            COALESCE(SUM(ta.audio_duration_mins), 0)  AS total_audio_mins,
                            COALESCE(SUM(ta.gemini_input_tokens), 0)  AS total_input_tokens,
                            COALESCE(SUM(ta.gemini_output_tokens), 0) AS total_output_tokens,
                            COALESCE(SUM(ta.gemini_cost_usd), 0)      AS total_cost_usd,
                            MAX(ta.created_at)                         AS last_active_at,
                            MAX(s.login_at)                            AS last_login_at
                        FROM app_users u
                        LEFT JOIN transcription_activity ta
                            ON ta.user_id = u.id
                            OR (ta.user_id IS NULL AND ta.user_email = u.email)
                        LEFT JOIN auth_sessions s ON s.user_id = u.id
                        GROUP BY u.id
                        ORDER BY last_active_at DESC NULLS LAST
                        LIMIT %s OFFSET %s
                    """, (limit, offset))
                    rows = cur.fetchall()
            return [_serialize(dict(r)) for r in rows]
        except Exception as exc:
            import logging
            logging.getLogger(__name__).error(f"list_users failed: {exc}", exc_info=True)
            return []

    def list_activity(
        self,
        user_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List transcription activity records, optionally filtered by user."""
        try:
            self.ensure_schema()
            with self._connect() as conn:
                with conn.cursor() as cur:
                    if user_id:
                        cur.execute("""
                            SELECT ta.* FROM transcription_activity ta
                            LEFT JOIN app_users u ON u.id = %s
                            WHERE ta.user_id = %s
                               OR (ta.user_id IS NULL AND ta.user_email = u.email)
                            ORDER BY ta.created_at DESC
                            LIMIT %s OFFSET %s
                        """, (user_id, user_id, limit, offset))
                    else:
                        cur.execute("""
                            SELECT * FROM transcription_activity
                            ORDER BY created_at DESC
                            LIMIT %s OFFSET %s
                        """, (limit, offset))
                    rows = cur.fetchall()
            return [_serialize(dict(r)) for r in rows]
        except Exception as exc:
            import logging
            logging.getLogger(__name__).error(f"list_activity failed: {exc}", exc_info=True)
            return []

    def get_user_token_usage(self, user_id: str) -> dict[str, Any]:
        """Per-user token and cost breakdown."""
        try:
            self.ensure_schema()
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT
                            COUNT(*) AS total_sessions,
                            COALESCE(SUM(gemini_input_tokens), 0)  AS input_tokens,
                            COALESCE(SUM(gemini_output_tokens), 0) AS output_tokens,
                            COALESCE(SUM(gemini_cost_usd), 0)      AS cost_usd,
                            COALESCE(SUM(audio_duration_mins), 0)  AS audio_mins
                        FROM transcription_activity ta
                        JOIN app_users u ON u.id = %s
                        WHERE ta.user_id = u.id
                           OR (ta.user_id IS NULL AND ta.user_email = u.email)
                    """, (user_id,))
                    row = cur.fetchone() or {}
            return _serialize(dict(row))
        except Exception as exc:
            import logging
            logging.getLogger(__name__).error(f"get_user_token_usage failed: {exc}", exc_info=True)
            return {}

    def export_activity_csv(self, user_id: str | None = None) -> str:
        """Return all activity as a CSV string for admin export."""
        import csv, io
        rows = self.list_activity(user_id=user_id, limit=10_000)
        if not rows:
            return ""
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
        return buf.getvalue()