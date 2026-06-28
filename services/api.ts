import { clearAuthStorage, getAccessToken } from './authStorage';
import { BASE_URL } from './config';

const getHeaders = (isMultipart = false) => {
  const token = getAccessToken();
  const headers: HeadersInit = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (!isMultipart) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
};

const handleUnauthorized = (response: Response) => {
  if (response.status !== 401) {
    return;
  }

  clearAuthStorage();

  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
};

const parseErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const data = await response.json();
    if (typeof data?.message === 'string' && data.message.trim()) {
      return data.message;
    }
    if (typeof data?.detail === 'string' && data.detail.trim()) {
      return data.detail;
    }
  } catch {
    // Ignore JSON parse errors and fallback below.
  }
  return fallback;
};

export const api = {
  register: async (userData: any) => {
    const response = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
    });
    handleUnauthorized(response);
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, 'Registration failed'));
    }
    return response.json();
  },

  login: async (credentials: any) => {
    const params = new URLSearchParams();
    params.append('username', credentials.username);
    params.append('password', credentials.password);

    const response = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    handleUnauthorized(response);
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, 'Login failed'));
    }
    return response.json();
  },

  forgotPassword: async (payload: { email: string }) => {
    const response = await fetch(`${BASE_URL}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    handleUnauthorized(response);
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, 'Failed to request password reset'));
    }
    return response.json();
  },

  resetPassword: async (payload: { token: string; new_password: string }) => {
    const response = await fetch(`${BASE_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    handleUnauthorized(response);
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, 'Failed to reset password'));
    }
    return response.json();
  },

  logout: async () => {
    try {
      await fetch(`${BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: getHeaders(),
      });
    } catch (error) {
      console.error("Logout API call failed", error);
    }
  },

  uploadFile: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    
    const response = await fetch(`${BASE_URL}/files/upload`, {
      method: 'POST',
      headers: getHeaders(true),
      body: formData,
    });
    handleUnauthorized(response);
    
    if (!response.ok) throw new Error('Upload failed');
    return response.json();
  },

  getMyFiles: async () => {
    const response = await fetch(`${BASE_URL}/files/my-files`, {
      method: 'GET',
      headers: getHeaders(),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Fetching files failed');
    return response.json();
  },

  getMyActivity: async (limit = 50) => {
    const response = await fetch(`${BASE_URL}/api/my-activity?limit=${limit}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Fetching activity failed');
    return response.json();
  },

  getDashboardStats: async () => {
    const response = await fetch(`${BASE_URL}/admin/dashboard`, {
      method: 'GET',
      headers: getHeaders(),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Fetching dashboard stats failed');
    return response.json();
  },

  getAdminUsers: async (limit = 200, offset = 0) => {
    const response = await fetch(`${BASE_URL}/admin/users?limit=${limit}&offset=${offset}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Fetching users failed');
    return response.json();
  },

  getAdminActivity: async (userId?: string, limit = 100, offset = 0) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (userId) params.set('user_id', userId);
    const response = await fetch(`${BASE_URL}/admin/activity?${params}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Fetching activity failed');
    return response.json();
  },

  getUserTokenUsage: async (userId: string) => {
    const response = await fetch(`${BASE_URL}/admin/users/${encodeURIComponent(userId)}/tokens`, {
      method: 'GET',
      headers: getHeaders(),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Fetching token usage failed');
    return response.json();
  },

  exportActivityCsv: async (userId?: string) => {
    const params = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
    const response = await fetch(`${BASE_URL}/admin/activity/export${params}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Export failed');
    return response.blob();
  },

  getUserFiles: async (userId: string) => {
    const response = await fetch(`${BASE_URL}/admin/user-files/${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Fetching user files failed');
    return response.json();
  },

  downloadFile: async (fileId: string) => {
    const response = await fetch(`${BASE_URL}/files/download/${fileId}`, {
      method: 'GET',
      headers: getHeaders(true),
    });
    handleUnauthorized(response);
    if (!response.ok) throw new Error('Download failed');
    return response.blob();
  }
};