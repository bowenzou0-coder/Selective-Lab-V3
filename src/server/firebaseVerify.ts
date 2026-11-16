import crypto from 'node:crypto';
import { getPublicFirebaseConfig } from '../shared/firebaseConfig.ts';
import {
  getAdminAuth,
  hasExplicitServiceCredentials,
  isCloudRunOrGcpRuntime,
  isFirebaseEmulatorActive,
} from './firebaseAdmin.ts';

export interface VerifiedFirebaseUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedCerts: Record<string, string> = {};
let certsExpiresAt = 0;

async function getGooglePublicCerts(): Promise<Record<string, string>> {
  if (Date.now() < certsExpiresAt && Object.keys(cachedCerts).length > 0) {
    return cachedCerts;
  }
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Google Firebase certs (${res.status}).`);
  }
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 300_000;
  cachedCerts = (await res.json()) as Record<string, string>;
  certsExpiresAt = Date.now() + maxAgeMs;
  return cachedCerts;
}

function decodeBase64UrlJson<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

async function verifyJwtWithGoogleCerts(idToken: string): Promise<VerifiedFirebaseUser> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(headerB64);
  const payload = decodeBase64UrlJson<{
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  }>(payloadB64);

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Firebase token header.');
  }
  const expectedProjectId = getPublicFirebaseConfig().projectId;
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== expectedProjectId) {
    throw new Error('Firebase token audience mismatch.');
  }
  if (payload.iss !== `https://securetoken.google.com/${expectedProjectId}`) {
    throw new Error('Firebase token issuer mismatch.');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Firebase token missing subject.');
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Firebase token expired.');
  }
  if (!payload.email || payload.email_verified !== true) {
    throw new Error('Verified email address required.');
  }

  let certs = await getGooglePublicCerts();
  let certPem = certs[header.kid];
  if (!certPem) {
    certsExpiresAt = 0;
    certs = await getGooglePublicCerts();
    certPem = certs[header.kid];
  }
  if (!certPem) {
    throw new Error('Matching Google signing certificate not found.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const signature = Buffer.from(sigB64, 'base64url');
  if (!verifier.verify(certPem, signature)) {
    throw new Error('Invalid Firebase token signature.');
  }

  return {
    uid: payload.sub,
    email: payload.email,
    emailVerified: true,
    name: payload.name,
  };
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser> {
  // In emulator or Admin-credentialed server runtimes, verify through Firebase Admin Auth SDK
  // (skip for mocked tests that pass a unit-test RS256 token handled via global fetch mock)
  const useAdminVerify =
    isFirebaseEmulatorActive() ||
    (process.env.NODE_ENV !== 'test' &&
      (hasExplicitServiceCredentials() || isCloudRunOrGcpRuntime()));

  if (useAdminVerify) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken, true);
      if (!decoded.email || !decoded.email_verified) {
        throw new Error('Verified email address required.');
      }
      return {
        uid: decoded.uid,
        email: decoded.email,
        emailVerified: true,
        name: typeof decoded.name === 'string' ? decoded.name : undefined,
      };
    } catch (err) {
      // Allow Auth Emulator unsigned tokens in emulator mode where verifyIdToken handles them directly;
      // if Admin verify explicitly rejected an invalid/revoked token, rethrow.
      if (isFirebaseEmulatorActive() || process.env.NODE_ENV === 'production') {
        throw err instanceof Error ? err : new Error('Firebase ID token verification failed.');
      }
    }
  }

  return verifyJwtWithGoogleCerts(idToken);
}

export function getBootstrappedAdminEmail(): string {
  return (process.env.BOOTSTRAPPED_ADMIN_EMAIL || 'bowenzou0@gmail.com').trim();
}

export const BOOTSTRAPPED_ADMIN_EMAIL = 'bowenzou0@gmail.com';
