import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import {
  api,
  getApiCacheScope,
  prefetchCachedResource,
  setApiCacheScope,
  type AccountDeleteResponse,
  type AuthState,
  type CachedResourceKey,
} from './client/api';
import { AdminPasswordGate, StudentPinGate } from './client/components/AuthGates';
import { ErrorBoundary } from './client/components/ErrorBoundary';
import { HomeView } from './client/components/HomeView';
import { StudioShell } from './client/components/TopNav';
import { useI18n } from './client/i18n';

// Route-level chunks: the dashboard ships in the entry bundle; everything else loads on demand.
const loadAdminView = () => import('./client/components/AdminView');
const loadBenchmarksView = () => import('./client/components/BenchmarksView');
const loadProgressView = () => import('./client/components/ProgressView');
const loadSettingsView = () => import('./client/components/SettingsView');
const loadOnboardingTour = () => import('./client/components/OnboardingTour');
const loadSessionPlayer = () => import('./client/components/SessionPlayerView');
const AdminView = lazy(() => loadAdminView().then((m) => ({ default: m.AdminView })));
const BenchmarksView = lazy(() => loadBenchmarksView().then((m) => ({ default: m.BenchmarksView })));
const ProgressView = lazy(() => loadProgressView().then((m) => ({ default: m.ProgressView })));
const SettingsView = lazy(() => loadSettingsView().then((m) => ({ default: m.SettingsView })));
const OnboardingTour = lazy(() => loadOnboardingTour().then((m) => ({ default: m.OnboardingTour })));
const SessionPlayerView = lazy(() => loadSessionPlayer().then((m) => ({ default: m.SessionPlayerView })));

const PREFETCH_ROUTES: Record<string, { data?: CachedResourceKey; chunk?: () => Promise<unknown> }> = {
  '/': { data: 'dashboard' },
  '/benchmarks': { data: 'benchmarks', chunk: loadBenchmarksView },
  '/progress': { data: 'progress', chunk: loadProgressView },
  '/settings': { data: 'settings', chunk: loadSettingsView },
};

const ONBOARDING_STORAGE_PREFIX = 'selective_lab_onboarding_done:';
const DRAFT_STORAGE_PREFIX = 'selective_lab_draft:';

function clearLocalStudentDrafts(studentId?: string | null): void {
  if (!studentId) return;
  try {
    const prefix = `${DRAFT_STORAGE_PREFIX}${studentId}:`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) window.localStorage.removeItem(k);
  } catch {
    // ignore storage access errors
  }
}

function hasLocalOnboardingDone(studentId?: string | null): boolean {
  if (!studentId) return false;
  try {
    return window.localStorage.getItem(`${ONBOARDING_STORAGE_PREFIX}${studentId}`) === '1';
  } catch {
    return false;
  }
}

