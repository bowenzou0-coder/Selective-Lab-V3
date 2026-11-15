import { useState, type FormEvent } from 'react';
import { signInWithPopup, type User } from 'firebase/auth';
import { Lock } from 'lucide-react';
import { auth, googleAuthProvider } from '../../lib/firebase';
import { api, type AuthState } from '../api';

function GoogleBadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
      />
    </svg>
  );
}

export function StudentPinGate({
  onAuthenticated,
  onGoogleAuthenticated,
  onGoAdmin,
}: {
  onAuthenticated: (auth: AuthState) => void;
  onGoogleAuthenticated: (user: User) => Promise<void>;
  onGoAdmin: () => void;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError('');
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      await onGoogleAuthenticated(cred.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) {
      setError('Enter your student PIN to continue.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const authState = await api.studentLogin(pin.trim());
      onAuthenticated(authState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 bg-[var(--bg-canvas)]">
      <div className="w-full max-w-md bg-[var(--bg-elevated)] border border-[var(--border-hairline)] rounded-[var(--radius-lg)] p-8">
        <div className="flex items-center gap-2.5 text-[var(--text-secondary)] text-xs font-medium mb-3">
          <Lock className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>Selective Lab</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)] mb-2">
          Sign in to Selective Lab
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          Sign in with Google to sync your practice tests, question progress, and mastery stats across devices.
        </p>

        <button
          type="button"
          disabled={googleLoading || loading}
          onClick={handleGoogleSignIn}
          className="w-full py-2.5 px-4 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-surface)] text-[var(--text-primary)] font-semibold text-sm inline-flex items-center justify-center gap-2.5 transition-colors disabled:opacity-60 cursor-pointer"
        >
          <GoogleBadgeIcon />
          <span>{googleLoading ? 'Syncing with Google...' : 'Sign in with Google'}</span>
        </button>

        <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          <div className="flex-1 h-px bg-[var(--border-hairline)]" />
          <span>or local student pin</span>
          <div className="flex-1 h-px bg-[var(--border-hairline)]" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="student-pin-input" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Student PIN
            </label>
            <input
              id="student-pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter PIN (default: 1234)"
              className="w-full px-3.5 py-2.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-[var(--text-primary)] tabular-nums text-base focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>

          {error && (
            <p role="alert" className="text-xs font-medium text-[var(--status-error)] bg-[var(--status-error-bg)] px-3 py-2 rounded-[var(--radius-sm)]">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || googleLoading}
            className="w-full py-2.5 px-4 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white font-semibold text-sm transition-colors disabled:opacity-60 cursor-pointer"
          >
            {loading ? 'Verifying...' : 'Unlock with Student PIN'}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-[var(--border-hairline)] flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>Cross-device cloud sync enabled</span>
          <button
            type="button"
            onClick={onGoAdmin}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 cursor-pointer"
          >
            Admin Console
          </button>
        </div>
      </div>
    </main>
  );
}

export function AdminPasswordGate({
  onAuthenticated,
  onGoogleAuthenticated,
  onBackHome,
}: {
  onAuthenticated: (auth: AuthState) => void;
  onGoogleAuthenticated: (user: User) => Promise<void>;
  onBackHome: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError('');
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      await onGoogleAuthenticated(cred.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Admin password is required.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const authState = await api.adminLogin(password);
      onAuthenticated(authState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid admin password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-[75vh] flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-md bg-[var(--bg-elevated)] border border-[var(--border-hairline)] rounded-[var(--radius-lg)] p-8">
        <div className="flex items-center gap-2 text-[var(--text-secondary)] text-xs font-medium mb-2">
          <Lock className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>Parent &amp; Tutor Administration</span>
        </div>
        <h1 className="text-xl font-bold text-[var(--text-primary)] mb-2">Admin Sign In</h1>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          Authenticate to access the Calibration Simulator, Question QC, Manifest Importer, and Config Versioning.
        </p>

        <button
          type="button"
          disabled={googleLoading || loading}
          onClick={handleGoogleSignIn}
          className="w-full py-2.5 px-4 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-surface)] text-[var(--text-primary)] font-semibold text-sm inline-flex items-center justify-center gap-2.5 transition-colors disabled:opacity-60 cursor-pointer"
        >
          <GoogleBadgeIcon />
          <span>{googleLoading ? 'Syncing with Google...' : 'Sign in with Admin Google'}</span>
        </button>

        <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          <div className="flex-1 h-px bg-[var(--border-hairline)]" />
          <span>or admin password</span>
          <div className="flex-1 h-px bg-[var(--border-hairline)]" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="admin-password-input" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Admin Password
            </label>
            <input
              id="admin-password-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter admin password"
              className="w-full px-3.5 py-2.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-canvas)] text-[var(--text-primary)] text-sm focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>

          {error && (
            <p role="alert" className="text-xs font-medium text-[var(--status-error)] bg-[var(--status-error-bg)] px-3 py-2 rounded-[var(--radius-sm)]">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={loading || googleLoading}
              className="flex-1 py-2.5 px-4 rounded-[var(--radius-sm)] bg-[var(--text-primary)] hover:opacity-90 text-white font-semibold text-sm transition-opacity disabled:opacity-60 cursor-pointer"
            >
              {loading ? 'Signing in...' : 'Open Admin Console'}
            </button>
            <button
              type="button"
              onClick={onBackHome}
              className="py-2.5 px-4 rounded-[var(--radius-sm)] border border-[var(--border-strong)] text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              Back
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
