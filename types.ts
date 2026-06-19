
export interface SpeakerTurn {
  speaker: string;
  original: string;
  transliterated: string;
  translated: string;
  mu_id: string;
  timestamp: string;
  start_time_seconds?: number;
  end_time_seconds?: number;
  duration_seconds?: number;
  confidence?: number;
  language?: string;
  languages?: string[];
  words?: TranscriptWord[];
  language_metadata?: Record<string, unknown>;
}

export interface TranscriptWord {
  word: string;
  punctuated_word?: string;
  start_time: number;
  end_time: number;
  confidence?: number;
  speaker?: string;
  language?: string;
  language_metadata?: Record<string, unknown>;
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
  start_time: number;
  end_time: number;
  confidence?: number;
  language?: string;
  languages?: string[];
  words?: TranscriptWord[];
  language_metadata?: Record<string, unknown>;
}

export interface ChunkTranscript {
  chunk_id: number;
  start_time: number;
  end_time: number;
  transcript: string;
  language: string;
  detected_language?: string;
  languages?: string[];
  confidence?: number;
  words?: TranscriptWord[];
  language_metadata?: Record<string, unknown>;
  speakers: TranscriptSegment[];
  error?: string;
}

export interface ChunkSummary {
  chunk_id: number;
  text: string;
}

export interface EvidenceMatrixRow {
  dimension: string;
  domain: string;
  evidence: string;
  reasoning: string;
}

export interface ContextMatrixRow {
  contextLevel: string;
  domain: string;
  finding: string;
}

export interface MechanismChain {
  chain_id: string;
  pathway: string;
  impacts: string;
}

export interface HotspotItem {
  vulnerable: string;
  drivers: string;
}

export interface SmartStrategy {
  strategy: string;
  indicator: string;
}

export interface TranscriptionResult {
  turns: SpeakerTurn[];
  executiveSynthesis: ChunkSummary[];
  summary: string;
  keyPoints: string[];
  artifact1_evidence: EvidenceMatrixRow[];
  artifact2_context: ContextMatrixRow[];
  artifact3_chains: MechanismChain[];
  artifact4_link_map: string;
  artifact5_hotspots: HotspotItem[];
  strategies: SmartStrategy[];
  detected_language?: string;
  languages?: string[];
  language_metadata?: Record<string, unknown>;
  chunk_results?: ChunkTranscript[];
}
