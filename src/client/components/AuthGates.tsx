import { useState, type FormEvent } from 'react';
import { api, type AuthState } from '../api';
import { GoogleSignInButton } from './GoogleSignInButton';
import { IsometricBookStarIllustration } from './StudioIllustrations';

export function StudentPinGate({
  onAuthenticated,
  onGoAdmin,
  localDevPinEnabled = false,
  initialError = '',
}: {
  onAuthenticated: (auth: AuthState) => void;
  onGoAdmin: () => void;
  localDevPinEnabled?: boolean;
  initialError?: string;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const displayError = error || initialError;

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

        <GoogleSignInButton
          admin={false}
          localDevPinEnabled={localDevPinEnabled}
          disabled={loading}
          onBusyChange={setGoogleLoading}
          onAuthenticated={onAuthenticated}
        />

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
  onBackHome,
  localDevPinEnabled = false,
  initialError = '',
  embedded = false,
}: {
  onAuthenticated: (auth: AuthState) => void;
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

        <GoogleSignInButton
          admin={true}
          localDevPinEnabled={localDevPinEnabled}
          disabled={loading}
          onBusyChange={setGoogleLoading}
          onAuthenticated={onAuthenticated}
        />

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
