import axios from 'axios';

const baseURL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

export const apiClient = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 8000,
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Keep a single place to log/transform API errors.
    const message = error?.response?.data?.message || error.message;
    return Promise.reject(new Error(message));
  },
);

