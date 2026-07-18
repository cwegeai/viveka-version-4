from __future__ import annotations

import asyncio
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

import aiofiles
import psycopg
import redis
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .audio import stream_upload_to_disk
from .auth_repository import AuthRepository, UserRecord, verify_password
from .config import get_settings
from .events import progress_event
from .models import PipelineStage
from .pipeline import PipelineRunner
from .email_service import send_pdf_email
from .progress_store import get_progress_store
from .redis_queue import enqueue_job
from .activity_repository import ActivityRepository, TranscriptionMetrics
import hashlib


settings = get_settings()
app = FastAPI(title="Viveka Echo Backend", version="1.0.0")
progress_store = get_progress_store(settings)
auth_repository = AuthRepository(settings)
activity_repository = ActivityRepository(settings)


@dataclass
class UploadSession:
    upload_id: str
    workspace: Path
    source_path: Path
    chunks_dir: Path
    file_size_bytes: int
    filename: str
    received_bytes: int = 0
    expected_total_chunks: int | None = None
    chunk_sizes: dict[int, int] = field(default_factory=dict)


class UploadSessionStore:
    def __init__(self):
        self._lock = Lock()
        self._sessions: dict[str, UploadSession] = {}

    def create(self, temp_root: Path, filename: str, file_size_bytes: int) -> UploadSession:
        upload_id = uuid.uuid4().hex
        workspace = Path(tempfile.mkdtemp(prefix="viveka_chunked_", dir=temp_root))
        source_path = workspace / (filename or "session_audio")
        chunks_dir = workspace / "chunks"
        chunks_dir.mkdir(parents=True, exist_ok=True)
        session = UploadSession(
            upload_id=upload_id,
            workspace=workspace,
            source_path=source_path,
            chunks_dir=chunks_dir,
            file_size_bytes=file_size_bytes,
            filename=filename or "session_audio",
        )
        with self._lock:
            self._sessions[upload_id] = session
        return session

    def get(self, upload_id: str) -> UploadSession | None:
        with self._lock:
            return self._sessions.get(upload_id)

    def record_chunk(self, upload_id: str, chunk_index: int, total_chunks: int, chunk_size: int) -> UploadSession | None:
        with self._lock:
            session = self._sessions.get(upload_id)
            if session is not None:
                if session.expected_total_chunks is None:
                    session.expected_total_chunks = total_chunks
                elif session.expected_total_chunks != total_chunks:
                    raise ValueError("Chunk upload total mismatch.")

                previous_size = session.chunk_sizes.get(chunk_index, 0)
                session.chunk_sizes[chunk_index] = chunk_size
                session.received_bytes += chunk_size - previous_size
            return session

    def is_complete(self, upload_id: str) -> bool:
        with self._lock:
            session = self._sessions.get(upload_id)
            if session is None or session.expected_total_chunks is None:
                return False
            return (
                len(session.chunk_sizes) >= session.expected_total_chunks
                and session.received_bytes >= session.file_size_bytes
            )

    def pop(self, upload_id: str) -> UploadSession | None:
        with self._lock:
            return self._sessions.pop(upload_id, None)


upload_sessions = UploadSessionStore()


def _assemble_chunked_upload(session: UploadSession) -> None:
    expected_total_chunks = session.expected_total_chunks or 0
    if expected_total_chunks <= 0:
        raise ValueError("Upload session is missing chunk metadata.")

    with session.source_path.open("wb") as output_stream:
        for chunk_index in range(1, expected_total_chunks + 1):
            chunk_path = session.chunks_dir / f"{chunk_index:06d}.part"
            if not chunk_path.exists():
                raise FileNotFoundError(f"Missing chunk {chunk_index} for upload session {session.upload_id}.")
            with chunk_path.open("rb") as input_stream:
                shutil.copyfileobj(input_stream, output_stream, length=settings.upload_chunk_size_bytes)


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


class UploadInitRequest(BaseModel):
    filename: str
    file_size_bytes: int = Field(gt=0)


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
    allow_origin_regex=r"https://.*\.netlify\.app|https?://(localhost|127\.0\.0\.1)(:\d+)?",
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
async def login(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
):
    repository = _require_auth_repository()
    user = await asyncio.to_thread(repository.get_user_by_email, username)

    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    access_token = await asyncio.to_thread(repository.create_session_token, user.id)

    # Record login in activity tracking
    if settings.database_url:
        ua = request.headers.get("user-agent", "")
        ip = request.client.host if request.client else ""
        device = "mobile" if any(k in ua.lower() for k in ("mobile", "android", "iphone")) else "desktop"
        token_hash = hashlib.sha256(access_token.encode()).hexdigest()
        await asyncio.to_thread(
            activity_repository.record_login,
            token_hash,
            user_agent=ua,
            ip_address=ip,
            device_type=device,
        )

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


