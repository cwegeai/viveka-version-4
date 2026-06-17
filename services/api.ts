import { getAccessToken } from './authStorage';
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

export const api = {
  register: async (userData: any) => {
    const response = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
    });
    if (!response.ok) throw new Error('Registration failed');
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
    if (!response.ok) throw new Error('Login failed');
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
    
    if (!response.ok) throw new Error('Upload failed');
    return response.json();
  },

  getMyFiles: async () => {
    const response = await fetch(`${BASE_URL}/files/my-files`, {
      method: 'GET',
      headers: getHeaders(),
    });
    if (!response.ok) throw new Error('Fetching files failed');
    return response.json();
  },

  getDashboardStats: async () => {
    const response = await fetch(`${BASE_URL}/admin/dashboard`, {
      method: 'GET',
      headers: getHeaders(),
    });
    if (!response.ok) throw new Error('Fetching dashboard stats failed');
    return response.json();
  },

  getUserFiles: async (userId: string) => {
    // Revert to path parameter with encoding. The query param approach caused a 404.
    const response = await fetch(`${BASE_URL}/admin/user-files/${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: getHeaders(),
    });
    if (!response.ok) throw new Error('Fetching user files failed');
    return response.json();
  },

  downloadFile: async (fileId: string) => {
    const response = await fetch(`${BASE_URL}/files/download/${fileId}`, {
      method: 'GET',
      headers: getHeaders(true),
    });
    if (!response.ok) throw new Error('Download failed');
    return response.blob();
  }
};