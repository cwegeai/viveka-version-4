"""HTTP endpoints only. All real work is done in /services."""
import asyncio
import base64
import io
import json
import logging
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from core.config import BATCH_CHAR_LIMIT, CODEBOOK, MAX_CONCURRENT_GEMINI_BATCHES
from services.file_service import (
    DOCX_MEDIA_TYPE,
    XLSX_MEDIA_TYPE,
    build_docx_bytes,
    build_output_filename,
    build_xlsx_bytes,
    read_input_file,
)
from services.processing_service import process_segments

logger = logging.getLogger("api")

router = APIRouter()


def _content_disposition(filename: str) -> str:
    """Header that also works for non-English file names."""
    ascii_name = filename.encode("ascii", "ignore").decode().replace('"', "") or "prism_coded"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def _file_response(content: bytes, media_type: str, filename: str) -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(content),
        media_type=media_type,
        headers={"Content-Disposition": _content_disposition(filename)},
    )


@router.get("/health")
def health():
    return {
        "status": "ok",
        "codes": len(CODEBOOK),
        "batch_char_limit": BATCH_CHAR_LIMIT,
        "max_concurrent_batches": MAX_CONCURRENT_GEMINI_BATCHES,
    }


@router.post("/api/code")
async def code_interview_file(
    file: UploadFile = File(...),
    format: Literal["xlsx", "docx", "both"] = "xlsx",
):
    """
    format=xlsx  -> colored Excel file          (default)
    format=docx  -> Word file
    format=both  -> JSON {"excel": <base64>, "word": <base64>}  (one Gemini run, two files)
    """
    logger.info("File received: %s (format=%s)", file.filename, format)

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    rows = read_input_file(file.filename or "", raw)

    try:
        output = await process_segments(rows)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Batch processing failed")
        raise HTTPException(status_code=502, detail=str(e))

    if format == "docx":
        return _file_response(
            build_docx_bytes(output), DOCX_MEDIA_TYPE, build_output_filename(file.filename or "", "docx")
        )

    if format == "both":
        return JSONResponse(
            {
                "excel": base64.b64encode(build_xlsx_bytes(output)).decode("ascii"),
                "word": base64.b64encode(build_docx_bytes(output)).decode("ascii"),
            }
        )

    return _file_response(
        build_xlsx_bytes(output), XLSX_MEDIA_TYPE, build_output_filename(file.filename or "", "xlsx")
    )


@router.post("/api/code/stream")
async def code_interview_file_stream(file: UploadFile = File(...)):
    """
    Same work as /api/code?format=both, but the reply is a live stream (one JSON object per line):
      {"type":"start", total_batches, total_segments, max_parallel, batches:[...]}
      {"type":"batch", batch, status:"running"|"done"|"failed", pending, running, completed, failed, total}
      {"type":"finalizing"}
      {"type":"done", "excel": <base64>, "word": <base64>}      or      {"type":"error", "detail": "..."}
    A bad file is rejected up front with a normal 400 error, before the stream starts.
    """
    logger.info("File received (stream): %s", file.filename)

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    rows = read_input_file(file.filename or "", raw)
    queue: asyncio.Queue = asyncio.Queue()

    async def work() -> None:
        try:
            output = await process_segments(rows, on_progress=queue.put_nowait)
            queue.put_nowait({"type": "finalizing"})
            excel = await asyncio.to_thread(build_xlsx_bytes, output)
            word = await asyncio.to_thread(build_docx_bytes, output)
            queue.put_nowait(
                {
                    "type": "done",
                    "excel": base64.b64encode(excel).decode("ascii"),
                    "word": base64.b64encode(word).decode("ascii"),
                }
            )
        except asyncio.CancelledError:
            raise
        except HTTPException as e:
            queue.put_nowait({"type": "error", "detail": str(e.detail)})
        except Exception as e:
            logger.exception("Batch processing failed")
            queue.put_nowait({"type": "error", "detail": str(e)})
        finally:
            queue.put_nowait(None)  # end of stream

    async def events():
        task = asyncio.create_task(work())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield json.dumps(event) + "\n"
        finally:
            task.cancel()  # does nothing if finished; stops the work if the browser disconnected

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )