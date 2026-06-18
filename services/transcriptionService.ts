import { TranscriptionResult } from "../types";
import { TRANSCRIPTION_API_URL } from "./config";

type PipelineEventPayload = {
  stage?: string;
  message?: string;
  progress?: number;
  result?: Partial<TranscriptionResult>;
};

const parseEventBlocks = (buffer: string) => {
  const blocks = buffer.split("\n\n");
  const remainder = blocks.pop() || "";

  const events = blocks
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (!data) {
        return null;
      }

      try {
        return { event, payload: JSON.parse(data) as PipelineEventPayload };
      } catch {
        return null;
      }
    })
    .filter((value): value is { event: string; payload: PipelineEventPayload } => value !== null);

  return { events, remainder };
};

const normalizeBackendResult = (result?: Partial<TranscriptionResult>): TranscriptionResult => ({
  turns: result?.turns || [],
  executiveSynthesis: result?.executiveSynthesis || [],
  summary: result?.summary || "",
  keyPoints: result?.keyPoints || [],
  artifact1_evidence: result?.artifact1_evidence || [],
  artifact2_context: result?.artifact2_context || [],
  artifact3_chains: result?.artifact3_chains || [],
  artifact4_link_map: result?.artifact4_link_map || "Master Research Database Link Verified",
  artifact5_hotspots: result?.artifact5_hotspots || [],
  strategies: result?.strategies || [],
  detected_language: result?.detected_language,
  languages: result?.languages || [],
  language_metadata: result?.language_metadata || {},
  chunk_results: result?.chunk_results || [],
});

export const transcribeAudio = async (
  audioFile: File,
  _mimeType: string,
  onStatusChange: (status: string, progress?: number) => void,
  onPartialResult?: (result: TranscriptionResult) => void,
  signal?: AbortSignal
): Promise<TranscriptionResult> => {
  onStatusChange("Connecting to Deepgram + Gemini backend...", 5);

  const formData = new FormData();
  formData.append("file", audioFile);
  formData.append("file_size_bytes", String(audioFile.size));

  const response = await fetch(`${TRANSCRIPTION_API_URL}/api/transcribe`, {
    method: "POST",
    body: formData,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Backend transcription failed: ${response.status} ${errorText}`.trim());
  }

  if (!response.body) {
    throw new Error("Backend transcription stream was unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: TranscriptionResult | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseEventBlocks(buffer);
      buffer = remainder;

      for (const event of events) {
        if (event.payload.message) {
          onStatusChange(event.payload.message, event.payload.progress);
        }

        if (event.event === "error") {
          throw new Error(event.payload.message || "Backend transcription failed.");
        }

        if (event.event === "result" && event.payload.result) {
          onPartialResult?.(normalizeBackendResult(event.payload.result));
        }

        if (event.event === "complete" && event.payload.result) {
          finalResult = normalizeBackendResult(event.payload.result);
        }
      }
    }
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }
    console.error("Transcription pipeline error:", error);
    throw new Error(`Viveka Analysis Failure: ${error.message}`);
  } finally {
    reader.releaseLock();
  }

  if (!finalResult) {
    throw new Error("Backend transcription completed without a final result.");
  }

  onStatusChange("Dossier synced from backend pipeline.", 100);
  return finalResult;
};
