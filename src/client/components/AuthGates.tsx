import { useState, type FormEvent } from 'react';
import { api, type AuthState } from '../api';
import { LanguageToggle, useI18n } from '../i18n';
import { GoogleSignInButton } from './GoogleSignInButton';
import { IsometricBookStarIllustration } from './StudioIllustrations';

export function StudentPinGate({
  onAuthenticated,
  onGoAdmin,
  localDevPinEnabled = false,
  initialError = '',
  initialNotice = '',
}: {
  onAuthenticated: (auth: AuthState) => void;
  onGoAdmin: () => void;
  localDevPinEnabled?: boolean;
  initialError?: string;
  initialNotice?: string;
}) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const displayError = error || initialError;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) {
      setError(t('auth.pinRequired'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const authState = await api.studentLogin(pin.trim());
      onAuthenticated(authState);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.signInError'));
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
              {t('app.name')}
            </div>
            <h1 className="mt-3 font-sans-display font-semibold text-[22px] tracking-[-0.015em] text-[#113C36]">
              {t('auth.welcomeBack')}
            </h1>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <LanguageToggle compact />
            <IsometricBookStarIllustration className="w-20 h-16 shrink-0" />
          </div>
        </div>

        <p className="text-sm text-[#4A5955] leading-relaxed mb-6">
          {t('auth.studentIntro')}
        </p>

        {initialNotice && !displayError && (
          <p
            role="status"
            className="mb-4 text-xs font-medium text-[#113C36] bg-[#E5F0EA] border border-[#C5DDD1] px-3.5 py-2.5 rounded-[10px] leading-relaxed"
          >
            {initialNotice}
          </p>
        )}

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
            <div className="my-5 flex items-center gap-3 text-xs text-[#615E57]">
              <div className="flex-1 h-px bg-[#E5DFD5]" />
              <span>{t('auth.orPin')}</span>
              <div className="flex-1 h-px bg-[#E5DFD5]" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="student-pin-input"
                  className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
                >
                  {t('auth.studentPinLabel')}
                </label>
                <input
                  id="student-pin-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder={t('auth.studentPinPlaceholder')}
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
                className="w-full py-2.5 px-4 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white font-sans-display font-semibold text-sm transition-tactile disabled:opacity-60 cursor-pointer"
              >
                {loading ? t('auth.checkingPin') : t('auth.continuePin')}
              </button>
            </form>
          </>
        )}

        <div className="mt-6 pt-4 border-t border-[#E5DFD5] flex items-center justify-between gap-2 text-xs text-[#615E57]">
          <span>{t('auth.savedAuto')}</span>
          {localDevPinEnabled && (
            <button
              type="button"
              onClick={onGoAdmin}
              className="text-[#4A5955] hover:text-[#113C36] font-medium underline underline-offset-2 cursor-pointer whitespace-nowrap"
            >
              {t('auth.parentAdmin')}
            </button>
          )}
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
  initialNotice = '',
  embedded = false,
}: {
  onAuthenticated: (auth: AuthState) => void;
  onBackHome: () => void;
  localDevPinEnabled?: boolean;
  initialError?: string;
  initialNotice?: string;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const displayError = error || initialError;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError(t('auth.adminPwdRequired'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const authState = await api.adminLogin(password);
      onAuthenticated(authState);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.adminPwdInvalid'));
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
        <div className="flex items-start justify-between gap-3">
          <div className="font-serif-display font-extrabold text-[20px] tracking-[-0.02em] text-[#113C36]">
            {t('app.name')}
          </div>
          <LanguageToggle compact />
        </div>
        <h1 className="mt-3 font-sans-display font-semibold text-[21px] tracking-[-0.015em] text-[#113C36] mb-2">
          {t('auth.adminTitle')}
        </h1>
        <p className="text-sm text-[#4A5955] leading-relaxed mb-6">
          {t('auth.adminIntro')}
        </p>

        {initialNotice && !displayError && (
          <p
            role="status"
            className="mb-4 text-xs font-medium text-[#113C36] bg-[#E5F0EA] border border-[#C5DDD1] px-3.5 py-2.5 rounded-[10px] leading-relaxed"
          >
            {initialNotice}
          </p>
        )}

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
              {t('auth.backToStudio')}
            </button>
          </div>
        )}

        {localDevPinEnabled && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-[#615E57]">
              <div className="flex-1 h-px bg-[#E5DFD5]" />
              <span>{t('auth.orPassword')}</span>
              <div className="flex-1 h-px bg-[#E5DFD5]" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="admin-password-input"
                  className="block text-xs font-sans-display font-semibold text-[#4A5955] mb-1.5"
                >
                  {t('auth.adminPwdLabel')}
                </label>
                <input
                  id="admin-password-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('auth.adminPwdPlaceholder')}
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
                  className="flex-1 py-2.5 px-4 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white font-sans-display font-semibold text-sm transition-tactile disabled:opacity-60 cursor-pointer"
                >
                  {loading ? t('auth.signingIn') : t('auth.openAdminConsole')}
                </button>
                <button
                  type="button"
                  onClick={onBackHome}
                  className="py-2.5 px-4 rounded-[10px] border border-[#CFC6B9] text-sm font-sans-display font-medium text-[#4A5955] hover:text-[#113C36] hover:bg-[#FAF8F5] cursor-pointer"
                >
                  {t('auth.back')}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
