
import { TranscriptionResult } from "../types";

/**
 * VIVEKA MASTER DATABASE ENDPOINT
 * Spreadsheet: https://docs.google.com/spreadsheets/d/1zGI5SV8RCZLBTL0sq9HssuMu5_q_JieZrh8aFhwIa9o/
 */
const GOOGLE_SCRIPT_ID = "AKfycby4avFT9v_cT6mJFbz_Mb_wJHkUUoukPDHDSNWUBXTlZl1PhS5CwsCgQ1DyU7pKHvnI"; 
const DRIVE_ENDPOINT = `https://script.google.com/macros/s/${GOOGLE_SCRIPT_ID}/exec`;

export const syncToBackend = async (
  file: File,
  result: TranscriptionResult
): Promise<{ success: boolean; message?: string }> => {
  
  try {
    const payload = {
      originalFileName: file.name,
      sheetName: "Viveka_Backups",
      metadata: {
        summary: result.summary,
        keyPoints: result.keyPoints,
        // FIX: Removed result.speakerCount which is not defined in TranscriptionResult. Fallback to calculation.
        speakerCount: (new Set(result.turns.map(t => t.speaker))).size,
        syncedAt: new Date().toLocaleString()
      },
      analysis: {
        artifact3_chains: result.artifact3_chains,
        artifact5_hotspots: result.artifact5_hotspots,
        // FIX: Removed result.webhookData which is not defined in TranscriptionResult
      },
      // Including all three script tiers in the sync
      turns: result.turns.map(t => ({
        speaker: t.speaker,
        mu_id: t.mu_id,
        original: t.original,           // Native Malayalam
        transliterated: t.transliterated, // Phonetic
        translated: t.translated,         // English
        // FIX: Removed t.awesomePillar which is not defined in SpeakerTurn
      }))
    };

    console.log("Viveka Master Sync: Pushing triple-script dossier to database...");

    const response = await fetch(DRIVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Spreadsheet sync failed with status ${response.status}`);
    }

    const responseText = await response.text().catch(() => "");
    if (responseText && responseText.toUpperCase().includes("ERROR")) {
      throw new Error(responseText);
    }

    return { 
      success: true, 
      message: "Research dossier pushed to Viveka Master Spreadsheet." 
    };
  } catch (error) {
    console.error("Database Sync Error:", error);
    return { success: false, message: "Sync failed" };
  }
};
