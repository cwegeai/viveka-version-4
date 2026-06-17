
export interface SpeakerTurn {
  speaker: string;
  original: string;
  transliterated: string;
  translated: string;
  mu_id: string;
  timestamp: string;
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
}
