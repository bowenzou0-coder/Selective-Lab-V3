import { useCallback, useEffect, useState } from 'react';
import { api, type AuthState } from './client/api';
import { AdminView } from './client/components/AdminView';
import { AdminPasswordGate, StudentPinGate } from './client/components/AuthGates';
import { HomeView } from './client/components/HomeView';
import { ProgressView } from './client/components/ProgressView';
import { SessionPlayerView } from './client/components/SessionPlayerView';
import { StudioShell } from './client/components/TopNav';

const signedOut: AuthState = { authenticated: false, role: null, studentId: null };

export default function App() {
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
          setAuthError(err instanceof Error ? err.message : 'Unable to check sign-in status.');
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
      setAuthError('Your session expired. Please sign in again.');
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
      setLogoutError('Unable to sign out. Please try again.');
    }
  };

  if (loadingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F3EFE8] text-sm text-[#4A5955] font-sans-text">
        Loading Selective Lab...
      </div>
    );
  }

  const localDevPinEnabled = auth?.localDevPinEnabled === true;
  const isDisposableDemo = auth?.isDisposableDemo === true;

  const lockedPath =
    auth?.authenticated && auth.activeSessionId ? `/session/${auth.activeSessionId}` : null;
  const effectivePath = lockedPath ?? path;
  const isAdminRoute = effectivePath.startsWith('/admin');
  const sessionMatch = effectivePath.match(/^\/session\/([^/]+)$/);

  const demoBanner = isDisposableDemo ? (
    <div
      role="status"
      className="w-full bg-[var(--status-warn-bg)] border-b border-[var(--status-warn)]/25 px-4 py-1.5 text-center text-xs font-medium text-[var(--status-warn)]"
    >
      Disposable preview storage ({auth?.backendName}) — data resets on server restart.
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

  // Gate unauthenticated visitors
  if (!auth?.authenticated) {
    if (isAdminRoute) {
      return (
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
    }
    return (
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

  // Gate /admin if currently logged in only as student
  if (isAdminRoute && auth.role !== 'admin') {
    return (
      <StudioShell
        currentPath={effectivePath}
        role={auth.role}
        studentId={auth.studentId}
        onNavigate={navigate}
        onSignOut={handleLogout}
        banner={banner}
      >
        <AdminPasswordGate
          embedded
          localDevPinEnabled={localDevPinEnabled}
          initialError={authError}
          onAuthenticated={onAuthenticated}
          onBackHome={() => navigate('/')}
        />
      </StudioShell>
    );
  }

  // Quiet Exam Room — drop the Oat Studio sidebar completely during active sessions
  if (sessionMatch) {
    return (
      <>
        {demoBanner}
        <SessionPlayerView
          key={auth.studentId}
          sessionId={decodeURIComponent(sessionMatch[1])}
          studentId={auth.studentId}
          isAdmin={auth.role === 'admin'}
          onNavigate={navigate}
          onActiveSessionCleared={handleActiveSessionCleared}
        />
      </>
    );
  }

  return (
    <StudioShell
      currentPath={effectivePath}
      role={auth.role}
      studentId={auth.studentId}
      onNavigate={navigate}
      onSignOut={handleLogout}
      banner={banner}
    >
      {isAdminRoute ? (
        <AdminView onOpenSession={(id) => navigate(`/session/${id}`)} />
      ) : effectivePath.startsWith('/progress') ? (
        <ProgressView onOpenSession={(id) => navigate(`/session/${id}`)} />
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
