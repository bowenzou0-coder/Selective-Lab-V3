import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { api, type AuthState } from './client/api';
import { AdminPasswordGate, StudentPinGate } from './client/components/AuthGates';
import { HomeView } from './client/components/HomeView';
import { StudioShell } from './client/components/TopNav';
import { useI18n } from './client/i18n';

// Route-level chunks: the dashboard ships in the entry bundle; everything else loads on demand.
const loadAdminView = () => import('./client/components/AdminView');
const loadProgressView = () => import('./client/components/ProgressView');
const loadSessionPlayer = () => import('./client/components/SessionPlayerView');
const AdminView = lazy(() => loadAdminView().then((m) => ({ default: m.AdminView })));
const ProgressView = lazy(() => loadProgressView().then((m) => ({ default: m.ProgressView })));
const SessionPlayerView = lazy(() => loadSessionPlayer().then((m) => ({ default: m.SessionPlayerView })));

const signedOut: AuthState = { authenticated: false, role: null, studentId: null };

function whenIdle(work: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(work, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(work, 1500);
  return () => window.clearTimeout(id);
}

function RouteFallback({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="w-full py-24 flex items-center justify-center">
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="h-1 w-24 overflow-hidden rounded-full bg-[#E5DFD5]">
        <span className="block h-full w-1/3 rounded-full bg-[#113C36]/60 animate-[route-progress_1s_ease-in-out_infinite]" />
      </span>
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  const [path, setPath] = useState<string>(() => window.location.pathname || '/');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState('');
  const [logoutError, setLogoutError] = useState('');

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname || '/');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let active = true;
    api.getMe()
      .then((identity) => {
        if (active) setAuth(identity);
      })
      .catch((err: unknown) => {
        if (active) {
          setAuth(signedOut);
          setAuthError(err instanceof Error ? err.message : t('app.authCheckError'));
        }
      })
      .finally(() => {
        if (active) setLoadingAuth(false);
      });

    const onExpired = () => {
      setAuth((previous) => ({
        ...previous,
        ...signedOut,
        email: undefined,
        activeSessionId: null,
      }));
      setAuthError(t('app.sessionExpired'));
    };
    window.addEventListener('nsw-auth-expired', onExpired);
    return () => {
      active = false;
      window.removeEventListener('nsw-auth-expired', onExpired);
    };
  }, []);

  const onAuthenticated = useCallback((identity: AuthState) => {
    setAuthError('');
    setLogoutError('');
    setAuth(identity);
  }, []);

  const navigate = useCallback(
    (nextPath: string) => {
      const nextUrl = nextPath.startsWith('/') ? nextPath : `/${nextPath}`;
      const [pathnameOnly] = nextUrl.split('?');
      if (auth?.authenticated && auth.activeSessionId) {
        const lockedPath = `/session/${auth.activeSessionId}`;
        if (pathnameOnly !== lockedPath) {
          window.history.replaceState({}, '', lockedPath);
          setPath(lockedPath);
          return;
        }
      }
      if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
        window.history.pushState({}, '', nextUrl);
      }
      setPath(pathnameOnly || '/');
      window.scrollTo({ top: 0, behavior: 'auto' });
    },
    [auth]
  );

  // Warm the chunk this account is most likely to open next while the browser is idle.
  useEffect(() => {
    if (!auth?.authenticated) return;
    return whenIdle(() => {
      void loadSessionPlayer();
      if (auth.role === 'admin') void loadAdminView();
    });
  }, [auth?.authenticated, auth?.role]);

  const handleActiveSessionCleared = useCallback(() => {
    setAuth((prev) => (prev && prev.activeSessionId !== null ? { ...prev, activeSessionId: null } : prev));
  }, []);

  // Lock all routes into an active non-sandbox test until submitted
  useEffect(() => {
    if (!auth?.authenticated || !auth.activeSessionId) return;
    const lockedPath = `/session/${auth.activeSessionId}`;
    if (path !== lockedPath) {
      if (window.location.pathname !== lockedPath) {
        window.history.replaceState({}, '', lockedPath);
      }
      setPath(lockedPath);
    }
  }, [auth, path]);

  // Redirect non-admin accounts away from /admin so student accounts never see admin UI
  useEffect(() => {
    if (!auth?.authenticated || auth.role === 'admin') return;
    if (path.startsWith('/admin')) {
      window.history.replaceState({}, '', '/');
      setPath('/');
    }
  }, [auth, path]);

  const handleLogout = async () => {
    setLogoutError('');
    try {
      await api.logout();
      setAuth((previous) => ({
        ...previous,
        ...signedOut,
        email: undefined,
        activeSessionId: null,
      }));
      window.history.replaceState({}, '', '/');
      setPath('/');
    } catch {
      setLogoutError(t('app.logoutError'));
    }
  };

  const localDevPinEnabled = auth?.localDevPinEnabled === true;
  const isDisposableDemo = auth?.isDisposableDemo === true;

  const lockedPath =
    auth?.authenticated && auth.activeSessionId ? `/session/${auth.activeSessionId}` : null;
  const effectivePath = lockedPath ?? path;
  const isAdminRoute = effectivePath.startsWith('/admin');
  const sessionMatch = effectivePath.match(/^\/session\/([^/]+)$/);
  const speedInsightsRoute = sessionMatch
    ? '/session/[sessionId]'
    : isAdminRoute
      ? '/admin'
      : effectivePath.startsWith('/progress')
        ? '/progress'
        : '/';

  const demoBanner = isDisposableDemo ? (
    <div
      role="status"
      className="w-full bg-[var(--status-warn-bg)] border-b border-[var(--status-warn)]/25 px-4 py-1.5 text-center text-xs font-medium text-[var(--status-warn)]"
    >
      {t('app.demoBanner', { backend: auth?.backendName || '' })}
    </div>
  ) : null;

  const banner = (
    <>
      {demoBanner}
      {logoutError ? (
        <div role="alert" className="p-3 text-center text-sm text-[var(--status-error)]">
          {logoutError}
        </div>
      ) : null}
    </>
  );

  let content: ReactNode;

  if (loadingAuth) {
    content = (
      <div className="min-h-screen flex items-center justify-center bg-[#F3EFE8] text-sm text-[#4A5955] font-sans-text">
        {t('app.loading')}
      </div>
    );
  } else if (!auth?.authenticated) {
    // Gate unauthenticated visitors
    if (isAdminRoute) {
      content = (
        <>
          {demoBanner}
          <AdminPasswordGate
            localDevPinEnabled={localDevPinEnabled}
            initialError={authError}
            onAuthenticated={onAuthenticated}
            onBackHome={() => navigate('/')}
          />
        </>
      );
    } else {
      content = (
        <>
          {demoBanner}
          <StudentPinGate
            localDevPinEnabled={localDevPinEnabled}
            initialError={authError}
            onAuthenticated={onAuthenticated}
            onGoAdmin={() => navigate('/admin')}
          />
        </>
      );
    }
  } else if (sessionMatch) {
    // Quiet Exam Room — drop the Oat Studio sidebar completely during active sessions
    content = (
      <>
        {demoBanner}
        <Suspense fallback={<RouteFallback label={t('app.loading')} />}>
          <SessionPlayerView
            key={auth.studentId}
            sessionId={decodeURIComponent(sessionMatch[1])}
            studentId={auth.studentId}
            isAdmin={auth.role === 'admin'}
            onNavigate={navigate}
            onActiveSessionCleared={handleActiveSessionCleared}
          />
        </Suspense>
      </>
    );
  } else {
    content = (
      <StudioShell
        currentPath={effectivePath}
        role={auth.role}
        studentId={auth.studentId}
        email={auth.email}
        onNavigate={navigate}
        onSignOut={handleLogout}
        banner={banner}
      >
        {isAdminRoute && auth.role === 'admin' ? (
          <Suspense fallback={<RouteFallback label={t('app.loading')} />}>
            <AdminView onOpenSession={(id) => navigate(`/session/${id}`)} />
          </Suspense>
        ) : effectivePath.startsWith('/progress') ? (
          <Suspense fallback={<RouteFallback label={t('app.loading')} />}>
            <ProgressView onOpenSession={(id) => navigate(`/session/${id}`)} />
          </Suspense>
        ) : (
          <HomeView
            key={auth.studentId}
            onOpenSession={(id, isLocked = true) => {
              if (isLocked) {
                setAuth((prev) => (prev?.authenticated ? { ...prev, activeSessionId: id } : prev));
              }
              navigate(`/session/${id}`);
            }}
            onNavigate={navigate}
          />
        )}
      </StudioShell>
    );
  }

  return (
    <>
      {content}
      <SpeedInsights route={speedInsightsRoute} />
    </>
  );
}
