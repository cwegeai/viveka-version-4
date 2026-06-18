from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

from .config import Settings


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    iterations = 200_000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, encoded_hash: str) -> bool:
    try:
        algorithm, iterations_str, salt_b64, digest_b64 = encoded_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_str)
        salt = base64.urlsafe_b64decode(salt_b64.encode("ascii"))
        expected_digest = base64.urlsafe_b64decode(digest_b64.encode("ascii"))
    except Exception:
        return False

    provided_digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(provided_digest, expected_digest)


@dataclass(frozen=True)
class UserRecord:
    id: str
    email: str
    full_name: str
    role: str
    affiliation: str | None
    nationality_code: str | None
    nationality_name: str | None
    password_hash: str


class AuthRepository:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_initialized = False

    def _connect(self):
        if not self.settings.database_url:
            raise RuntimeError("DATABASE_URL is required for authentication")
        return psycopg.connect(self.settings.database_url, row_factory=dict_row)

    def ensure_schema(self) -> None:
        if self._schema_initialized:
            return

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = 5000")
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_users (
                        id TEXT PRIMARY KEY,
                        email TEXT UNIQUE NOT NULL,
                        full_name TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        role TEXT NOT NULL DEFAULT 'user',
                        affiliation TEXT,
                        nationality_code TEXT,
                        nationality_name TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS auth_sessions (
                        id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                        token_hash TEXT UNIQUE NOT NULL,
                        expires_at TIMESTAMPTZ NOT NULL,
                        revoked_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS password_reset_tokens (
                        id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                        token_hash TEXT UNIQUE NOT NULL,
                        expires_at TIMESTAMPTZ NOT NULL,
                        used_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
            connection.commit()

        self._schema_initialized = True

    def register_user(
        self,
        *,
        email: str,
        full_name: str,
        password: str,
        affiliation: str | None,
        nationality_code: str | None,
        nationality_name: str | None,
    ) -> UserRecord:
        self.ensure_schema()
        normalized_email = email.strip().lower()
        role = "admin" if normalized_email in self.settings.admin_emails else "user"
        record_id = uuid.uuid4().hex
        password_hash = hash_password(password)

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO app_users (
                        id,
                        email,
                        full_name,
                        password_hash,
                        role,
                        affiliation,
                        nationality_code,
                        nationality_name
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        record_id,
                        normalized_email,
                        full_name.strip(),
                        password_hash,
                        role,
                        affiliation,
                        nationality_code,
                        nationality_name,
                    ),
                )
            connection.commit()

        return UserRecord(
            id=record_id,
            email=normalized_email,
            full_name=full_name.strip(),
            role=role,
            affiliation=affiliation,
            nationality_code=nationality_code,
            nationality_name=nationality_name,
            password_hash=password_hash,
        )

    def get_user_by_email(self, email: str) -> UserRecord | None:
        self.ensure_schema()
        normalized_email = email.strip().lower()

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, email, full_name, role, affiliation, nationality_code, nationality_name, password_hash
                    FROM app_users
                    WHERE email = %s
                    """,
                    (normalized_email,),
                )
                row = cursor.fetchone()

        if not row:
            return None

        return UserRecord(**row)

    def get_user_by_session_token(self, token: str) -> UserRecord | None:
        self.ensure_schema()
        token_hash = _sha256_hex(token)

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT u.id, u.email, u.full_name, u.role, u.affiliation, u.nationality_code, u.nationality_name, u.password_hash
                    FROM auth_sessions s
                    JOIN app_users u ON u.id = s.user_id
                    WHERE s.token_hash = %s
                      AND s.revoked_at IS NULL
                      AND s.expires_at > NOW()
                    LIMIT 1
                    """,
                    (token_hash,),
                )
                row = cursor.fetchone()

        if not row:
            return None

        return UserRecord(**row)

    def create_session_token(self, user_id: str) -> str:
        self.ensure_schema()
        token = secrets.token_urlsafe(48)
        token_hash = _sha256_hex(token)
        expires_at = _utcnow() + timedelta(hours=self.settings.auth_session_hours)

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (uuid.uuid4().hex, user_id, token_hash, expires_at),
                )
            connection.commit()

        return token

    def revoke_session_token(self, token: str) -> None:
        self.ensure_schema()
        token_hash = _sha256_hex(token)

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE auth_sessions
                    SET revoked_at = NOW()
                    WHERE token_hash = %s AND revoked_at IS NULL
                    """,
                    (token_hash,),
                )
            connection.commit()

    def create_password_reset_token(self, user_id: str) -> tuple[str, int]:
        self.ensure_schema()
        raw_token = secrets.token_urlsafe(40)
        token_hash = _sha256_hex(raw_token)
        expires_minutes = self.settings.password_reset_token_minutes
        expires_at = _utcnow() + timedelta(minutes=expires_minutes)

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE password_reset_tokens
                    SET used_at = NOW()
                    WHERE user_id = %s AND used_at IS NULL
                    """,
                    (user_id,),
                )
                cursor.execute(
                    """
                    INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (uuid.uuid4().hex, user_id, token_hash, expires_at),
                )
            connection.commit()

        return raw_token, expires_minutes

    def reset_password(self, raw_token: str, new_password: str) -> bool:
        self.ensure_schema()
        token_hash = _sha256_hex(raw_token)
        new_hash = hash_password(new_password)

        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT user_id
                    FROM password_reset_tokens
                    WHERE token_hash = %s
                      AND used_at IS NULL
                      AND expires_at > NOW()
                    """,
                    (token_hash,),
                )
                row = cursor.fetchone()
                if not row:
                    return False

                user_id = row["user_id"]

                cursor.execute(
                    """
                    UPDATE app_users
                    SET password_hash = %s,
                        updated_at = NOW()
                    WHERE id = %s
                    """,
                    (new_hash, user_id),
                )
                cursor.execute(
                    """
                    UPDATE password_reset_tokens
                    SET used_at = NOW()
                    WHERE token_hash = %s
                    """,
                    (token_hash,),
                )
                cursor.execute(
                    """
                    UPDATE auth_sessions
                    SET revoked_at = NOW()
                    WHERE user_id = %s AND revoked_at IS NULL
                    """,
                    (user_id,),
                )
            connection.commit()

        return True