# @app.post("/api/send-pdf")
# async def api_send_pdf(
#     recipient_email: str = Form(...),
#     filename: str = Form(...),
#     original_filename: str = Form(default=""),
#     session_id: str = Form(...),
#     pdf: UploadFile = File(...),
#     authorization: str | None = Header(default=None),
# ):
#     await _get_current_user(authorization)
#     pdf_bytes = await pdf.read()
#     if not pdf_bytes:
#         raise HTTPException(status_code=400, detail="PDF file is empty.")
#     try:
#         await asyncio.to_thread(
#             send_pdf_email,
#             settings,
#             recipient_email,
#             pdf_bytes,
#             filename,
#             original_filename,
#         )
#         if settings.database_url:
#             await asyncio.to_thread(
#                 activity_repository.update_export_flag,
#                 session_id,
#                 "email_sent",
#                 True,
#             )
#     except RuntimeError as exc:
#         raise HTTPException(status_code=503, detail=str(exc)) from exc
#     except Exception as exc:
#         raise HTTPException(status_code=500, detail=f"Failed to send email: {exc}") from exc
#     return {"message": f"Dossier sent to {recipient_email}."}

@app.post("/api/send-pdf")
async def api_send_pdf():
    raise HTTPException(
        status_code=404,
        detail="Email feature has been disabled."
    )

@app.post("/api/uploads/init")
async def init_chunked_upload(payload: UploadInitRequest):
    session = upload_sessions.create(settings.temp_root, payload.filename, payload.file_size_bytes)
    return {
        "upload_id": session.upload_id,
        "chunk_size_bytes": settings.upload_chunk_size_bytes,
        "file_size_bytes": session.file_size_bytes,
    }


@app.post("/api/uploads/{upload_id}/chunk")
async def append_chunked_upload(
    upload_id: str,
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
    file: UploadFile = File(...),
):
    session = upload_sessions.get(upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="Upload session not found.")

    if chunk_index < 1 or total_chunks < 1 or chunk_index > total_chunks:
        raise HTTPException(status_code=400, detail="Chunk metadata is invalid.")

    chunk_path = session.chunks_dir / f"{chunk_index:06d}.part"
    written_bytes = 0
    async with aiofiles.open(chunk_path, "wb") as output_stream:
        while True:
            chunk = await file.read(settings.upload_chunk_size_bytes)
            if not chunk:
                break
            await output_stream.write(chunk)
            written_bytes += len(chunk)
    await file.close()

    try:
        updated_session = upload_sessions.record_chunk(upload_id, chunk_index, total_chunks, written_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if updated_session is None:
        raise HTTPException(status_code=404, detail="Upload session not found.")

    return {
        "upload_id": upload_id,
        "chunk_index": chunk_index,
        "total_chunks": total_chunks,
        "received_bytes": updated_session.received_bytes,
        "complete": upload_sessions.is_complete(upload_id),
    }


@app.post("/api/uploads/{upload_id}/transcribe")
async def transcribe_chunked_upload(
    upload_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
):
    session = upload_sessions.get(upload_id)
    if not session:
        raise HTTPException(status_code=404, detail="Upload session not found.")
    if not upload_sessions.is_complete(upload_id):
        raise HTTPException(status_code=400, detail="Upload is incomplete.")

    # Identify user if authenticated
    user: UserRecord | None = None
    if authorization and settings.database_url:
        try:
            user = await _get_current_user(authorization)
        except Exception:
            pass

    # Build metrics object for this session
    import os
    m = TranscriptionMetrics()
    m.user_id    = user.id    if user else None
    m.user_email = user.email if user else None
    m.original_filename = session.filename
    m.file_size_mb = round(session.file_size_bytes / 1_048_576, 3)
    m.audio_format = os.path.splitext(session.filename)[1].lstrip(".").lower()
    m.input_method = "file_upload"
    m.chunked_processing = True
    m.processing_start = _utcnow()
    ua = request.headers.get("user-agent", "")
    m.user_agent = ua
    m.ip_address = request.client.host if request.client else ""
    m.device_type = "mobile" if any(k in ua.lower() for k in ("mobile", "android", "iphone")) else "desktop"

    runner = PipelineRunner(settings)
    runner.metrics = m  # attach so pipeline + gemini can populate fields live

    async def event_stream():
        import json as _json
        try:
            yield progress_event(
                PipelineStage.uploading,
                "Chunked upload complete. Assembling audio for backend pipeline...",
                progress=20,
            )
            await asyncio.to_thread(_assemble_chunked_upload, session)
            async for event in runner.run_saved_source(session.source_path, session.file_size_bytes, session.workspace):
                yield event
            m.processing_status = "success"
        except Exception as exc:
            m.processing_status = "failed"
            m.error_message = str(exc)[:500]
            yield progress_event(PipelineStage.error, f"Pipeline failed: {exc}")
        finally:
            m.processing_end = _utcnow()
            if settings.database_url:
                await asyncio.to_thread(activity_repository.record_transcription, m)
            finalized = upload_sessions.pop(upload_id)
            if finalized:
                shutil.rmtree(finalized.workspace, ignore_errors=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


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
    runner = PipelineRunner(settings)

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
                            PipelineStage.uploading,
                            "Background queue connection lost. Falling back to inline transcription...",
                            progress=20,
                        )
                        async for event in runner.run_saved_source(source_path, file_size_bytes, workspace):
                            yield event
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
                                PipelineStage.uploading,
                                "Background worker did not start in time. Falling back to inline transcription...",
                                progress=20,
                            )
                            async for event in runner.run_saved_source(source_path, file_size_bytes, workspace):
                                yield event
                            return
                        await asyncio.sleep(settings.progress_poll_interval_seconds)

            return StreamingResponse(queued_event_stream(), media_type="text/event-stream")

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

