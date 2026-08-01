const normalizeUrl = (value?: string) => (value || "").trim().replace(/\/+$/, "");

const defaultBackendUrl = "http://127.0.0.1:8000";
const configuredApiBaseUrl = normalizeUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);
const configuredTranscriptionUrl = normalizeUrl(import.meta.env.VITE_TRANSCRIPTION_API_URL as string | undefined);
const configuredDossierSync = (import.meta.env.VITE_ENABLE_DOSSIER_SYNC as string | undefined)?.trim().toLowerCase();
const configuredFileHistory = (import.meta.env.VITE_ENABLE_FILE_HISTORY as string | undefined)?.trim().toLowerCase();

export const BACKEND_BASE_URL = configuredApiBaseUrl || configuredTranscriptionUrl || defaultBackendUrl;
export const BASE_URL = BACKEND_BASE_URL;
export const TRANSCRIPTION_API_URL = configuredTranscriptionUrl || BACKEND_BASE_URL;
export const DOSSIER_SYNC_ENABLED = configuredDossierSync === 'true';
export const FILE_HISTORY_ENABLED = configuredFileHistory === 'true';
