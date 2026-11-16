import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { assertNoEmulatorInProduction, isFirebaseEmulatorActive } from './firebaseAdmin.ts';

export type AuthRole = 'student' | 'admin';

export interface UserIdentity {
  role: AuthRole;
  studentId: string;
  email?: string;
  authMethod?: 'firebase' | 'local_pin' | 'local_admin';
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  auth?: UserIdentity;
}

export const AUTH_COOKIE_NAME = 'selective_lab_session';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const LEGACY_INSECURE_SECRET = 'selective-lab-dev-session-secret-v1';
let ephemeralProcessSecret: string | null = null;
let warnedEphemeralSecret = false;

export function isLocalDevPinAuthEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  const explicit =
    process.env.ALLOW_LOCAL_DEV_PIN ?? process.env.ALLOW_LOCAL_DEV_LOGIN;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  // In Cloud Run / AI Studio preview (K_SERVICE set), require Firebase Auth unless explicitly opted in
  if (process.env.K_SERVICE) return false;
  // Local dev outside containers: enable only in explicit test mode or when local emulators are running
  return process.env.NODE_ENV === 'test' || isFirebaseEmulatorActive();
}

export function assertAuthRuntimeConfig(): void {
  assertNoEmulatorInProduction();
  if (process.env.NODE_ENV === 'production') {
    if (process.env.ALLOW_DEMO_MEMORY_DB === 'true') {
      throw new Error(
        'Production configuration error: ALLOW_DEMO_MEMORY_DB=true is forbidden in production.'
      );
    }
    if (
      process.env.ALLOW_LOCAL_DEV_PIN === 'true' ||
      process.env.ALLOW_LOCAL_DEV_LOGIN === 'true'
    ) {
      throw new Error(
        'Production configuration error: ALLOW_LOCAL_DEV_PIN must not be enabled in production.'
      );
    }
    const secret = (process.env.SESSION_SECRET || '').trim();
    if (
      !secret ||
      secret === LEGACY_INSECURE_SECRET ||
      secret === 'change-me-in-production' ||
      secret === 'local-preview-secret' ||
      secret.length < 16
    ) {
      throw new Error(
        'Production configuration error: SESSION_SECRET must be set to a strong secret (>= 16 chars).'
      );
    }
  }
}

export function getSessionSecret(): string {
  const secret = (process.env.SESSION_SECRET || '').trim();
  if (process.env.NODE_ENV === 'production') {
    if (
      !secret ||
      secret === LEGACY_INSECURE_SECRET ||
      secret === 'change-me-in-production' ||
      secret === 'local-preview-secret' ||
      secret.length < 16
    ) {
      throw new Error('SESSION_SECRET is missing or insecure in production.');
    }
    return secret;
  }
  if (secret) return secret;
  if (!ephemeralProcessSecret) {
    ephemeralProcessSecret = crypto.randomBytes(32).toString('hex');
    if (!warnedEphemeralSecret && process.env.NODE_ENV !== 'test') {
      warnedEphemeralSecret = true;
      console.warn(
        '[auth] SESSION_SECRET not set; using ephemeral per-process secret for this non-production runtime.'
      );
    }
  }
  return ephemeralProcessSecret;
}

export function getStudentPin(): string {
  return (process.env.STUDENT_PIN || '').trim() || '1234';
}

export function getAdminPassword(): string {
  return (process.env.ADMIN_PASSWORD || '').trim() || 'admin-dev';
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

export function signSessionToken(
  payload: { role: AuthRole; studentId?: string; email?: string; authMethod?: UserIdentity['authMethod'] },
  ttlMs = THIRTY_DAYS_MS,
  secret = getSessionSecret()
): string {
  const identity: UserIdentity = {
    role: payload.role,
    studentId: payload.studentId || 'default-student',
    email: payload.email,
    authMethod: payload.authMethod,
    exp: Date.now() + ttlMs,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(identity));
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', secret).update(encodedPayload).digest()
  );
  return `${encodedPayload}.${sig}`;
}

export function verifySessionToken(
  token: string | undefined,
  secret = getSessionSecret()
): UserIdentity | null {
  if (!token || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, sig] = parts;
  if (!encodedPayload || !sig) return null;

  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', secret).update(encodedPayload).digest()
  );
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<UserIdentity>;
    if (
      (parsed.role !== 'student' && parsed.role !== 'admin') ||
      typeof parsed.studentId !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    if (Date.now() > parsed.exp) return null;
    return {
      role: parsed.role,
      studentId: parsed.studentId,
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      authMethod: parsed.authMethod,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function isHttpsRequest(req?: Request): boolean {
  if (!req) return process.env.NODE_ENV === 'production';
  const proto = String(req.headers['x-forwarded-proto'] || '');
  const origin = String(req.headers.origin || '');
  return Boolean(req.secure || proto.includes('https') || origin.startsWith('https://'));
}

export function setAuthCookie(res: Response, token: string, req?: Request): void {
  const https = isHttpsRequest(req);
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    https ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${Math.floor(THIRTY_DAYS_MS / 1000)}`,
  ];
  if (https) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearAuthCookie(res: Response, req?: Request): void {
  const https = isHttpsRequest(req);
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    https ? 'SameSite=None' : 'SameSite=Lax',
    'Max-Age=0',
  ];
  if (https) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function attachAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  let token: string | undefined;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies[AUTH_COOKIE_NAME];
  }
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