function setLocalOnboardingDone(studentId?: string | null, done = true): void {
  if (!studentId) return;
  try {
    const key = `${ONBOARDING_STORAGE_PREFIX}${studentId}`;
    if (done) {
      window.localStorage.setItem(key, '1');
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

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
  const [authNotice, setAuthNotice] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [tourOpen, setTourOpen] = useState(false);
  const autoPromptedTourRef = useRef<string | null>(null);

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
      setAuthNotice('');
    };
    window.addEventListener('nsw-auth-expired', onExpired);
    return () => {
      active = false;
      window.removeEventListener('nsw-auth-expired', onExpired);
    };
  }, []);

  const onAuthenticated = useCallback((identity: AuthState) => {
    setAuthError('');
    setAuthNotice('');
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

  // Hover/focus prefetch for sidebar + bottom-nav tabs (fetches are deduplicated in api.ts).
  const handlePrefetchRoute = useCallback(
    (href: string) => {
      if (!auth?.authenticated || auth.activeSessionId) return;
      if (href.startsWith('/admin')) {
        if (auth.role === 'admin') void loadAdminView();
        return;
      }
      const target = PREFETCH_ROUTES[href];
      if (!target) return;
      void target.chunk?.().catch(() => undefined);
      // Only warm data for the account the cache is bound to (never another learner's scope).
      if (target.data && getApiCacheScope() === auth.studentId) prefetchCachedResource(target.data);
    },
    [auth]
  );

  // Lock onto a session created outside Home (repair drills from Progress or a review), then open it.
  const handleLaunchSession = useCallback(
    (id: string) => {
      setAuth((prev) => (prev?.authenticated ? { ...prev, activeSessionId: id } : prev));
      navigate(`/session/${id}`);
    },
    [navigate]
  );

  const handleActiveSessionCleared = useCallback(() => {
    setAuth((prev) => (prev && prev.activeSessionId !== null ? { ...prev, activeSessionId: null } : prev));
  }, []);

  const handleOnboardingEligible = useCallback(
    (shouldShow: boolean) => {
      if (!shouldShow || !auth?.authenticated || !auth.studentId || auth.activeSessionId) return;
      if (autoPromptedTourRef.current === auth.studentId) return;
      if (hasLocalOnboardingDone(auth.studentId)) return;
      autoPromptedTourRef.current = auth.studentId;
      setTourOpen(true);
    },
    [auth]
  );

  const handleDismissTour = useCallback(() => {
    setTourOpen(false);
    if (auth?.authenticated && auth.studentId) {
      setLocalOnboardingDone(auth.studentId, true);
      void api.setOnboardingStatus(true).catch(() => {
        // local storage already prevents nagging on this device
      });
    }
  }, [auth]);

  const handleReplayTour = useCallback(() => {
    if (auth?.authenticated && auth.studentId) {
      autoPromptedTourRef.current = auth.studentId;
      setLocalOnboardingDone(auth.studentId, false);
    }
    navigate('/');
    setTourOpen(true);
  }, [auth, navigate]);

  const handleStartCalibration = useCallback(async () => {
    if (auth?.authenticated && auth.studentId) {
      setLocalOnboardingDone(auth.studentId, true);
      void api.setOnboardingStatus(true).catch(() => {});
    }
    const res = await api.createSession({ mode: 'diagnostic' });
    setTourOpen(false);
    setAuth((prev) => (prev?.authenticated ? { ...prev, activeSessionId: res.sessionId } : prev));
    navigate(`/session/${res.sessionId}`);
  }, [auth, navigate]);

  const handleAccountDeleted = useCallback(
    (result?: AccountDeleteResponse) => {
      const deletedStudentId = result?.studentId || (auth?.authenticated ? auth.studentId : null);
      setApiCacheScope(null);
      if (deletedStudentId) {
        setLocalOnboardingDone(deletedStudentId, false);
        clearLocalStudentDrafts(deletedStudentId);
      }
      setTourOpen(false);
      autoPromptedTourRef.current = null;
      setAuthError('');
      setAuthNotice(
        result?.isLocalPinAccount
          ? t('settings.localAccountClearedNotice', { studentId: deletedStudentId || 'default-student' })
          : t('settings.accountDeletedNotice')
      );
      setAuth((previous) => ({
        ...previous,
        ...signedOut,
        email: undefined,
        activeSessionId: null,
      }));
      window.history.replaceState({}, '', '/');
      setPath('/');
    },
    [auth, t]
  );

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
    setAuthNotice('');
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
      : effectivePath.startsWith('/settings')
        ? '/settings'
        : effectivePath.startsWith('/benchmarks')
          ? '/benchmarks'
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
            initialNotice={authNotice}
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
            initialNotice={authNotice}
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
        <ErrorBoundary resetKey={effectivePath} fullPage>
          <Suspense fallback={<RouteFallback label={t('app.loading')} />}>
            <SessionPlayerView
              key={`${auth.studentId}:${sessionMatch[1]}`}
              sessionId={decodeURIComponent(sessionMatch[1])}
              studentId={auth.studentId}
              isAdmin={auth.role === 'admin'}
              onNavigate={navigate}
              onActiveSessionCleared={handleActiveSessionCleared}
              onLaunchSession={handleLaunchSession}
            />
          </Suspense>
        </ErrorBoundary>
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
        onPrefetch={handlePrefetchRoute}
        onSignOut={handleLogout}
        banner={banner}
      >
        <ErrorBoundary resetKey={effectivePath}>
          {isAdminRoute && auth.role === 'admin' ? (
            <Suspense fallback={<RouteFallback label={t('app.loading')} />}>
              <AdminView
                currentUserId={auth.studentId}
                onOpenSession={(id) => navigate(`/session/${id}`)}
              />
            </Suspense>
          ) : effectivePath.startsWith('/settings') ? (
            <Suspense fallback={<RouteFallback label={t('app.loading')} />}>
              <SettingsView
                onAccountDeleted={handleAccountDeleted}
                onReplayTour={handleReplayTour}
              />
            </Suspense>
          ) : effectivePath.startsWith('/benchmarks') ? (
            <Suspense fallback={<RouteFallback label={t('app.loading')} />}>
              <BenchmarksView
                onOpenSession={(id, isLocked = true) => {
                  if (isLocked) {
                    setAuth((prev) => (prev?.authenticated ? { ...prev, activeSessionId: id } : prev));
                  }
                  navigate(`/session/${id}`);
                }}
              />
            </Suspense>
          ) : effectivePath.startsWith('/progress') ? (
            <Suspense fallback={<RouteFallback label={t('app.loading')} />}>
              <ProgressView
                onOpenSession={(id) => navigate(`/session/${id}`)}
                onLaunchSession={handleLaunchSession}
                onNavigate={navigate}
              />
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
              onOnboardingEligible={handleOnboardingEligible}
            />
          )}
        </ErrorBoundary>
        {tourOpen && !auth.activeSessionId && (
          <ErrorBoundary resetKey={`${effectivePath}:tour`}>
            <Suspense fallback={null}>
              <OnboardingTour
                open={tourOpen}
                currentPath={effectivePath}
                onNavigate={navigate}
                onDismiss={handleDismissTour}
                onStartCalibration={handleStartCalibration}
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </StudioShell>
    );
  }

  return (
    <ErrorBoundary resetKey={effectivePath} fullPage>
      {content}
      <SpeedInsights route={speedInsightsRoute} />
    </ErrorBoundary>
  );
}