# ═══════════════════════════════════════════════════════════════════════════
# ADMIN API — User Identity, Metrics, Activity
# ═══════════════════════════════════════════════════════════════════════════

def _require_admin(authorization: str | None) -> UserRecord:
    """Raise 403 if caller is not an admin."""
    import asyncio as _asyncio
    loop = _asyncio.get_event_loop()
    token = _extract_bearer_token(authorization)
    if not token or not settings.database_url:
        raise HTTPException(status_code=403, detail="Admin access required.")
    user = auth_repository.get_user_by_session_token(token)
    if not user or user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required.")
    return user

@app.get("/api/my-activity")
async def my_activity(
    limit: int = 50,
    authorization: str | None = Header(default=None),
):
    """Return the current user's own transcription activity history."""
    token = _extract_bearer_token(authorization)
    if not token or not settings.database_url:
        raise HTTPException(status_code=401, detail="Authentication required.")
    user = await asyncio.to_thread(auth_repository.get_user_by_session_token, token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid session.")
    rows = await asyncio.to_thread(
        activity_repository.list_activity, user.id, limit, 0
    )
    return JSONResponse({"activity": rows, "count": len(rows)})

@app.get("/api/admin/dashboard")
async def admin_dashboard(authorization: str | None = Header(default=None)):
    """Section 8 — Dashboard Metrics."""
    _require_admin(authorization)
    stats = await asyncio.to_thread(activity_repository.get_dashboard_stats)
    return JSONResponse(stats)


@app.get("/api/admin/users")
async def admin_list_users(
    limit: int = 100,
    offset: int = 0,
    authorization: str | None = Header(default=None),
):
    """Section 1 — User Identity + aggregate stats."""
    _require_admin(authorization)
    users = await asyncio.to_thread(activity_repository.list_users, limit, offset)
    return JSONResponse({"users": users, "count": len(users)})


@app.get("/api/admin/users/{user_id}/tokens")
async def admin_user_tokens(
    user_id: str,
    authorization: str | None = Header(default=None),
):
    """Per-user Gemini token usage and cost."""
    _require_admin(authorization)
    usage = await asyncio.to_thread(activity_repository.get_user_token_usage, user_id)
    return JSONResponse(usage)


@app.get("/api/admin/activity")
async def admin_activity(
    user_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
    authorization: str | None = Header(default=None),
):
    """Sections 2-7 — Full activity log with all schema fields."""
    _require_admin(authorization)
    rows = await asyncio.to_thread(activity_repository.list_activity, user_id, limit, offset)
    return JSONResponse({"activity": rows, "count": len(rows)})


@app.get("/api/admin/activity/export")
async def admin_export_csv(
    user_id: str | None = None,
    authorization: str | None = Header(default=None),
):
    """Export activity log as CSV (Section 6 — Admin activity report exported)."""
    _require_admin(authorization)
    csv_data = await asyncio.to_thread(activity_repository.export_activity_csv, user_id)
    from fastapi.responses import Response
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=viveka_activity.csv"},
    )


@app.post("/api/admin/activity/{session_id}/flag")
async def admin_flag_export(
    session_id: str,
    flag: str,
    value: bool = True,
    authorization: str | None = Header(default=None),
):
    """Update a single export/artifact boolean flag on an activity record."""
    await _get_current_user(authorization)
    await asyncio.to_thread(activity_repository.update_export_flag, session_id, flag, value)
    return JSONResponse({"ok": True})
