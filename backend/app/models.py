from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class PipelineStage(str, Enum):
    uploading = "uploading"
    splitting = "splitting"
    chunk_upload = "chunk_upload"
    transcribing = "transcribing"
    chunk_complete = "chunk_complete"
    merging = "merging"
    result = "result"
    artifact_generation = "artifact_generation"
    complete = "complete"
    error = "error"


class JobStatus(str, Enum):
    queued = "queued"
    processing = "processing"
    complete = "complete"
    error = "error"


class ProgressEvent(BaseModel):
    stage: PipelineStage
    message: str
    progress: Optional[int] = None
    chunk_index: Optional[int] = None
    total_chunks: Optional[int] = None


class TranscriptWord(BaseModel):
    word: str = ""
    punctuated_word: Optional[str] = None
    start_time: float = 0.0
    end_time: float = 0.0
    confidence: Optional[float] = None
    speaker: Optional[str] = None
    language: Optional[str] = None
    language_metadata: dict[str, Any] = Field(default_factory=dict)


class SpeakerSegment(BaseModel):
    speaker: str = "Speaker 1"
    text: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    confidence: Optional[float] = None
    language: Optional[str] = None
    languages: list[str] = Field(default_factory=list)
    words: list[TranscriptWord] = Field(default_factory=list)
    language_metadata: dict[str, Any] = Field(default_factory=dict)


class ChunkTranscript(BaseModel):
    chunk_id: int
    start_time: float
    end_time: float
    transcript: str
    language: str = "unknown"
    detected_language: Optional[str] = None
    languages: list[str] = Field(default_factory=list)
    confidence: Optional[float] = None
    words: list[TranscriptWord] = Field(default_factory=list)
    language_metadata: dict[str, Any] = Field(default_factory=dict)
    speakers: list[SpeakerSegment] = Field(default_factory=list)
    error: Optional[str] = None


class MergedTranscript(BaseModel):
    transcript: str
    language: str = "unknown"
    detected_language: Optional[str] = None
    languages: list[str] = Field(default_factory=list)
    confidence: Optional[float] = None
    words: list[TranscriptWord] = Field(default_factory=list)
    language_metadata: dict[str, Any] = Field(default_factory=dict)
    speakers: list[SpeakerSegment] = Field(default_factory=list)
    chunk_results: list[ChunkTranscript] = Field(default_factory=list)


class TranscriptTurn(BaseModel):
    speaker: str
    original: str
    transliterated: str
    translated: str
    mu_id: str
    timestamp: str
    language: Optional[str] = None
    languages: list[str] = Field(default_factory=list)
    words: list[TranscriptWord] = Field(default_factory=list)
    language_metadata: dict[str, Any] = Field(default_factory=dict)


class ChunkSummary(BaseModel):
    chunk_id: int
    text: str


class EvidenceMatrixRow(BaseModel):
    dimension: str = ""
    domain: str = ""
    evidence: str = ""
    reasoning: str = ""


class ContextMatrixRow(BaseModel):
    contextLevel: str = ""
    domain: str = ""
    finding: str = ""


class MechanismChain(BaseModel):
    chain_id: str = ""
    pathway: str = ""
    impacts: str = ""


class HotspotItem(BaseModel):
    vulnerable: str = ""
    drivers: str = ""


class SmartStrategy(BaseModel):
    strategy: str = ""
    indicator: str = ""


class FinalResult(BaseModel):
    turns: list[TranscriptTurn] = Field(default_factory=list)
    executiveSynthesis: list[ChunkSummary] = Field(default_factory=list)
    summary: str = ""
    keyPoints: list[str] = Field(default_factory=list)
    artifact1_evidence: list[EvidenceMatrixRow] = Field(default_factory=list)
    artifact2_context: list[ContextMatrixRow] = Field(default_factory=list)
    artifact3_chains: list[MechanismChain] = Field(default_factory=list)
    artifact4_link_map: str = "Master Research Database Link Verified"
    artifact5_hotspots: list[HotspotItem] = Field(default_factory=list)
    strategies: list[SmartStrategy] = Field(default_factory=list)
    detected_language: str = "unknown"
    languages: list[str] = Field(default_factory=list)
    language_metadata: dict[str, Any] = Field(default_factory=dict)
    chunk_results: list[ChunkTranscript] = Field(default_factory=list)