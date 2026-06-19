import { TranscriptionResult } from "../types";
import { TRANSCRIPTION_API_URL } from "./config";

const CHUNKED_UPLOAD_THRESHOLD_BYTES = 0;

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

const consumeSseResponse = async (
  response: Response,
  onStatusChange: (status: string, progress?: number) => void,
  onPartialResult?: (result: TranscriptionResult) => void,
): Promise<TranscriptionResult> => {
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
  } finally {
    reader.releaseLock();
  }

  if (!finalResult) {
    throw new Error("Backend transcription completed without a final result.");
  }

  onStatusChange("Dossier synced from backend pipeline.", 100);
  return finalResult;
};

const uploadChunkedAudio = async (
  audioFile: File,
  onStatusChange: (status: string, progress?: number) => void,
  onPartialResult?: (result: TranscriptionResult) => void,
  signal?: AbortSignal,
): Promise<TranscriptionResult> => {
  onStatusChange("Starting chunked upload session...", 5);

  const initResponse = await fetch(`${TRANSCRIPTION_API_URL}/api/uploads/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: audioFile.name,
      file_size_bytes: audioFile.size,
    }),
    signal,
  });

  if (!initResponse.ok) {
    const errorText = await initResponse.text().catch(() => "");
    throw new Error(`Failed to initialize upload session: ${initResponse.status} ${errorText}`.trim());
  }

  const initPayload = await initResponse.json();
  const uploadId = String(initPayload.upload_id || "");
  const chunkSizeBytes = Number(initPayload.chunk_size_bytes || 8 * 1024 * 1024);
  const totalChunks = Math.max(1, Math.ceil(audioFile.size / chunkSizeBytes));

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const start = chunkIndex * chunkSizeBytes;
    const end = Math.min(audioFile.size, start + chunkSizeBytes);
    const chunk = audioFile.slice(start, end);
    const chunkFormData = new FormData();
    chunkFormData.append("file", chunk, `${audioFile.name}.part${chunkIndex + 1}`);
    chunkFormData.append("chunk_index", String(chunkIndex + 1));
    chunkFormData.append("total_chunks", String(totalChunks));

    const response = await fetch(`${TRANSCRIPTION_API_URL}/api/uploads/${uploadId}/chunk`, {
      method: "POST",
      body: chunkFormData,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Chunk upload failed: ${response.status} ${errorText}`.trim());
    }

    const percent = Math.max(1, Math.min(100, Math.round((end / audioFile.size) * 100)));
    const mappedProgress = Math.max(5, Math.min(19, Math.round((percent / 100) * 19)));
    onStatusChange(`Uploading chunk ${chunkIndex + 1}/${totalChunks}... ${percent}%`, mappedProgress);
  }

  onStatusChange("Upload complete. Waiting for backend transcription events...", 20);
  const transcribeResponse = await fetch(`${TRANSCRIPTION_API_URL}/api/uploads/${uploadId}/transcribe`, {
    method: "POST",
    signal,
  });
  return consumeSseResponse(transcribeResponse, onStatusChange, onPartialResult);
};

export const transcribeAudio = async (
  audioFile: File,
  _mimeType: string,
  onStatusChange: (status: string, progress?: number) => void,
  onPartialResult?: (result: TranscriptionResult) => void,
  signal?: AbortSignal
): Promise<TranscriptionResult> => {
  if (audioFile.size >= CHUNKED_UPLOAD_THRESHOLD_BYTES) {
    try {
      return await uploadChunkedAudio(audioFile, onStatusChange, onPartialResult, signal);
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw error;
      }
      console.error("Chunked upload pipeline error:", error);
      throw new Error(`Viveka Analysis Failure: ${error.message}`);
    }
  }

  onStatusChange("Uploading file to backend. Larger files may take time before transcription starts...", 5);

  const formData = new FormData();
  formData.append("file", audioFile);
  formData.append("file_size_bytes", String(audioFile.size));

  return await new Promise<TranscriptionResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let buffer = "";
    let processedLength = 0;
    let finalResult: TranscriptionResult | null = null;
    let uploadCompleted = false;
    let settled = false;

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const resolveOnce = (result: TranscriptionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const processSseBuffer = () => {
      const nextChunk = xhr.responseText.slice(processedLength);
      processedLength = xhr.responseText.length;
      if (!nextChunk) {
        return;
      }

      buffer += nextChunk;
      const { events, remainder } = parseEventBlocks(buffer);
      buffer = remainder;

      for (const event of events) {
        if (event.payload.message) {
          onStatusChange(event.payload.message, event.payload.progress);
        }

        if (event.event === "error") {
          rejectOnce(new Error(event.payload.message || "Backend transcription failed."));
          return;
        }

        if (event.event === "result" && event.payload.result) {
          onPartialResult?.(normalizeBackendResult(event.payload.result));
        }

        if (event.event === "complete" && event.payload.result) {
          finalResult = normalizeBackendResult(event.payload.result);
        }
      }
    };

    xhr.open("POST", `${TRANSCRIPTION_API_URL}/api/transcribe`, true);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || uploadCompleted) {
        return;
      }

      const percent = Math.max(1, Math.min(100, Math.round((event.loaded / event.total) * 100)));
      const mappedProgress = Math.max(5, Math.min(19, Math.round((percent / 100) * 19)));
      onStatusChange(`Uploading to backend... ${percent}%`, mappedProgress);
    };

    xhr.onreadystatechange = () => {
      if (xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED && !uploadCompleted) {
        uploadCompleted = true;
        onStatusChange("Upload complete. Waiting for backend transcription events...", 20);
      }
    };

    xhr.onprogress = () => {
      processSseBuffer();
    };

    xhr.onerror = () => {
      rejectOnce(new Error("Network error while contacting backend transcription service."));
    };

    xhr.onabort = () => {
      const abortError = new Error("The transcription request was aborted.") as Error & { name?: string };
      abortError.name = "AbortError";
      rejectOnce(abortError);
    };

    xhr.onload = () => {
      processSseBuffer();

      if (xhr.status < 200 || xhr.status >= 300) {
        rejectOnce(new Error(`Backend transcription failed: ${xhr.status} ${xhr.responseText}`.trim()));
        return;
      }

      if (!finalResult) {
        rejectOnce(new Error("Backend transcription completed without a final result."));
        return;
      }

      onStatusChange("Dossier synced from backend pipeline.", 100);
      resolveOnce(finalResult);
    };

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          xhr.abort();
        },
        { once: true }
      );
    }

    xhr.send(formData);
  }).catch((error: any) => {
    if (error?.name === "AbortError") {
      throw error;
    }
    console.error("Transcription pipeline error:", error);
    throw new Error(`Viveka Analysis Failure: ${error.message}`);
  });
};
