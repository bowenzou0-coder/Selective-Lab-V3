import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { api, type AuthState, type HealthResponse } from './client/api';
import { AdminView } from './client/components/AdminView';
import { AdminPasswordGate, StudentPinGate } from './client/components/AuthGates';
import { HomeView } from './client/components/HomeView';
import { ProgressView } from './client/components/ProgressView';
import { SessionPlayerView } from './client/components/SessionPlayerView';
import { TopNav } from './client/components/TopNav';
import { auth as firebaseAuth, testFirestoreConnection } from './lib/firebase';

export default function App() {
  const [path, setPath] = useState<string>(() => window.location.pathname || '/');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authSyncError, setAuthSyncError] = useState('');
  const inFlightSyncRef = useRef<Map<string, Promise<AuthState>>>(new Map());

  useEffect(() => {
    api.getHealth().then(setHealth).catch(() => undefined);
    const onPopState = () => {
      setPath(window.location.pathname || '/');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const syncFirebaseUser = useCallback(async (user: User): Promise<AuthState> => {
    const existing = inFlightSyncRef.current.get(user.uid);
    if (existing) return existing;

    const task = (async () => {
      const idToken = await user.getIdToken();
      const loginState = await api.firebaseLogin(idToken);
      setAuthSyncError('');
      setAuth(loginState);
      return loginState;
    })().finally(() => {
      inFlightSyncRef.current.delete(user.uid);
    });

    inFlightSyncRef.current.set(user.uid, task);
    return task;
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
      if (!active) return;
      if (user) {
        testFirestoreConnection().catch(() => undefined);
        try {
          await syncFirebaseUser(user);
        } catch (err) {
          console.error('Firebase session auth failed:', err);
          if (active) {
            setAuthSyncError(
              err instanceof Error
                ? err.message
                : 'Unable to complete server sign-in. Check backend database configuration.'
            );
          }
          const fallback = await api.getMe().catch(() => ({
            authenticated: false,
            role: null,
            studentId: null,
          }));
          if (active) setAuth(fallback);
        } finally {
          if (active) setLoadingAuth(false);
        }
      } else {
        api
          .getMe()
          .then((res) => {
            if (active) setAuth(res);
          })
          .catch(() => {
            if (active) setAuth({ authenticated: false, role: null, studentId: null });
          })
          .finally(() => {
            if (active) setLoadingAuth(false);
          });
      }
    });

    const onExpired = () => {
      setAuth({ authenticated: false, role: null, studentId: null });
    };
    window.addEventListener('nsw-auth-expired', onExpired);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('nsw-auth-expired', onExpired);
    };
  }, [syncFirebaseUser]);

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
    await Promise.all([
      api.logout().catch(() => undefined),
      signOut(firebaseAuth).catch(() => undefined),
    ]);
    setAuthSyncError('');
    setAuth({ authenticated: false, role: null, studentId: null, activeSessionId: null });
    navigate('/');
  };

  if (loadingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-canvas)] text-sm text-[var(--text-secondary)]">
        Loading Selective Lab...
      </div>
    );
  }

  const localDevPinEnabled = auth?.localDevPinEnabled ?? health?.localDevPinEnabled ?? true;
  const isDisposableDemo = Boolean(auth?.isDisposableDemo || health?.isDisposableDemo);

  const lockedPath =
    auth?.authenticated && auth.activeSessionId ? `/session/${auth.activeSessionId}` : null;
  const effectivePath = lockedPath ?? path;
  const isAdminRoute = effectivePath.startsWith('/admin');
  const sessionMatch = effectivePath.match(/^\/session\/([^/]+)$/);

  const demoBanner = isDisposableDemo ? (
    <div
      role="status"
      className="w-full bg-[var(--status-warn-bg)] border-b border-[var(--status-warn)]/30 px-4 py-1.5 text-center text-xs font-medium text-[var(--status-warn)]"
    >
      Disposable In-Memory Preview Mode ({health?.backendName || auth?.backendName || 'memory_preview'}) — data resets on server restart. Configure Firestore or Emulator for persistent storage.
    </div>
  ) : null;

  // Gate unauthenticated visitors
  if (!auth?.authenticated) {
    if (isAdminRoute) {
      return (
        <>
          {demoBanner}
          <AdminPasswordGate
            localDevPinEnabled={localDevPinEnabled}
            initialError={authSyncError}
            onAuthenticated={(next) => {
              setAuthSyncError('');
              setAuth(next);
            }}
            onGoogleAuthenticated={async (user) => {
              await syncFirebaseUser(user);
            }}
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
          initialError={authSyncError}
          onAuthenticated={(next) => {
            setAuthSyncError('');
            setAuth(next);
          }}
          onGoogleAuthenticated={async (user) => {
            await syncFirebaseUser(user);
          }}
          onGoAdmin={() => navigate('/admin')}
        />
      </>
    );
  }

  // Gate /admin if currently logged in only as student
  if (isAdminRoute && auth.role !== 'admin') {
    return (
      <div className="min-h-screen bg-[var(--bg-canvas)]">
        {demoBanner}
        <TopNav
          currentPath={path}
          onNavigate={navigate}
          onPrimaryAction={handleLogout}
          primaryLabel="Sign Out"
        />
        <AdminPasswordGate
          localDevPinEnabled={localDevPinEnabled}
          initialError={authSyncError}
          onAuthenticated={(next) => {
            setAuthSyncError('');
            setAuth(next);
          }}
          onGoogleAuthenticated={async (user) => {
            const nextAuth = await syncFirebaseUser(user);
            if (nextAuth.role !== 'admin') {
              throw new Error('This Google account does not have Admin permissions.');
            }
          }}
          onBackHome={() => navigate('/')}
        />
      </div>
    );
  }

  if (sessionMatch) {
    return (
      <>
        {demoBanner}
        <SessionPlayerView
          sessionId={decodeURIComponent(sessionMatch[1])}
          studentId={auth.studentId || 'default-student'}
          isAdmin={auth.role === 'admin'}
          onNavigate={navigate}
          onActiveSessionCleared={handleActiveSessionCleared}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-canvas)]">
      {demoBanner}
      <TopNav
        currentPath={path}
        onNavigate={navigate}
        onPrimaryAction={handleLogout}
        primaryLabel={auth.role === 'admin' ? 'Admin · Sign Out' : 'Sign Out'}
      />
      {isAdminRoute ? (
        <AdminView onOpenSession={(id) => navigate(`/session/${id}`)} />
      ) : path.startsWith('/progress') ? (
        <ProgressView onOpenSession={(id) => navigate(`/session/${id}`)} />
      ) : (
        <HomeView
          onOpenSession={(id, isLocked = true) => {
            if (isLocked) {
              setAuth((prev) => (prev ? { ...prev, activeSessionId: id } : prev));
            }
            navigate(`/session/${id}`);
          }}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}
