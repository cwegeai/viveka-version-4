import { getAccessToken } from './authStorage';
import { BASE_URL, DOSSIER_SYNC_ENABLED } from './config';

export const uploadToMinio = async (file: File) => {
  if (!DOSSIER_SYNC_ENABLED) {
    return null;
  }

  const token = getAccessToken();
  const formData = new FormData();
  formData.append('file', file);

  const headers: HeadersInit = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}/files/upload`, {
    method: 'POST',
    headers: headers,
    body: formData,
  });

  if (!response.ok) {
    throw new Error('Failed to upload file to Minio');
  }

  return response.json();
};