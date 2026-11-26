import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { assertGoogleAuthConfig, getGoogleClientId, getGoogleStudentId, isGoogleAdminEmail } from './authGoogle.ts';

export type AuthRole = 'student' | 'admin';

export interface UserIdentity {
  role: AuthRole;
  studentId: string;
  email?: string;
  authMethod: 'google' | 'local_pin' | 'local_admin';
  googleSub?: string;
  hostedDomain?: string;
  iat?: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  auth?: UserIdentity;
}

export const AUTH_COOKIE_NAME = 'selective_lab_session';
export const GOOGLE_NONCE_COOKIE_NAME = 'selective_lab_google_nonce';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GOOGLE_NONCE_TTL_MS = 10 * 60 * 1000;
let ephemeralProcessSecret: string | undefined;

function isDeployed(): boolean {
  return process.env.NODE_ENV === 'production' ||
    process.env.VERCEL === '1' || Boolean(process.env.K_SERVICE);
}

export function isLocalDevPinAuthEnabled(): boolean {
  if (isDeployed()) return false;
  const explicit = process.env.ALLOW_LOCAL_DEV_PIN ?? process.env.ALLOW_LOCAL_DEV_LOGIN;
  return explicit === 'true' || (explicit === undefined && process.env.NODE_ENV === 'test');
}

export function assertAuthRuntimeConfig(): void {
  assertGoogleAuthConfig();
  if (!isDeployed()) return;
  if (process.env.ALLOW_DEMO_MEMORY_DB === 'true') {
    throw new Error('Production configuration error: ALLOW_DEMO_MEMORY_DB=true is forbidden in production.');
  }
  if (process.env.ALLOW_LOCAL_DEV_PIN === 'true' || process.env.ALLOW_LOCAL_DEV_LOGIN === 'true') {
    throw new Error('Production configuration error: ALLOW_LOCAL_DEV_PIN must not be enabled in production.');
  }
  getSessionSecret();
  if (!getGoogleClientId()) {
    throw new Error('Production configuration error: GOOGLE_CLIENT_ID is required.');
  }
}

function getSessionSecret(): string {
  const secret = (process.env.SESSION_SECRET || '').trim();
  if (isDeployed()) {
    if (Buffer.byteLength(secret) < 32 ||
      ['selective-lab-dev-session-secret-v1', 'local-dev-session-secret-not-for-prod'].includes(secret)) {
      throw new Error('Production configuration error: SESSION_SECRET must be a strong random secret of at least 32 bytes.');
    }
    return secret;
  }
  return secret || (ephemeralProcessSecret ??= crypto.randomBytes(32).toString('hex'));
}

export function getStudentPin(): string {
  return (process.env.STUDENT_PIN || '').trim() || '1234';
}

export function getAdminPassword(): string {
  return (process.env.ADMIN_PASSWORD || '').trim() || 'admin-dev';
}

function sessionSignature(encoded: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

export function signSessionToken(
  payload: Omit<UserIdentity, 'exp' | 'iat'> & { iat?: number },
  ttlMs = SESSION_TTL_MS,
  secret = getSessionSecret()
): string {
  const issuedAt = typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : Date.now();
  const identity: UserIdentity = { ...payload, iat: issuedAt, exp: issuedAt + ttlMs };
  const encoded = Buffer.from(JSON.stringify(identity)).toString('base64url');
  return `${encoded}.${sessionSignature(encoded, secret)}`;
}

export function getTokenIssuedAtMs(identity: Pick<UserIdentity, 'iat' | 'exp'>): number {
  if (typeof identity.iat === 'number' && Number.isFinite(identity.iat)) {
    return identity.iat;
  }
  return identity.exp - SESSION_TTL_MS;
}

function signatureMatches(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

export function verifySessionToken(
  token: string | undefined,
  secret = getSessionSecret()
): UserIdentity | null {
  if (!token) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  if (!signatureMatches(signature, sessionSignature(encoded, secret))) return null;

  try {
    const identity = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as UserIdentity;
    if (typeof identity.studentId !== 'string' || !identity.studentId ||
      !Number.isFinite(identity.exp) || identity.exp <= Date.now()) {
      return null;
    }
    if (identity.authMethod === 'google') {
      if (typeof identity.googleSub !== 'string' || typeof identity.email !== 'string' ||
        identity.studentId !== getGoogleStudentId(identity.googleSub) ||
        (identity.hostedDomain !== undefined && typeof identity.hostedDomain !== 'string')) {
        return null;
      }
      return {
        ...identity,
        role: isGoogleAdminEmail(identity.email, identity.hostedDomain) ? 'admin' : 'student',
      };
    }
    if (!isLocalDevPinAuthEnabled() || identity.studentId !== 'default-student') return null;
    if (identity.authMethod === 'local_pin' && identity.role === 'student') return identity;
    if (identity.authMethod === 'local_admin' && identity.role === 'admin') return identity;
    return null;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  for (const part of (cookieHeader || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function setCookie(
  res: Response, req: Request, name: string, value: string, maxAgeMs: number, path = '/'
): void {
  res.cookie(name, value, {
    path,
    httpOnly: true,
    secure: isDeployed() || req.secure,
    sameSite: 'lax',
    maxAge: maxAgeMs,
  });
}

export function setAuthCookie(res: Response, token: string, req: Request): void {
  setCookie(res, req, AUTH_COOKIE_NAME, token, SESSION_TTL_MS);
}

export function clearAuthCookie(res: Response, req: Request): void {
  setCookie(res, req, AUTH_COOKIE_NAME, '', 0);
}

export function getGoogleNonce(req: Request): string | undefined {
  const cookie = parseCookies(req.headers.cookie)[GOOGLE_NONCE_COOKIE_NAME] ?? '';
  const [nonce, expiresAt, signature, extra] = cookie.split('.');
  const exp = Number(expiresAt);
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce) || !Number.isSafeInteger(exp) ||
    exp <= Date.now() || !signature || extra !== undefined) {
    return undefined;
  }
  const expected = sessionSignature(`google-login.${nonce}.${expiresAt}`, getSessionSecret());
  if (!signatureMatches(signature, expected)) return undefined;
  return nonce;
}

export function setGoogleNonce(res: Response, req: Request): string {
  const existing = getGoogleNonce(req);
  if (existing) return existing;
  const nonce = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + GOOGLE_NONCE_TTL_MS;
  const signature = sessionSignature(`google-login.${nonce}.${exp}`, getSessionSecret());
  setCookie(res, req, GOOGLE_NONCE_COOKIE_NAME, `${nonce}.${exp}.${signature}`, GOOGLE_NONCE_TTL_MS, '/api/auth');
  return nonce;
}

export function clearGoogleNonce(res: Response, req: Request): void {
  setCookie(res, req, GOOGLE_NONCE_COOKIE_NAME, '', 0, '/api/auth');
}

export function requireSameOriginMutation(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const fetchSite = req.get('Sec-Fetch-Site');
  const origin = req.get('Origin');
  const expectedOrigin = `${isDeployed() ? 'https' : req.protocol}://${req.get('Host')}`;
  if ((fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') ||
    (origin && origin !== expectedOrigin)) {
    res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    return;
  }
  next();
}

export function attachAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME];
  req.auth = verifySessionToken(token) ?? undefined;
  next();
}

export function requireStudentOrAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  next();
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Admin authentication required.' });
    return;
  }
  if (req.auth.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: Admin privileges required.' });
    return;
  }
  next();
}
