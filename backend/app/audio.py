from __future__ import annotations

import asyncio
import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

import aiofiles
from fastapi import UploadFile

from .config import Settings


@dataclass(frozen=True)
class ChunkManifest:
    chunk_id: int
    start_time: float
    end_time: float
    path: Path


ProgressCallback = Callable[[int], Awaitable[None]]


async def stream_upload_to_disk(
    upload_file: UploadFile,
    destination: Path,
    chunk_size: int,
    total_bytes: int,
    on_progress: ProgressCallback | None = None,
) -> int:
    written = 0
    async with aiofiles.open(destination, "wb") as output_stream:
        while True:
            chunk = await upload_file.read(chunk_size)
            if not chunk:
                break
            await output_stream.write(chunk)
            written += len(chunk)
            if on_progress and total_bytes > 0:
                percent = min(100, math.floor((written / total_bytes) * 100))
                await on_progress(percent)

    await upload_file.close()
    return written


def probe_duration_seconds(audio_path: Path) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(audio_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout or "{}")
    return float(payload.get("format", {}).get("duration", 0.0) or 0.0)


def normalize_audio_to_wav(input_path: Path, output_path: Path, settings: Settings) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-ac",
        str(settings.normalized_channels),
        "-ar",
        str(settings.normalized_sample_rate),
        "-vn",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    subprocess.run(command, capture_output=True, text=True, check=True)


def split_chunks(source_audio: Path, output_dir: Path, settings: Settings) -> list[ChunkManifest]:
    duration = probe_duration_seconds(source_audio)
    chunk_duration = settings.chunk_minutes * 60
    step = max(1, chunk_duration - settings.overlap_seconds)
    manifests: list[ChunkManifest] = []

    chunk_id = 1
    current_start = 0.0
    while current_start < duration:
        current_end = min(duration, current_start + chunk_duration)
        output_file = output_dir / f"chunk_{chunk_id:03d}.wav"
        command = [
            "ffmpeg",
            "-y",
            "-ss",
            str(current_start),
            "-t",
            str(max(1.0, current_end - current_start)),
            "-i",
            str(source_audio),
            "-ac",
            str(settings.normalized_channels),
            "-ar",
            str(settings.normalized_sample_rate),
            "-vn",
            "-c:a",
            "pcm_s16le",
            str(output_file),
        ]
        subprocess.run(command, capture_output=True, text=True, check=True)
        manifests.append(
            ChunkManifest(
                chunk_id=chunk_id,
                start_time=current_start,
                end_time=current_end,
                path=output_file,
            )
        )
        chunk_id += 1
        current_start += step

    return manifests


async def prepare_chunks(source_file: Path, workspace: Path, settings: Settings) -> list[ChunkManifest]:
    return await asyncio.to_thread(split_chunks, source_file, workspace / "chunks", settings)