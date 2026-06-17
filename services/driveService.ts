
/**
 * VIVEKA MASTER DRIVE ENDPOINT
 * This script handles PDF uploads to the designated research folder.
 * Target Folder: https://drive.google.com/drive/folders/12rVaQ__R6lLybaT2iww5bX081qI3YAyc
 */
const GOOGLE_SCRIPT_ID = "AKfycby4avFT9v_cT6mJFbz_Mb_wJHkUUoukPDHDSNWUBXTlZl1PhS5CwsCgQ1DyU7pKHvnI";
const DRIVE_ENDPOINT = `https://script.google.com/macros/s/${GOOGLE_SCRIPT_ID}/exec`;

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

/**
 * Encodes a PDF Blob to Base64 and pushes it to the Google Apps Script endpoint
 */
export const uploadPdfToDrive = async (
  pdfBlob: Blob,
  pdfFileName: string
): Promise<{ success: boolean; message?: string }> => {
  try {
    const ab = await pdfBlob.arrayBuffer();
    const base64 = arrayBufferToBase64(ab);

    const payload = {
      originalFileName: pdfFileName,
      type: "application/pdf",
      base64,
    };

    console.log("Viveka Cloud: Syncing Research Dossier to Secure Drive...");

    const res = await fetch(DRIVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Drive sync failed with status ${res.status}`);
    }

    const responseText = await res.text().catch(() => "");
    if (responseText && responseText.toUpperCase().includes("ERROR")) {
      throw new Error(responseText);
    }

    return { success: true, message: "Research Dossier synced to Google Drive successfully." };
  } catch (e) {
    console.error("Drive PDF Upload Error:", e);
    return { success: false, message: "Sync failed. Please check endpoint connectivity." };
  }
};
