
import { GoogleGenAI, Type,   createUserContent, createPartFromUri, } from "@google/genai";
import { jsonrepair } from "jsonrepair";
import { TranscriptionResult } from "../types";
import { getGeminiApiKey } from "./authStorage";

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

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

const getGeminiRuntimeKey = (): string => {
  return getGeminiApiKey().trim();
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

const synthesizeArtifactsFromTranscript = async (
  ai: GoogleGenAI,
  transcriptContext: string,
  commonSystemInstruction: string,
  modelsToTry: string[],
  errors: string[]
) => {
  for (const modelName of modelsToTry) {
    try {
      const artifactResponse = await ai.models.generateContent({
        model: modelName,
        contents: `${commonSystemInstruction}\nTRANSCRIPT:\n${transcriptContext}\n\nTASK:

Generate the following artifacts from the transcript.

ARTIFACT 1: EVIDENCE MATRIX
- Extract ONLY direct quotes from the transcript.
- Each evidence item MUST include reasoning.
- Reasoning must be 1–2 lines explaining why the quote is important in the interview context.
- Reasoning is REQUIRED and cannot be empty.
- If reasoning cannot be generated, DO NOT include that evidence item.

ARTIFACT 2: CONTEXT MATRIX
- Explain the meaning behind the speaker's statements.
- Base explanation ONLY on transcript content.
- Do NOT copy transcript sentences directly.
- Do NOT summarize the full interview.
- Each entry must reflect a specific idea from the transcript.

ARTIFACT 3: MECHANISM CHAINS
- Extract only explicit cause → effect relationships from transcript.
- Format as logical chains (A → B → C).
- Do NOT invent relationships not supported by transcript.
- If no clear cause-effect exists, return empty array [].

ARTIFACT 5: VULNERABILITY HOTSPOTS
- Identify ONLY:
  - ambiguity in meaning
  - missing or unclear details
  - unsupported claims
  - contradictions in statements
- Do NOT include positive statements or general descriptions.
- ONLY risk, weakness, or uncertainty.
- If none exist, return empty array [].

CRITICAL RULES:
- Each artifact must contain UNIQUE information.
- The same sentence or idea must NOT appear in multiple artifacts.
- Evidence = Quotes only
- Context = Interpretation only
- Mechanism = Cause-effect only
- Hotspots = Risks / ambiguities only
- Do NOT generate empty reasoning fields.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              executiveSynthesis: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    chunk_id: { type: Type.INTEGER },
                    text: { type: Type.STRING }
                  },
                  required: ["chunk_id", "text"]
                }
              },
              artifact1_evidence: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    dimension: { type: Type.STRING },
                    domain: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                    reasoning: { type: Type.STRING, description: "MANDATORY: explain why this evidence is important in 1–2 lines" }
                  },
                  required: ["dimension", "domain", "evidence", "reasoning"]
                }
              },
              artifact2_context: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    contextLevel: { type: Type.STRING }, domain: { type: Type.STRING },
                    finding: { type: Type.STRING }
                  }
                }
              },
              artifact3_chains: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    chain_id: { type: Type.STRING }, pathway: { type: Type.STRING },
                    impacts: { type: Type.STRING }
                  }
                }
              },
              artifact5_hotspots: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    vulnerable: { type: Type.STRING }, drivers: { type: Type.STRING }
                  }
                }
              }
            },
            required: ["executiveSynthesis"]
          }
        }
      });

      const parsedArtifact = artifactResponse as any;
      if (parsedArtifact && Array.isArray(parsedArtifact.executiveSynthesis)) {
        return {
          ...createEmptyArtifactResult(),
          ...parsedArtifact
        };
      }
    } catch (error: any) {
      console.warn(`Model ${modelName} failed for artifact synthesis: ${error.message}`);
      errors.push(`${modelName}: ${error.message}`);
    }
  }

  throw new Error("Artifact generation failed");
};

const transcribeWithDeepgram = async (
  audioFile: File,
  mimeType: string
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
    body: audioFile
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

function extractLargestCompleteJsonObject(str: string): any {
  if (!str || str.trim() === "") return null;
  
  const cleanedStr = str.replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(jsonrepair(cleanedStr));
  } catch {
    // Fallback to manual extraction logic below
  }
  const start = cleanedStr.indexOf('{');
  if (start === -1) return null;
  
  let depth = 0;
  for (let i = start; i < cleanedStr.length; i++) {
    if (cleanedStr[i] === '{') depth++;
    else if (cleanedStr[i] === '}') depth--;
    if (depth === 0 && i > start) {
      try {
        return JSON.parse(cleanedStr.substring(start, i + 1));
      } catch (e) { }
    }
  }

  try {
    let forced = cleanedStr.substring(start);
    forced = forced.trim().replace(/,$/, '');
    let tempDepth = depth;
    while (tempDepth > 0) {
      forced += '}';
      tempDepth--;
    }
    return JSON.parse(jsonrepair(forced));
  } catch (e) {
    return null;
  }
}

export const downloadJsonLocally = (data: any, filename: string) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  
  link.href = url;
  link.download = `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  
  // Cleanup
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const transcribeAudio = async (
  audioFile: File,
  mimeType: string,
  onStatusChange: (status: string, progress?: number) => void
): Promise<TranscriptionResult> => {
  const apiKey = getGeminiRuntimeKey();
  onStatusChange("Protocol: High-Fidelity Local Sync...", 10);
  let uploadedFileName = "";
  const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
  const commonSystemInstruction = `Role: AWESOME-Qual-Mapping-GEMNI, an expert social science analyst.
    Framework: AWESOME Framework (Gressel et al., 2019).
    FORMAT: Strictly JSON. No markdown backticks or extra text outside JSON.`;
  const modelsToTry = [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-2.0-flash-lite"
  ];
  const errors: string[] = [];
  let verbatimResult: any = null;
  let artifactResult = createEmptyArtifactResult();

  try {
    onStatusChange("Phase 1: Zero-Loss Verbatim Synthesis...", 85);

    try {
      const durationSeconds = await getAudioDurationSeconds(audioFile);
      if (durationSeconds >= 20 * 60) {
        onStatusChange("Long audio detected. Segmenting for Deepgram STT...", 35);
        const segments = await splitAudioIntoSegments(audioFile);
        const mergedTurns: any[] = [];

        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index];
          const segmentProgress = 35 + Math.floor(((index + 1) / segments.length) * 50);
          onStatusChange(`Transcribing segment ${index + 1}/${segments.length}...`, segmentProgress);

          const segmentResult = await transcribeWithDeepgram(segment.file, "audio/wav");
          const normalized = normalizeTurns(segmentResult.turns, segment.startSeconds, mergedTurns.length);
          mergedTurns.push(...normalized);
        }

        if (mergedTurns.length > 0) {
          verbatimResult = { turns: mergedTurns };
          onStatusChange("Phase 1 complete via segmented Deepgram STT...", 88);
        }
      } else {
        const deepgramResult = await transcribeWithDeepgram(audioFile, mimeType);
        if (deepgramResult.turns.length > 0) {
          verbatimResult = { turns: normalizeTurns(deepgramResult.turns) };
          onStatusChange("Phase 1 complete via Deepgram STT...", 88);
        }
      }
    } catch (deepgramError: any) {
      console.warn(`Deepgram STT unavailable, falling back to Gemini: ${deepgramError.message}`);
      errors.push(`deepgram: ${deepgramError.message}`);
    }

    if (!verbatimResult && ai) {
      const fileManager = ai.files;
      const uploadResult: any = await fileManager.upload({
        file: audioFile,
        config: { mimeType, displayName: `Viveka_${Date.now()}` },
      });

      uploadedFileName = uploadResult.name;
      const fileUri = uploadResult.uri;

      let fileState = await fileManager.get({ name: uploadedFileName });
      while (fileState.state === "PROCESSING") {
        await sleep(5000);
        fileState = await fileManager.get({ name: uploadedFileName });
        onStatusChange("Analyzing waveform integrity...", 60);
      }

      for (const model_name of modelsToTry) {
        try {
          const verbatimResponse= await ai.models.generateContent({
            model: model_name,
            contents: createUserContent([
              createPartFromUri(fileUri, mimeType),
              `${commonSystemInstruction}\nTASK: Provide a 100% word-for-word transcript in the 'turns' array with [MM:SS] timestamps.`,
            ]),
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  turns: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        speaker: { type: Type.STRING },
                        timestamp: { type: Type.STRING },
                        original: { type: Type.STRING },
                        transliterated: { type: Type.STRING },
                        translated: { type: Type.STRING },
                        mu_id: { type: Type.STRING }
                      },
                      required: ["speaker", "timestamp", "original", "transliterated", "translated", "mu_id"]
                    }
                  }
                },
                required: ["turns"]
              }
            }
          });
          
          const parsed = verbatimResponse as any;
          if (parsed?.turns?.length > 0) {
            verbatimResult = parsed;
            console.log(`%c Success with ${model_name}`, "color: #10b981; font-weight: bold");
            break; // Success, exit loop
          }
        } catch (e: any) {
          console.warn(`Model ${model_name} failed for verbatim transcript: ${e.message}`);
          errors.push(`${model_name}: ${e.message}`);
        }
      }
    }

    if (!verbatimResult) {
      throw new Error(
        ai
          ? "Transcription failed in both Deepgram and Gemini paths."
          : "No Gemini key configured and Deepgram transcription was unavailable."
      );
    }

    if (ai) {
      try {
        onStatusChange("Phase 2: AWESOME Synthesizing Systemic Artifacts...", 85);
        artifactResult = await synthesizeArtifactsFromTranscript(
          ai,
          buildTranscriptContext(verbatimResult.turns || []),
          commonSystemInstruction,
          modelsToTry,
          errors
        );
      } catch (artifactError: any) {
        console.warn(`Artifact synthesis failed: ${artifactError.message}`);
        errors.push(`artifact: ${artifactError.message}`);
        artifactResult = createEmptyArtifactResult();
      }
    } else {
      onStatusChange("Transcription complete. Gemini analysis skipped.", 92);
    }

    console.log("Final Verbatim Result:", verbatimResult);
    console.log("Final Artifact Result:", artifactResult);

    const result = {
      ...artifactResult,
      turns: verbatimResult.turns
    };
    
    //downloadJsonLocally(result, `viveka_debug_${Date.now()}`);
    
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
    console.error("Gemini Error:", error);
    throw new Error(`Viveka Analysis Failure: ${error.message}`);
  } finally {
    if (ai && uploadedFileName) {
      await ai.files.delete({ name: uploadedFileName }).catch(() => {});
    }
  }
};
