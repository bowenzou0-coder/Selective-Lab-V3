import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { api, type ApiError, type AuthState } from '../api';

interface GoogleIdentity {
  initialize(options: {
    client_id: string;
    nonce: string;
    use_fedcm_for_button: boolean;
    callback: (response: { credential: string }) => void;
  }): void;
  renderButton(element: HTMLElement, options: {
    theme: 'outline';
    size: 'large';
    text: 'signin_with';
    width: number;
  }): void;
}

type GoogleWindow = Window & { google?: { accounts?: { id?: GoogleIdentity } } };
let googleScript: Promise<GoogleIdentity> | undefined;

function loadGoogleIdentity(): Promise<GoogleIdentity> {
  const existing = (window as GoogleWindow).google?.accounts?.id;
  if (existing) return Promise.resolve(existing);
  if (!googleScript) {
    googleScript = new Promise<GoogleIdentity>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => {
        const id = (window as GoogleWindow).google?.accounts?.id;
        if (id) resolve(id);
        else reject(new Error('Google sign-in failed to load.'));
      };
      script.onerror = () => {
        script.remove();
        reject(new Error('Google sign-in failed to load.'));
      };
      document.head.append(script);
    }).catch((err) => {
      googleScript = undefined;
      throw err;
    });
  }
  return googleScript;
}

export function GoogleSignInButton({
  admin,
  localDevPinEnabled,
  disabled,
  onBusyChange,
  onAuthenticated,
}: {
  admin: boolean;
  localDevPinEnabled: boolean;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onAuthenticated: (auth: AuthState) => void;
}) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'failed'>('loading');
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    let active = true;
    let pending = false;

    const initialize = async () => {
      const { clientId, nonce } = await api.getGoogleConfig();
      if (!active) return;
      if (!clientId || !nonce) {
        setStatus('unavailable');
        return;
      }
      const id = await loadGoogleIdentity();
      if (!active) return;

      id.initialize({
        client_id: clientId,
        nonce,
        use_fedcm_for_button: true,
        callback: async ({ credential }) => {
          if (!active || pending || button.inert) return;
          pending = true;
          setError('');
          setSigningIn(true);
          onBusyChange(true);
          try {
            const identity = await api.googleLogin(credential, admin);
            onAuthenticated(identity);
          } catch (err) {
            if (!active) return;
            const failure = err as ApiError;
            setError(failure.message || t('auth.googleFailed'));
            if (failure.status === 401) {
              setStatus('loading');
              setAttempt((prev) => prev + 1);
            }
          } finally {
            pending = false;
            if (active) {
              setSigningIn(false);
              onBusyChange(false);
            }
          }
        },
      });
      id.renderButton(button, { theme: 'outline', size: 'large', text: 'signin_with', width: 230 });
      setStatus('ready');
    };

    void initialize().catch(() => {
      if (active) setStatus('failed');
    });
    return () => {
      active = false;
      button.replaceChildren();
    };
  }, [admin, attempt, onAuthenticated, onBusyChange, t]);

  return (
    <div>
      <div ref={buttonRef} className="flex justify-center" inert={disabled || signingIn} />
      {status === 'loading' || signingIn ? (
        <p role="status" className="mt-2 text-center text-sm text-[#4A5955]">
          {signingIn ? t('auth.googleSigningIn') : t('auth.googleLoading')}
        </p>
      ) : null}
      {status === 'unavailable' && !localDevPinEnabled ? (
        <p role="alert" className="text-sm text-[var(--status-error)]">
          {t('auth.googleUnavailable')}
        </p>
      ) : null}
      {status === 'failed' ? (
        <button
          type="button"
          className="text-sm text-[#113C36] underline cursor-pointer"
          onClick={() => {
            setStatus('loading');
            setAttempt((prev) => prev + 1);
          }}
        >
          {t('auth.googleRetry')}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-[var(--status-error)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
