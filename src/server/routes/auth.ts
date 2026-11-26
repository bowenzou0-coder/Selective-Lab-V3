import path from 'node:path';
import express, { type Express } from 'express';
import { clearAuthCookie, clearGoogleNonce, getAdminPassword, getGoogleNonce, getStudentPin, isLocalDevPinAuthEnabled, requireStudentOrAdmin, setAuthCookie, setGoogleNonce, signSessionToken, type AuthenticatedRequest, type UserIdentity } from '../auth.ts';
import { getGoogleClientId, getGoogleStudentId, isGoogleAdminEmail, verifyGoogleCredential } from '../authGoogle.ts';
import { readMediaBytesFromStorage } from '../mediaService.ts';
import type { AppContext } from '../context.ts';
import { UPLOADS_DIR } from '../paths.ts';
import { findActiveSessionId } from '../sessionLifecycle.ts';

/** Health, media bytes and sign-in routes (/api/health, /api/media, /api/auth/*). */
export function registerAuthRoutes(app: Express, ctx: AppContext): void {
  const { repo, backendName } = ctx;
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      backendName,
      isDisposableDemo: backendName === 'memory_preview',
      localDevPinEnabled: isLocalDevPinAuthEnabled(),
    });
  });

  // Media stored with the question bank survives serverless cold starts.
  app.get('/api/media/:assetId', async (req, res) => {
    try {
      const asset = await repo.getMediaAsset(req.params.assetId);
      if (!asset) {
        res.status(404).json({ error: 'Media asset not found.' });
        return;
      }
      const buf = await readMediaBytesFromStorage(asset, UPLOADS_DIR);
      if (!buf) {
        res.status(404).json({ error: 'Media binary missing from storage.' });
        return;
      }
      res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.send(buf);
    } catch (err) {
      console.error('GET /api/media/:assetId error:', err);
      res.status(500).json({ error: 'Failed to load media asset.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Auth Routes
  // ---------------------------------------------------------------------------
  const getAuthState = async (identity?: Omit<UserIdentity, 'exp'>) => ({
    authenticated: Boolean(identity),
    role: identity?.role ?? null,
    studentId: identity?.studentId ?? null,
    email: identity?.email,
    activeSessionId: identity ? await findActiveSessionId(repo, identity.studentId) : null,
    backendName,
    isDisposableDemo: backendName === 'memory_preview',
    localDevPinEnabled: isLocalDevPinAuthEnabled(),
  });

  async function completeLogin(
    req: express.Request, res: express.Response, identity: Omit<UserIdentity, 'exp' | 'iat'>
  ) {
    await ctx.ensureSeeded();
    const state = await getAuthState(identity);
    setAuthCookie(res, signSessionToken({ ...identity, iat: ctx.getFreshTokenIat(identity.studentId) }), req);
    clearGoogleNonce(res, req);
    res.json(state);
  }

  app.get('/api/auth/me', async (req: AuthenticatedRequest, res) => {
    try {
      res.json(await getAuthState(req.auth));
    } catch (err) {
      console.error('GET /api/auth/me active-session check failed:', err);
      res.status(503).json({ error: 'Unable to verify active session lock right now.' });
    }
  });

  app.get('/api/auth/google-config', (req, res) => {
    const clientId = getGoogleClientId();
    res.json({ clientId, nonce: clientId ? setGoogleNonce(res, req) : null });
  });

  app.post('/api/auth/student-login', async (req, res) => {
    if (!isLocalDevPinAuthEnabled()) {
      res.status(403).json({ error: 'Local PIN sign-in is disabled. Sign in with Google.' });
      return;
    }
    const pin = String(req.body?.pin ?? '').trim();
    if (!pin || pin !== getStudentPin()) {
      res.status(401).json({ error: 'Incorrect PIN. Please try again.' });
      return;
    }
    try {
      await completeLogin(req, res, { role: 'student', studentId: 'default-student', authMethod: 'local_pin' });
    } catch (err) {
      console.error('POST /api/auth/student-login persistence error:', err);
      res.status(503).json({ error: 'Unable to complete sign-in right now.' });
    }
  });

  app.post('/api/auth/admin-login', async (req, res) => {
    if (!isLocalDevPinAuthEnabled()) {
      res.status(403).json({ error: 'Local admin password sign-in is disabled. Sign in with Google.' });
      return;
    }
    const password = String(req.body?.password ?? '');
    if (!password || password !== getAdminPassword()) {
      res.status(401).json({ error: 'Incorrect admin password.' });
      return;
    }
    try {
      await completeLogin(req, res, { role: 'admin', studentId: 'default-student', authMethod: 'local_admin' });
    } catch (err) {
      console.error('POST /api/auth/admin-login persistence error:', err);
      res.status(503).json({ error: 'Unable to complete sign-in right now.' });
    }
  });

  app.post('/api/auth/google-login', async (req, res) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Google sign-in requires a JSON request.' });
      return;
    }
    const clientId = getGoogleClientId();
    if (!clientId) {
      res.status(503).json({ error: 'Google sign-in is currently unavailable.' });
      return;
    }
    const { credential, admin } = req.body ?? {};
    if (typeof credential !== 'string' || !credential || credential.length > 8192) {
      res.status(400).json({ error: 'A Google credential is required.' });
      return;
    }
    const nonce = getGoogleNonce(req);
    if (!nonce) {
      res.status(401).json({ error: 'The sign-in request expired. Please try again.' });
      return;
    }

    let googleUser;
    try {
      googleUser = await verifyGoogleCredential(credential, clientId, nonce);
    } catch {
      res.status(401).json({ error: 'Unable to verify Google sign-in. Please try again.' });
      return;
    }

    const { sub, email, name, hostedDomain } = googleUser;
    const isAdmin = isGoogleAdminEmail(email, hostedDomain);
    if (admin === true && !isAdmin) {
      res.status(403).json({ error: 'This Google account does not have admin access.' });
      return;
    }
    const studentId = getGoogleStudentId(sub);
    try {
      await repo.upsertUserFromAuth({ uid: studentId, email, displayName: name, isBootstrappedAdmin: isAdmin });
      await completeLogin(req, res, {
        role: isAdmin ? 'admin' : 'student',
        studentId,
        email,
        authMethod: 'google',
        googleSub: sub,
        hostedDomain,
      });
    } catch (err) {
      console.error('POST /api/auth/google-login persistence error:', err);
      res.status(503).json({ error: 'Unable to complete sign-in right now.' });
    }
  });

  // Disabled on normal user path per V3 architecture decision: move migration to /api/admin/migrate/*
  app.post('/api/sync/hydrate', requireStudentOrAdmin, (_req, res) => {
    res.status(410).json({
      error:
        'Browser client hydration on /api/sync/hydrate is retired. Authoritative data loads directly from the server.',
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res, req);
    clearGoogleNonce(res, req);
    res.json({ ok: true });
  });
}
