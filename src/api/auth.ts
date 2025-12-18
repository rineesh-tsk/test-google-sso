import { apiClient } from './client';

// ============================================================
// Types
// ============================================================

export type GoogleUser = {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture: string;
  given_name?: string;
  family_name?: string;
};

export type AuthStatusResponse = {
  status: 'pending' | 'complete' | 'error' | 'not_found';
  error?: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  user?: GoogleUser;
};

export type StartAuthResponse = {
  state: string;
  popupUrl: string;
};

// Legacy response type (kept for backward compatibility)
export type VerifyGoogleTokenResponse = {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  received_code?: boolean;
  token: string;
  mocked: boolean;
};

// ============================================================
// Popup + State Flow (iframe-safe)
// ============================================================

/**
 * Step 1: Get state token and popup URL from backend
 */
export async function startGoogleAuth(): Promise<StartAuthResponse> {
  const { data } = await apiClient.get<StartAuthResponse>('/auth/google/start');
  return data;
}

/**
 * Step 2: Poll backend for auth status
 */
export async function checkAuthStatus(state: string): Promise<AuthStatusResponse> {
  const { data } = await apiClient.get<AuthStatusResponse>(`/auth/google/status/${state}`);
  return data;
}

// ============================================================
// Legacy: Direct code exchange (for @react-oauth/google flow)
// ============================================================

export async function verifyGoogleToken(
  tokenOrCode: string,
): Promise<VerifyGoogleTokenResponse> {
  
    const { data } = await apiClient.post<VerifyGoogleTokenResponse>('/auth/google/exchange', {
      code: tokenOrCode,
    });
    return { ...data, token: tokenOrCode, mocked: false };
 
}

