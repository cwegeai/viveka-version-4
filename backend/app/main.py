from __future__ import annotations

import asyncio
import shutil
import tempfile
import time
import uuid
from pathlib import Path

import psycopg
import redis
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .audio import stream_upload_to_disk
from .auth_repository import AuthRepository, UserRecord, verify_password
from .config import get_settings
from .events import progress_event
from .models import PipelineStage
from .pipeline import PipelineRunner
from .progress_store import get_progress_store
from .redis_queue import enqueue_job


settings = get_settings()
app = FastAPI(title="Viveka Echo Backend", version="1.0.0")
progress_store = get_progress_store(settings)
auth_repository = AuthRepository(settings)


class RegisterRequest(BaseModel):
    full_name: str
    email: str
    password: str = Field(min_length=8)
    affiliation: str | None = None
    nationality_code: str | None = None
    nationality_name: str | None = None


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8)


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


def _require_auth_repository() -> AuthRepository:
    if not settings.database_url:
        raise HTTPException(status_code=503, detail="Authentication database is not configured.")
    return auth_repository


async def _get_current_user(authorization: str | None) -> UserRecord:
    token = _extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header.")

    repository = _require_auth_repository()
    user = await asyncio.to_thread(repository.get_user_by_session_token, token)
    if not user:
        raise HTTPException(status_code=401, detail="Session expired or invalid token.")
    return user

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> JSONResponse:
    return JSONResponse(
        {
            "service": "Viveka Echo Backend",
            "status": "ok",
            "health": "/healthz",
            "docs": "/docs",
        }
    )


@app.get("/favicon.ico", status_code=204)
async def favicon() -> JSONResponse:
    return JSONResponse(status_code=204, content=None)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.on_event("startup")
async def startup() -> None:
    return None


@app.post("/api/v1/auth/register")
@app.post("/auth/register")
async def register(payload: RegisterRequest):
    repository = _require_auth_repository()

    try:
        user = await asyncio.to_thread(
            repository.register_user,
            email=payload.email,
            full_name=payload.full_name,
            password=payload.password,
            affiliation=payload.affiliation,
            nationality_code=payload.nationality_code,
            nationality_name=payload.nationality_name,
        )
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    except Exception as exc:
        if "duplicate key" in str(exc).lower() or "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail="An account with this email already exists.")
        raise

    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "roles": [user.role],
    }


@app.post("/api/v1/auth/login")
@app.post("/auth/login")
async def login(username: str = Form(...), password: str = Form(...)):
    repository = _require_auth_repository()
    user = await asyncio.to_thread(repository.get_user_by_email, username)

    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    access_token = await asyncio.to_thread(repository.create_session_token, user.id)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "roles": [user.role],
        "full_name": user.full_name,
        "affiliation": user.affiliation,
        "nationality_name": user.nationality_name,
    }


@app.post("/api/v1/auth/logout")
@app.post("/auth/logout")
async def logout(authorization: str | None = Header(default=None)):
    token = _extract_bearer_token(authorization)
    if token and settings.database_url:
        await asyncio.to_thread(auth_repository.revoke_session_token, token)
    return {"message": "Logged out successfully."}


@app.post("/api/v1/auth/forgot-password")
@app.post("/auth/forgot-password")
async def forgot_password(payload: ForgotPasswordRequest):
    repository = _require_auth_repository()
    generic_response = {
        "message": "If an account exists for this email, a password reset token has been generated."
    }

    user = await asyncio.to_thread(repository.get_user_by_email, payload.email)
    if not user:
        return generic_response

    reset_token, expires_minutes = await asyncio.to_thread(repository.create_password_reset_token, user.id)
    if settings.auth_expose_reset_token:
        return {
            **generic_response,
            "reset_token": reset_token,
            "expires_minutes": expires_minutes,
        }

    return generic_response


@app.post("/api/v1/auth/reset-password")
@app.post("/auth/reset-password")
async def reset_password(payload: ResetPasswordRequest):
    repository = _require_auth_repository()
    updated = await asyncio.to_thread(repository.reset_password, payload.token, payload.new_password)
    if not updated:
        raise HTTPException(status_code=400, detail="Reset token is invalid or expired.")
    return {"message": "Password updated successfully."}


