export interface StoredUser {
  name?: string;
  full_name?: string;
  email?: string;
  isAdmin?: boolean;
  roles?: string[];
  affiliation?: string;
  nationality?: string;
}

const TOKEN_KEY = "access_token";
const USER_KEY = "viveka_user";
const GEMINI_KEY = "gemini_api_key";
const REGISTRATION_PROFILE_KEY = "viveka_registration_profile";

export const getAccessToken = (): string => sessionStorage.getItem(TOKEN_KEY) || "";

export const setAccessToken = (token: string) => {
  sessionStorage.setItem(TOKEN_KEY, token);
};

export const getStoredUser = (): StoredUser => {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

export const setStoredUser = (user: StoredUser) => {
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
};

export const getGeminiApiKey = (): string => sessionStorage.getItem(GEMINI_KEY) || "";

export const setGeminiApiKey = (apiKey: string) => {
  if (!apiKey.trim()) {
    sessionStorage.removeItem(GEMINI_KEY);
    return;
  }
  sessionStorage.setItem(GEMINI_KEY, apiKey.trim());
};

export const clearGeminiApiKey = () => {
  sessionStorage.removeItem(GEMINI_KEY);
};

export const cacheRegistrationProfile = (profile: Pick<StoredUser, "email" | "affiliation" | "nationality" | "full_name">) => {
  sessionStorage.setItem(REGISTRATION_PROFILE_KEY, JSON.stringify(profile));
};

export const getCachedRegistrationProfile = (): Partial<StoredUser> => {
  try {
    const raw = sessionStorage.getItem(REGISTRATION_PROFILE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

export const clearCachedRegistrationProfile = () => {
  sessionStorage.removeItem(REGISTRATION_PROFILE_KEY);
};

export const clearAuthStorage = () => {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(GEMINI_KEY);
};
