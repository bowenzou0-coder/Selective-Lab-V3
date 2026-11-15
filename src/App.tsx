import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { api, type AuthState } from './client/api';
import { AdminView } from './client/components/AdminView';
import { AdminPasswordGate, StudentPinGate } from './client/components/AuthGates';
import { HomeView } from './client/components/HomeView';
import { ProgressView } from './client/components/ProgressView';
import { SessionPlayerView } from './client/components/SessionPlayerView';
import { TopNav } from './client/components/TopNav';
import { ensureUserDocuments, pullFirestoreSyncState } from './client/firestoreSync';
import { auth as firebaseAuth } from './lib/firebase';

const BOOTSTRAPPED_ADMIN_EMAIL = 'bowenzou0@gmail.com';

export default function App() {
  const [path, setPath] = useState<string>(() => window.location.pathname || '/');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const inFlightSyncRef = useRef<Map<string, Promise<AuthState>>>(new Map());

  useEffect(() => {
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
      const isAdmin =
        (user.email || '').toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase();
      await ensureUserDocuments(user, isAdmin);
      const idToken = await user.getIdToken();
      const loginState = await api.firebaseLogin(idToken);
      const syncPayload = await pullFirestoreSyncState(user.uid, loginState.role === 'admin');
      const hydrated = await api.hydrateSync(syncPayload);
      const mergedAuth: AuthState = {
        ...loginState,
        activeSessionId: hydrated.activeSessionId ?? loginState.activeSessionId ?? null,
      };
      setAuth(mergedAuth);
      return mergedAuth;
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
        try {
          await syncFirebaseUser(user);
        } catch (err) {
          console.error('Firebase session sync failed:', err);
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

  const navigate = useCallback((nextPath: string) => {
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  // Lock student routes into an active non-sandbox test until submitted
  useEffect(() => {
    if (!auth?.authenticated || !auth.activeSessionId) return;
    if (auth.role === 'admin' && (path.startsWith('/admin') || path.startsWith('/session/'))) return;
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

  const isAdminRoute = path.startsWith('/admin');
  const sessionMatch = path.match(/^\/session\/([^/]+)$/);

  // Gate unauthenticated visitors
  if (!auth?.authenticated) {
    if (isAdminRoute) {
      return (
        <AdminPasswordGate
          onAuthenticated={(next) => setAuth(next)}
          onGoogleAuthenticated={async (user) => {
            await syncFirebaseUser(user);
          }}
          onBackHome={() => navigate('/')}
        />
      );
    }
    return (
      <StudentPinGate
        onAuthenticated={(next) => setAuth(next)}
        onGoogleAuthenticated={async (user) => {
          await syncFirebaseUser(user);
        }}
        onGoAdmin={() => navigate('/admin')}
      />
    );
  }

  // Gate /admin if currently logged in only as student
  if (isAdminRoute && auth.role !== 'admin') {
    return (
      <div className="min-h-screen bg-[var(--bg-canvas)]">
        <TopNav
          currentPath={path}
          onNavigate={navigate}
          onPrimaryAction={handleLogout}
          primaryLabel="Sign Out"
        />
        <AdminPasswordGate
          onAuthenticated={(next) => setAuth(next)}
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
      <SessionPlayerView
        sessionId={decodeURIComponent(sessionMatch[1])}
        isAdmin={auth.role === 'admin'}
        onNavigate={navigate}
        onActiveSessionCleared={() =>
          setAuth((prev) => (prev ? { ...prev, activeSessionId: null } : prev))
        }
      />
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-canvas)]">
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
