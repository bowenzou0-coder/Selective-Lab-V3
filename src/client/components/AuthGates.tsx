import { useState, type FormEvent } from 'react';
import { signInWithPopup, type User } from 'firebase/auth';
import { auth, googleAuthProvider } from '../../lib/firebase';
import { api, type AuthState } from '../api';
import { IsometricBookStarIllustration } from './StudioIllustrations';

function formatFirebaseAuthError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || 'Google sign-in failed.');
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
  const combined = `${code} ${msg}`;
  if (combined.includes('auth/unauthorized-domain')) {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
    return `Google Sign-In is blocked for ${host}. Add this domain in Firebase Console under Authentication Authorized domains.`;
  }
  if (combined.includes('auth/popup-blocked')) {
    return 'Sign-in pop-up was blocked by your browser. Allow pop-ups for this site and try again.';
  }
  if (combined.includes('auth/popup-closed-by-user')) {
    return 'Sign-in pop-up was closed before completing.';
  }
  if (combined.includes('auth/cancelled-popup-request')) {
    return 'A sign-in pop-up is already open. Please complete or close it and try again.';
  }
  return msg;
}

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
  localDevPinEnabled = true,
  initialError = '',
}: {
  onAuthenticated: (auth: AuthState) => void;
  onGoogleAuthenticated: (user: User) => Promise<void>;
  onGoAdmin: () => void;
  localDevPinEnabled?: boolean;
  initialError?: string;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const displayError = error || initialError;

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError('');
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      await onGoogleAuthenticated(cred.user);
    } catch (err) {
      setError(formatFirebaseAuthError(err));
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
    <main className="min-h-screen flex flex-col items-center justify-center px-5 py-10 bg-[#F3EFE8]">
      <div className="w-full max-w-[440px] bg-white border border-[#E5DFD5] rounded-[18px] p-8 shadow-[0_2px_8px_rgba(17,60,54,0.04)]">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <div className="font-serif-display font-extrabold text-[22px] tracking-[-0.02em] text-[#113C36]">
              Selective Lab
            </div>
            <h1 className="mt-3 font-sans-display font-semibold text-[22px] tracking-[-0.015em] text-[#113C36]">
              Welcome back
            </h1>
          </div>
          <IsometricBookStarIllustration className="w-20 h-16 shrink-0 -mt-1" />
        </div>

        <p className="text-sm text-[#4A5955] leading-relaxed mb-6">
          Sign in with Google to keep your practice drills, writing feedback, and progress synced across devices.
        </p>

        <button
          type="button"
          disabled={googleLoading || loading}
          onClick={handleGoogleSignIn}
          className="w-full py-2.5 px-4 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] hover:bg-[#F3EFE8] text-[#113C36] font-sans-display font-semibold text-sm inline-flex items-center justify-center gap-2.5 transition-colors disabled:opacity-60 cursor-pointer"
        >
          <GoogleBadgeIcon />
          <span>{googleLoading ? 'Signing in with Google...' : 'Sign in with Google'}</span>
        </button>

        {!localDevPinEnabled && displayError && (
          <p
            role="alert"
            className="mt-4 text-xs font-medium text-[var(--status-error)] bg-[var(--status-error-bg)] px-3.5 py-2.5 rounded-[10px]"
          >
            {displayError}
          </p>
        )}

        {localDevPinEnabled && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-[#78756E]">
              <div className="flex-1 h-px bg-[#E5DFD5]" />
              <span>or continue with student PIN</span>
              <div className="flex-1 h-px bg-[#E5DFD5]" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="student-pin-input"
                  className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
                >
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
                  className="w-full px-3.5 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] text-[#113C36] tabular-nums text-base focus:outline-none focus:border-[#113C36] focus:bg-white transition-colors"
                />
              </div>

              {displayError && (
                <p
                  role="alert"
                  className="text-xs font-medium text-[var(--status-error)] bg-[var(--status-error-bg)] px-3.5 py-2.5 rounded-[10px]"
                >
                  {displayError}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || googleLoading}
                className="w-full py-2.5 px-4 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white font-sans-display font-semibold text-sm transition-colors disabled:opacity-60 cursor-pointer"
              >
                {loading ? 'Checking PIN...' : 'Continue with student PIN'}
              </button>
            </form>
          </>
        )}

        <div className="mt-6 pt-4 border-t border-[#E5DFD5] flex items-center justify-between text-xs text-[#78756E]">
          <span>Progress saved automatically</span>
          <button
            type="button"
            onClick={onGoAdmin}
            className="text-[#4A5955] hover:text-[#113C36] font-medium underline underline-offset-2 cursor-pointer"
          >
            Parent and tutor admin
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
  localDevPinEnabled = true,
  initialError = '',
  embedded = false,
}: {
  onAuthenticated: (auth: AuthState) => void;
  onGoogleAuthenticated: (user: User) => Promise<void>;
  onBackHome: () => void;
  localDevPinEnabled?: boolean;
  initialError?: string;
  embedded?: boolean;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const displayError = error || initialError;

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError('');
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      await onGoogleAuthenticated(cred.user);
    } catch (err) {
      setError(formatFirebaseAuthError(err));
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
    <main
      className={`${
        embedded ? 'py-16 px-6' : 'min-h-screen px-5 py-10 bg-[#F3EFE8]'
      } flex flex-col items-center justify-center`}
    >
      <div className="w-full max-w-[440px] bg-white border border-[#E5DFD5] rounded-[18px] p-8 shadow-[0_2px_8px_rgba(17,60,54,0.04)]">
        <div className="font-serif-display font-extrabold text-[20px] tracking-[-0.02em] text-[#113C36]">
          Selective Lab
        </div>
        <h1 className="mt-3 font-sans-display font-semibold text-[21px] tracking-[-0.015em] text-[#113C36] mb-2">
          Admin sign in
        </h1>
        <p className="text-sm text-[#4A5955] leading-relaxed mb-6">
          Sign in with an authorized admin account to manage the question bank, calibration simulator, imports, and settings.
        </p>

        <button
          type="button"
          disabled={googleLoading || loading}
          onClick={handleGoogleSignIn}
          className="w-full py-2.5 px-4 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] hover:bg-[#F3EFE8] text-[#113C36] font-sans-display font-semibold text-sm inline-flex items-center justify-center gap-2.5 transition-colors disabled:opacity-60 cursor-pointer"
        >
          <GoogleBadgeIcon />
          <span>{googleLoading ? 'Signing in with Google...' : 'Sign in with admin Google'}</span>
        </button>

        {!localDevPinEnabled && (
          <div className="mt-4 space-y-3">
            {displayError && (
              <p
                role="alert"
                className="text-xs font-medium text-[var(--status-error)] bg-[var(--status-error-bg)] px-3.5 py-2.5 rounded-[10px]"
              >
                {displayError}
              </p>
            )}
            <button
              type="button"
              onClick={onBackHome}
              className="w-full py-2.5 px-4 rounded-[10px] border border-[#CFC6B9] text-sm font-sans-display font-medium text-[#4A5955] hover:text-[#113C36] cursor-pointer"
            >
              Back to studio
            </button>
          </div>
        )}

        {localDevPinEnabled && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-[#78756E]">
              <div className="flex-1 h-px bg-[#E5DFD5]" />
              <span>or use admin password</span>
              <div className="flex-1 h-px bg-[#E5DFD5]" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="admin-password-input"
                  className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
                >
                  Admin password
                </label>
                <input
                  id="admin-password-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="w-full px-3.5 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-[#FAF8F5] text-[#113C36] text-sm focus:outline-none focus:border-[#113C36] focus:bg-white transition-colors"
                />
              </div>

              {displayError && (
                <p
                  role="alert"
                  className="text-xs font-medium text-[var(--status-error)] bg-[var(--status-error-bg)] px-3.5 py-2.5 rounded-[10px]"
                >
                  {displayError}
                </p>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={loading || googleLoading}
                  className="flex-1 py-2.5 px-4 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white font-sans-display font-semibold text-sm transition-colors disabled:opacity-60 cursor-pointer"
                >
                  {loading ? 'Signing in...' : 'Open admin console'}
                </button>
                <button
                  type="button"
                  onClick={onBackHome}
                  className="py-2.5 px-4 rounded-[10px] border border-[#CFC6B9] text-sm font-sans-display font-medium text-[#4A5955] hover:text-[#113C36] hover:bg-[#FAF8F5] cursor-pointer"
                >
                  Back
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
