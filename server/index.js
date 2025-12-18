import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root (one level up from server/)
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3001;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Callback URI for the popup flow - must be registered in Google Console
const CALLBACK_URI = process.env.GOOGLE_CALLBACK_URI || `http://localhost:${PORT}/auth/google/callback`;
// For @react-oauth/google auth-code flow (kept for backward compatibility)
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'postmessage';

// In-memory store for auth results keyed by state (use Redis in production)
const authStore = new Map();
const AUTH_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of authStore.entries()) {
    if (now - entry.createdAt > AUTH_TTL_MS) {
      authStore.delete(state);
    }
  }
}, 60 * 1000);

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8080',
    'http://127.0.0.1:5500',
    'http://mytest.local:8080',
    'http://mytest.local:5173',
    'https://global-local.transak.com:5005',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
}));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ============================================================
// POPUP + STATE FLOW (for iframe-safe authentication)
// ============================================================

/**
 * Step 1: Iframe calls this to get a state token and popup URL
 * GET /auth/google/start
 * Returns: { state, popupUrl }
 */
app.get('/auth/google/start', (_req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).json({ error: 'Missing GOOGLE_CLIENT_ID' });
  }

  const state = crypto.randomBytes(32).toString('hex');

  // Store pending auth
  authStore.set(state, {
    status: 'pending',
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  const popupUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  res.json({ state, popupUrl });
});

/**
 * Step 2: Google redirects popup here after user authenticates
 * GET /auth/google/callback?code=...&state=...
 * Exchanges code, stores result, shows success page that closes popup
 */
app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // Handle OAuth errors
  if (error) {
    if (state && authStore.has(state)) {
      authStore.set(state, {
        status: 'error',
        error: error,
        createdAt: Date.now(),
      });
    }
    return res.send(popupClosePage('Authentication cancelled or failed.', false));
  }

  if (!state || !authStore.has(state)) {
    return res.status(400).send(popupClosePage('Invalid or expired state.', false));
  }

  if (!code) {
    authStore.set(state, {
      status: 'error',
      error: 'No authorization code received',
      createdAt: Date.now(),
    });
    return res.send(popupClosePage('No authorization code received.', false));
  }

  try {
    // Exchange code for tokens
    const params = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: CALLBACK_URI,
      grant_type: 'authorization_code',
    });

    const { data: tokenData } = await axios.post(
      'https://oauth2.googleapis.com/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    // Verify ID token and extract user info
    let user = null;
    if (tokenData.id_token) {
      const { data: verified } = await axios.get(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${tokenData.id_token}`,
      );

      if (verified.aud !== CLIENT_ID) {
        throw new Error('Token audience mismatch');
      }

      user = {
        sub: verified.sub,
        email: verified.email,
        email_verified: verified.email_verified === 'true',
        name: verified.name,
        picture: verified.picture,
        given_name: verified.given_name,
        family_name: verified.family_name,
      };
    }

    // Store successful result
    authStore.set(state, {
      status: 'complete',
      createdAt: Date.now(),
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      id_token: tokenData.id_token,
      expires_in: tokenData.expires_in,
      user,
    });

    res.send(popupClosePage('Authentication successful! You can close this window.', true));
  } catch (err) {
    const message = err?.response?.data?.error_description || err.message || 'Token exchange failed';
    authStore.set(state, {
      status: 'error',
      error: message,
      createdAt: Date.now(),
    });
    res.send(popupClosePage(`Authentication failed: ${message}`, false));
  }
});

/**
 * Step 3: Iframe polls this to check auth status
 * GET /auth/google/status/:state
 * Returns: { status: 'pending' | 'complete' | 'error', ...data }
 */
app.get('/auth/google/status/:state', (req, res) => {
  const { state } = req.params;
  const entry = authStore.get(state);

  if (!entry) {
    return res.status(404).json({ status: 'not_found', error: 'State not found or expired' });
  }

  if (entry.status === 'pending') {
    return res.json({ status: 'pending' });
  }

  if (entry.status === 'error') {
    // Clean up after delivering error
    authStore.delete(state);
    return res.json({ status: 'error', error: entry.error });
  }

  // Complete - return tokens and user, then clean up
  authStore.delete(state);
  res.json({
    status: 'complete',
    access_token: entry.access_token,
    refresh_token: entry.refresh_token,
    id_token: entry.id_token,
    expires_in: entry.expires_in,
    user: entry.user,
  });
});

/**
 * Helper: HTML page that closes the popup window
 */
function popupClosePage(message, success) {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Google Sign-In</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: ${success ? '#f0fdf4' : '#fef2f2'};
      color: ${success ? '#166534' : '#991b1b'};
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${success ? '✓' : '✕'}</div>
    <p>${message}</p>
    <p><small>This window will close automatically...</small></p>
  </div>
  <script>
    // Try to close popup after a short delay
    setTimeout(() => {
      try { window.close(); } catch (e) {}
    }, 1500);
  </script>
</body>
</html>
  `.trim();
}

// ============================================================
// LEGACY: Direct code exchange (for @react-oauth/google flow)
// ============================================================

app.post('/auth/google/exchange', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET' });
  }

  try {
    const params = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    // Exchange auth code for tokens
    const { data: tokenData } = await axios.post(
      'https://oauth2.googleapis.com/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    // Verify the ID token and get user info
    let userInfo = null;
    if (tokenData.id_token) {
      const { data: verifiedToken } = await axios.get(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${tokenData.id_token}`,
      );

      // Verify the token was issued for our client
      if (verifiedToken.aud !== CLIENT_ID) {
        return res.status(401).json({ error: 'Token was not issued for this application' });
      }

      userInfo = {
        sub: verifiedToken.sub,           // Unique Google user ID
        email: verifiedToken.email,
        email_verified: verifiedToken.email_verified === 'true',
        name: verifiedToken.name,
        picture: verifiedToken.picture,
        given_name: verifiedToken.given_name,
        family_name: verifiedToken.family_name,
        locale: verifiedToken.locale,
        iat: verifiedToken.iat,           // Issued at
        exp: verifiedToken.exp,           // Expiration
      };
    }

    res.json({
      token_type: tokenData.token_type,
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      refresh_token: tokenData.refresh_token,
      id_token: tokenData.id_token,
      scope: tokenData.scope,
      user: userInfo,
      verified: !!userInfo,
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    const message = error?.response?.data || error.message || 'Token exchange failed';
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Auth exchange server running on http://localhost:${PORT}`);
});

