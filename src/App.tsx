import { useCallback, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  startGoogleAuth,
  checkAuthStatus,
  type AuthStatusResponse,
  type GoogleUser,
} from './api/auth';

type AuthState = {
  loading: boolean;
  polling: boolean;
  error?: string;
  success?: boolean;
  accessToken?: string;
  idToken?: string;
  user?: GoogleUser;
};

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 300; // 5 minutes max

function App() {
  const [authState, setAuthState] = useState<AuthState>({ loading: false, polling: false });
  const pollCountRef = useRef(0);
  const pollIntervalRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    pollCountRef.current = 0;
  }, []);

  const handleAuthComplete = useCallback((result: AuthStatusResponse) => {
    stopPolling();

    if (result.status === 'complete') {
      setAuthState({
        loading: false,
        polling: false,
        success: true,
        accessToken: result.access_token,
        idToken: result.id_token,
        user: result.user,
      });
    } else if (result.status === 'error') {
      setAuthState({
        loading: false,
        polling: false,
        error: result.error || 'Authentication failed',
      });
    }
  }, [stopPolling]);

  const startPolling = useCallback((state: string) => {
    setAuthState((prev) => ({ ...prev, polling: true }));

    pollIntervalRef.current = window.setInterval(async () => {
      pollCountRef.current += 1;

      if (pollCountRef.current > MAX_POLL_ATTEMPTS) {
        stopPolling();
        setAuthState({
          loading: false,
          polling: false,
          error: 'Authentication timed out. Please try again.',
        });
        return;
      }

      try {
        const result = await checkAuthStatus(state);

        if (result.status === 'complete' || result.status === 'error') {
          handleAuthComplete(result);
        } else if (result.status === 'not_found') {
          stopPolling();
          setAuthState({
            loading: false,
            polling: false,
            error: 'Session expired. Please try again.',
          });
        }
        // If pending, keep polling
      } catch (err) {
        // Network error - keep trying
        console.warn('Polling error:', err);
      }
    }, POLL_INTERVAL_MS);
  }, [handleAuthComplete, stopPolling]);

  const handleLogin = useCallback(async () => {
    setAuthState({ loading: true, polling: false });

    try {
      // Get popup URL and state from backend
      const { state, popupUrl } = await startGoogleAuth();

      // Open popup
      const width = 500;
      const height = 600;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      const popup = window.open(
        popupUrl,
        'google-auth-popup',
        `width=${width},height=${height},left=${left},top=${top},popup=yes`,
      );

      if (!popup) {
        setAuthState({
          loading: false,
          polling: false,
          error: 'Popup blocked. Please allow popups for this site.',
        });
        return;
      }

      // Start polling for result
      startPolling(state);

      // Also watch for popup close (user cancelled)
      const popupWatcher = setInterval(() => {
        if (popup.closed) {
          clearInterval(popupWatcher);
          // Give a bit more time for the callback to complete
          setTimeout(() => {
            if (authState.polling) {
              // Still polling means auth might still complete
              // Don't stop yet - the callback might have fired just before close
            }
          }, 2000);
        }
      }, 500);
    } catch (err) {
      setAuthState({
        loading: false,
        polling: false,
        error: err instanceof Error ? err.message : 'Failed to start authentication',
      });
    }
  }, [authState.polling, startPolling]);

  const statusText = useMemo(() => {
    if (authState.loading && !authState.polling) return 'Starting authentication...';
    if (authState.polling) return 'Waiting for authentication...';
    if (authState.success) return 'Signed in';
    if (authState.error) return authState.error;
    return 'Ready to sign in';
  }, [authState]);

  const handleLogout = useCallback(() => {
    setAuthState({ loading: false, polling: false });
  }, []);

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">Google OAuth Demo</p>
          <p className="subtle">
            Backend-mediated OAuth with popup + state polling. Works safely in iframes.
          </p>
        </div>
        <div className="status-chip">{statusText}</div>
      </header>

      <main className="content">
        <section className="card">
          <h2>Sign in with Google</h2>
          <p className="subtle">
            Opens a popup for Google sign-in. The backend handles the OAuth flow and securely
            exchanges the authorization code for tokens.
          </p>
          {!authState.success ? (
            <button
              className="primary-btn"
              onClick={handleLogin}
              disabled={authState.loading || authState.polling}
            >
              {authState.loading || authState.polling ? 'Authenticating...' : 'Continue with Google'}
            </button>
          ) : (
            <button className="secondary-btn" onClick={handleLogout}>
              Sign out
            </button>
          )}
        </section>

        <section className="card">
          <h3>Result</h3>
          {(authState.loading || authState.polling) && (
            <p>
              {authState.polling
                ? 'Complete sign-in in the popup window...'
                : 'Starting authentication...'}
            </p>
          )}
          {authState.error && <p className="error">Error: {authState.error}</p>}
          {authState.success && authState.user && (
            <div className="result">
              <div className="user-info">
                {authState.user.picture && (
                  <img
                    src={authState.user.picture}
                    alt={authState.user.name}
                    className="user-avatar"
                  />
                )}
                <div>
                  <p className="user-name">{authState.user.name}</p>
                  <p className="user-email">{authState.user.email}</p>
                </div>
              </div>
              {authState.accessToken && (
                <div className="token-block">
                  <span className="label">Access Token</span>
                  <code>{authState.accessToken}</code>
                </div>
              )}
              {authState.idToken && (
                <div className="token-block">
                  <span className="label">ID Token</span>
                  <code>{authState.idToken}</code>
                </div>
              )}
            </div>
          )}
          {!authState.loading && !authState.polling && !authState.error && !authState.success && (
            <p className="subtle">No sign-in attempt yet.</p>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
