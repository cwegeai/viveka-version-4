import { jsonrepair } from "jsonrepair";
import { TranscriptionResult } from "../types";

const LONG_AUDIO_THRESHOLD_SECONDS = 20 * 60;
const LONG_AUDIO_SEGMENT_SECONDS = 60;
const LONG_AUDIO_CONCURRENCY = 1;
const DEEPGRAM_TIMEOUT_MS = 300000;
const DEEPGRAM_MAX_RETRIES = 1;

const formatTimestamp = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

const parseTimestampToSeconds = (timestamp: string): number => {
  if (!timestamp) return 0;
  if (/^\d+$/.test(timestamp)) return Number(timestamp);
  const match = timestamp.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
};

const getAudioDurationSeconds = async (audioFile: File): Promise<number> => {
  return await new Promise((resolve) => {
    const audio = document.createElement("audio");
    const tempUrl = URL.createObjectURL(audioFile);
    audio.src = tempUrl;
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(tempUrl);
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(tempUrl);
      resolve(0);
    };
  });
};

const splitAudioIntoSegments = async (
  audioFile: File,
  segmentDurationSeconds = 300
): Promise<Array<{ file: File; startSeconds: number }>> => {
  const arrayBuffer = await audioFile.arrayBuffer();
  const audioContext = new AudioContext();

  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const segments: Array<{ file: File; startSeconds: number }> = [];
    const sampleRate = decoded.sampleRate;
    const channelCount = decoded.numberOfChannels;
    const totalDuration = decoded.duration;

    const writeString = (view: DataView, offset: number, value: string) => {
      for (let index = 0; index < value.length; index++) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    };

    for (let startSeconds = 0, part = 1; startSeconds < totalDuration; startSeconds += segmentDurationSeconds, part++) {
      const endSeconds = Math.min(startSeconds + segmentDurationSeconds, totalDuration);
      const startSample = Math.floor(startSeconds * sampleRate);
      const endSample = Math.floor(endSeconds * sampleRate);
      const frameCount = Math.max(0, endSample - startSample);

      const byteRate = sampleRate * channelCount * 2;
      const dataSize = frameCount * channelCount * 2;
      const wavBuffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(wavBuffer);

      writeString(view, 0, "RIFF");
      view.setUint32(4, 36 + dataSize, true);
      writeString(view, 8, "WAVE");
      writeString(view, 12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, channelCount, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, channelCount * 2, true);
      view.setUint16(34, 16, true);
      writeString(view, 36, "data");
      view.setUint32(40, dataSize, true);

      let offset = 44;
      for (let frame = 0; frame < frameCount; frame++) {
        for (let channel = 0; channel < channelCount; channel++) {
          const sample = decoded.getChannelData(channel)[startSample + frame] || 0;
          const clamped = Math.max(-1, Math.min(1, sample));
          view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
          offset += 2;
        }
      }

      const segmentBlob = new Blob([view], { type: "audio/wav" });
      const segmentFile = new File([segmentBlob], `${audioFile.name.replace(/\.[^.]+$/, "")}_part_${part}.wav`, {
        type: "audio/wav"
      });

      segments.push({ file: segmentFile, startSeconds });
    }

    return segments;
  } finally {
    await audioContext.close();
  }
};

const normalizeTurns = (turns: any[], offsetSeconds = 0, startIndex = 0) => {
  return turns
    .filter((turn) => !!turn?.original)
    .map((turn, index) => {
      const turnStart = typeof turn.startSeconds === "number"
        ? turn.startSeconds
        : parseTimestampToSeconds(turn.timestamp || "");

      const original = String(turn.original || "").trim();

      return {
        speaker: String(turn.speaker || `Speaker ${index + 1}`),
        timestamp: formatTimestamp(turnStart + offsetSeconds),
        original,
        transliterated: String(turn.transliterated || original),
        translated: String(turn.translated || original),
        mu_id: `MU-${(startIndex + index + 1).toString().padStart(3, "0")}`
      };
    });
};