@app.get("/api/v1/auth/me")
@app.get("/auth/me")
async def auth_me(authorization: str | None = Header(default=None)):
    user = await _get_current_user(authorization)
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "roles": [user.role],
        "affiliation": user.affiliation,
        "nationality_name": user.nationality_name,
    }


def _supports_background_jobs(file_size_bytes: int) -> bool:
    return (
        settings.background_jobs_enabled
        and bool(settings.redis_url)
        and file_size_bytes >= settings.background_job_min_bytes
        and file_size_bytes <= settings.background_job_max_bytes
    )


def _is_terminal_event(event_payload: str) -> bool:
    return "event: complete" in event_payload or "event: error" in event_payload


def _background_queue_stalled(
    saw_worker_event: bool,
    stream_started: float,
    last_event_at: float,
    now: float,
    start_timeout_seconds: int,
) -> bool:
    if not saw_worker_event:
        return now - stream_started >= start_timeout_seconds
    idle_timeout_seconds = max(start_timeout_seconds * 4, 60)
    return now - last_event_at >= idle_timeout_seconds


@app.post("/api/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    file_size_bytes: int = Form(...),
):
    workspace = Path(tempfile.mkdtemp(prefix="viveka_http_", dir=settings.temp_root))
    source_path = workspace / (file.filename or "session_audio")
    (workspace / "chunks").mkdir(parents=True, exist_ok=True)

    written = await stream_upload_to_disk(
        file,
        source_path,
        settings.upload_chunk_size_bytes,
        file_size_bytes,
    )

    if written == 0:
        shutil.rmtree(workspace, ignore_errors=True)
        return JSONResponse({"error": "Uploaded file was empty."}, status_code=400)

    queue_fallback_message: str | None = None

    if _supports_background_jobs(file_size_bytes):
        job_id = uuid.uuid4().hex
        try:
            await asyncio.to_thread(progress_store.clear_job, job_id)
            await asyncio.to_thread(
                enqueue_job,
                settings,
                job_id,
                str(source_path),
                file_size_bytes,
                str(workspace),
                file.filename or "session_audio",
            )
        except Exception:
            queue_fallback_message = "Background queue unavailable. Running inline transcription instead."
        else:

            async def queued_event_stream():
                yield progress_event(PipelineStage.uploading, "Upload complete. Background job queued...", progress=20)

                offset = 0
                stream_started = time.monotonic()
                last_event_at = stream_started
                saw_worker_event = False

                while True:
                    try:
                        pending_events = await asyncio.to_thread(progress_store.read_events, job_id, offset)
                    except redis.RedisError:
                        yield progress_event(
                            PipelineStage.error,
                            "Background queue connection lost. Retry the upload; this backend is configured to run inline processing by default.",
                        )
                        return
                    if pending_events:
                        saw_worker_event = True
                        last_event_at = time.monotonic()
                        offset += len(pending_events)
                        for pending_event in pending_events:
                            yield pending_event
                            if _is_terminal_event(pending_event):
                                return
                    else:
                        now = time.monotonic()
                        if _background_queue_stalled(
                            saw_worker_event,
                            stream_started,
                            last_event_at,
                            now,
                            settings.background_job_start_timeout_seconds,
                        ):
                            yield progress_event(
                                PipelineStage.error,
                                "Background queue stalled before completion. Retry the upload; this backend is configured to use inline processing by default.",
                            )
                            return
                        await asyncio.sleep(settings.progress_poll_interval_seconds)

            return StreamingResponse(queued_event_stream(), media_type="text/event-stream")

    runner = PipelineRunner(settings)

    async def event_stream():
        try:
            yield progress_event(
                PipelineStage.uploading,
                queue_fallback_message or "Upload complete. Starting backend pipeline...",
                progress=20,
            )
            async for event in runner.run_saved_source(source_path, file_size_bytes, workspace):
                yield event
        except Exception as exc:
            yield progress_event(PipelineStage.error, f"Pipeline failed: {exc}")
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")