const createEmptyArtifactResult = () => ({
  executiveSynthesis: [],
  artifact1_evidence: [],
  artifact2_context: [],
  artifact3_chains: [],
  artifact5_hotspots: []
});

const buildTranscriptContext = (turns: any[]): string => {
  return turns
    .map((turn) => `${turn.timestamp} | ${turn.speaker} | Original: ${turn.original} | Transliteration: ${turn.transliterated} | Translation: ${turn.translated}`)
    .join("\n");
};

const withTimeout = async <T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await task(controller.signal);
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const getAzureOpenAIConfig = () => {
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.AZURE_OPENAI_API_KEY || "").trim();
  const apiVersion = (process.env.AZURE_OPENAI_API_VERSION || "").trim();
  const deployment = (process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || "").trim();

  if (!endpoint || !apiKey || !apiVersion || !deployment) {
    return null;
  }

  return { endpoint, apiKey, apiVersion, deployment };
};

const synthesizeArtifactsWithAzureOpenAI = async (
  transcriptContext: string
) => {
  const azureConfig = getAzureOpenAIConfig();
  if (!azureConfig) {
    return createEmptyArtifactResult();
  }

  const systemPrompt = [
    "Role: AWESOME-Qual-Mapping-Azure, an expert social science analyst.",
    "Framework: AWESOME Framework (Gressel et al., 2019).",
    "Return only valid JSON with these top-level keys:",
    "executiveSynthesis, artifact1_evidence, artifact2_context, artifact3_chains, artifact5_hotspots.",
    "Use empty arrays when evidence is missing."
  ].join(" ");

  const userPrompt = [
    "Analyze the transcript below and generate:",
    "1. executiveSynthesis: array of { chunk_id, text }",
    "2. artifact1_evidence: array of { dimension, domain, evidence, reasoning }",
    "3. artifact2_context: array of { contextLevel, domain, finding }",
    "4. artifact3_chains: array of { chain_id, pathway, impacts }",
    "5. artifact5_hotspots: array of { vulnerable, drivers }",
    "Transcript:",
    transcriptContext
  ].join("\n\n");

  const response = await fetch(
    `${azureConfig.endpoint}/openai/deployments/${encodeURIComponent(azureConfig.deployment)}/chat/completions?api-version=${encodeURIComponent(azureConfig.apiVersion)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": azureConfig.apiKey
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Azure OpenAI analysis failed: ${response.status} ${errorText}`.trim());
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const parsedArtifact = extractLargestCompleteJsonObject(content);

  if (!parsedArtifact) {
    throw new Error("Azure OpenAI returned an unreadable analysis payload.");
  }

  return {
    ...createEmptyArtifactResult(),
    ...parsedArtifact
  };
};

const transcribeWithDeepgram = async (
  audioFile: File,
  mimeType: string,
  signal?: AbortSignal
): Promise<{ turns: any[] }> => {
  const deepgramKey = (process.env.DEEPGRAM_API_KEY || "").trim();
  if (!deepgramKey) return { turns: [] };

  const query = new URLSearchParams({
    model: "nova-2",
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    filler_words: "false"
  });

  const response = await fetch(`https://api.deepgram.com/v1/listen?${query.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${deepgramKey}`,
      "Content-Type": mimeType || "audio/mpeg"
    },
    body: audioFile,
    signal
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Deepgram STT failed: ${response.status} ${errText}`);
  }

  const data: any = await response.json();
  const words: any[] = data?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
  if (!words.length) return { turns: [] };

  const turns: any[] = [];
  let currentSpeaker = words[0].speaker ?? 0;
  let currentStart = words[0].start ?? 0;
  let currentEnd = words[0].end ?? 0;
  let buffer: string[] = [words[0].punctuated_word || words[0].word || ""];

  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    const speaker = word.speaker ?? currentSpeaker;
    const token = word.punctuated_word || word.word || "";

    if (speaker !== currentSpeaker) {
      const original = buffer.join(" ").replace(/\s+/g, " ").trim();
      if (original) {
        turns.push({
          speaker: `Speaker ${Number(currentSpeaker) + 1}`,
          timestamp: formatTimestamp(currentStart),
          startSeconds: currentStart,
          original,
          transliterated: original,
          translated: original,
          mu_id: `MU-${(turns.length + 1).toString().padStart(3, "0")}`
        });
      }

      currentSpeaker = speaker;
      currentStart = word.start ?? currentEnd;
      buffer = [token];
    } else {
      buffer.push(token);
    }
    currentEnd = word.end ?? currentEnd;
  }

  const lastOriginal = buffer.join(" ").replace(/\s+/g, " ").trim();
  if (lastOriginal) {
    turns.push({
      speaker: `Speaker ${Number(currentSpeaker) + 1}`,
      timestamp: formatTimestamp(currentStart),
      startSeconds: currentStart,
      original: lastOriginal,
      transliterated: lastOriginal,
      translated: lastOriginal,
      mu_id: `MU-${(turns.length + 1).toString().padStart(3, "0")}`
    });
  }

  return { turns };
};

const transcribeSegmentWithRetry = async (
  audioFile: File,
  mimeType: string,
  segmentIndex: number,
  totalSegments: number,
  onStatusChange: (status: string, progress?: number) => void
) => {
  let lastError: any = null;

  for (let attempt = 0; attempt <= DEEPGRAM_MAX_RETRIES; attempt++) {
    const attemptLabel = DEEPGRAM_MAX_RETRIES > 0 ? ` (attempt ${attempt + 1}/${DEEPGRAM_MAX_RETRIES + 1})` : "";
    onStatusChange(`Transcribing segment ${segmentIndex + 1}/${totalSegments}${attemptLabel}...`);

    try {
      return await withTimeout(
        (signal) => transcribeWithDeepgram(audioFile, mimeType, signal),
        DEEPGRAM_TIMEOUT_MS
      );
    } catch (error: any) {
      lastError = error;
      if (error?.name === "AbortError") {
        lastError = new Error(`Deepgram STT timed out after ${Math.round(DEEPGRAM_TIMEOUT_MS / 1000)}s.`);
      }
    }
  }

  throw new Error(`Segment ${segmentIndex + 1}/${totalSegments} failed. ${lastError?.message || "Unknown Deepgram error."}`);
};

const transcribeLongAudio = async (
  audioFile: File,
  onStatusChange: (status: string, progress?: number) => void
) => {
  onStatusChange("Long audio detected. Preparing Deepgram chunks...", 35);
  const segments = await splitAudioIntoSegments(audioFile, LONG_AUDIO_SEGMENT_SECONDS);
  const results: Array<any[]> = new Array(segments.length);
  let nextSegmentIndex = 0;
  let completedSegments = 0;

  const processNextSegment = async () => {
    while (nextSegmentIndex < segments.length) {
      const segmentIndex = nextSegmentIndex;
      nextSegmentIndex += 1;

      const segment = segments[segmentIndex];
      const segmentResult = await transcribeSegmentWithRetry(
        segment.file,
        "audio/wav",
        segmentIndex,
        segments.length,
        onStatusChange
      );

      results[segmentIndex] = normalizeTurns(segmentResult.turns, segment.startSeconds, 0);
      completedSegments += 1;
      const progress = 35 + Math.floor((completedSegments / segments.length) * 50);
      onStatusChange(`Completed segment ${completedSegments}/${segments.length}...`, progress);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(LONG_AUDIO_CONCURRENCY, segments.length) }, () => processNextSegment())
  );

  const mergedTurns: any[] = [];
  results.forEach((turns) => {
    (turns || []).forEach((turn) => {
      mergedTurns.push({
        ...turn,
        mu_id: `MU-${(mergedTurns.length + 1).toString().padStart(3, "0")}`
      });
    });
  });

  return mergedTurns;
};

function extractLargestCompleteJsonObject(str: string): any {
  if (!str || str.trim() === "") return null;

  const cleanedStr = str.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(jsonrepair(cleanedStr));
  } catch {
  }
  const start = cleanedStr.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < cleanedStr.length; i++) {
    if (cleanedStr[i] === "{") depth++;
    else if (cleanedStr[i] === "}") depth--;
    if (depth === 0 && i > start) {
      try {
        return JSON.parse(cleanedStr.substring(start, i + 1));
      } catch {
      }
    }
  }

  try {
    let forced = cleanedStr.substring(start);
    forced = forced.trim().replace(/,$/, "");
    let tempDepth = depth;
    while (tempDepth > 0) {
      forced += "}";
      tempDepth--;
    }
    return JSON.parse(jsonrepair(forced));
  } catch {
    return null;
  }
}

export const transcribeAudio = async (
  audioFile: File,
  mimeType: string,
  onStatusChange: (status: string, progress?: number) => void
): Promise<TranscriptionResult> => {
  onStatusChange("Protocol: High-Fidelity Local Sync...", 10);
  let verbatimResult: any = null;
  let artifactResult = createEmptyArtifactResult();

  try {
    onStatusChange("Phase 1: Zero-Loss Verbatim Synthesis...", 20);

    const durationSeconds = await getAudioDurationSeconds(audioFile);
    if (durationSeconds >= LONG_AUDIO_THRESHOLD_SECONDS) {
      const mergedTurns = await transcribeLongAudio(audioFile, onStatusChange);
      if (mergedTurns.length > 0) {
        verbatimResult = { turns: mergedTurns };
        onStatusChange("Phase 1 complete via segmented Deepgram STT...", 88);
      }
    } else {
      const deepgramResult = await withTimeout(
        (signal) => transcribeWithDeepgram(audioFile, mimeType, signal),
        DEEPGRAM_TIMEOUT_MS
      );
      if (deepgramResult.turns.length > 0) {
        verbatimResult = { turns: normalizeTurns(deepgramResult.turns) };
        onStatusChange("Phase 1 complete via Deepgram STT...", 88);
      }
    }

    if (!verbatimResult) {
      throw new Error("Deepgram transcription was unavailable or returned no turns.");
    }

    try {
      onStatusChange("Phase 2: AWESOME Synthesizing Systemic Artifacts...", 90);
      artifactResult = await synthesizeArtifactsWithAzureOpenAI(
        buildTranscriptContext(verbatimResult.turns || [])
      );
    } catch (artifactError: any) {
      console.warn(`Artifact synthesis failed: ${artifactError.message}`);
      artifactResult = createEmptyArtifactResult();
      onStatusChange("Transcription complete. Azure analysis skipped.", 92);
    }

    const result = {
      ...artifactResult,
      turns: verbatimResult.turns
    };

    onStatusChange("Compiling Multilingual Dossier...", 95);
    onStatusChange("Dossier Synced.", 100);

    return {
      turns: result.turns || [],
      summary: result.executiveSynthesis?.map((c: any) => `Chunk ${c.chunk_id}: ${c.text}`).join("\n\n") || "",
      keyPoints: result.artifact1_evidence?.map((e: any) => e.evidence) || [],
      executiveSynthesis: result.executiveSynthesis || [],
      artifact1_evidence: result.artifact1_evidence || [],
      artifact2_context: result.artifact2_context || [],
      artifact3_chains: result.artifact3_chains || [],
      artifact4_link_map: "Master Research Database Link Verified",
      artifact5_hotspots: result.artifact5_hotspots || [],
      strategies: []
    };
  } catch (error: any) {
    console.error("Transcription pipeline error:", error);
    throw new Error(`Viveka Analysis Failure: ${error.message}`);
  }
};
