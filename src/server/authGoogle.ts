import type { OAuth2Client } from 'google-auth-library';

let googleClient: OAuth2Client | undefined;
const defaultAdminEmails = 'bowenzou0@gmail.com,yolandayue0319@gmail.com';
const googleSubjectPattern = /^[A-Za-z0-9_-]{1,255}$/;
const legacyStudentIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getGoogleClientId(): string {
  return (process.env.GOOGLE_CLIENT_ID || '').trim();
}

function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? defaultAdminEmails)
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isGoogleAdminEmail(email: string, hostedDomain?: string): boolean {
  const normalized = email.toLowerCase();
  // Google is authoritative for Gmail and for the account's verified Workspace domain.
  const authoritative = normalized.endsWith('@gmail.com') ||
    Boolean(hostedDomain && normalized.endsWith(`@${hostedDomain.toLowerCase()}`));
  return authoritative && getAdminEmails().includes(normalized);
}

let cachedLegacyMap: { raw: string; ids: Map<string, string> } | undefined;

function getLegacyStudentIds(): Map<string, string> {
  const raw = (process.env.GOOGLE_LEGACY_STUDENT_IDS || '').trim();
  if (cachedLegacyMap?.raw === raw) return cachedLegacyMap.ids;

  const ids = new Map<string, string>();
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    const legacyIds = new Set<string>();
    for (const [sub, uid] of Object.entries(parsed)) {
      if (!googleSubjectPattern.test(sub) || typeof uid !== 'string' ||
        !legacyStudentIdPattern.test(uid) || uid.startsWith('google_') ||
        uid === 'default-student' || legacyIds.has(uid)) {
        throw new Error();
      }
      ids.set(sub, uid);
      legacyIds.add(uid);
    }
  } catch {
    throw new Error('GOOGLE_LEGACY_STUDENT_IDS must map Google subjects to distinct legacy student IDs.');
  }
  cachedLegacyMap = { raw, ids };
  return ids;
}

export function assertGoogleAuthConfig(): void {
  const clientId = getGoogleClientId();
  if (clientId && !/^[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(clientId)) {
    throw new Error('GOOGLE_CLIENT_ID must be a Google OAuth web client ID.');
  }
  if (getAdminEmails().some((email) => !emailPattern.test(email))) {
    throw new Error('ADMIN_EMAILS must contain comma-separated email addresses.');
  }
  getLegacyStudentIds();
}

export function getGoogleStudentId(sub: string): string {
  return getLegacyStudentIds().get(sub) ?? `google_${sub}`;
}

export async function verifyGoogleCredential(credential: string, clientId: string, nonce: string) {
  if (!googleClient) {
    const { OAuth2Client } = await import('google-auth-library');
    googleClient ??= new OAuth2Client();
  }
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload || typeof payload.sub !== 'string' || !googleSubjectPattern.test(payload.sub) ||
    typeof payload.email !== 'string' || !emailPattern.test(payload.email) ||
    payload.email_verified !== true || payload.nonce !== nonce ||
    typeof payload.exp !== 'number' || payload.exp <= Date.now() / 1000) {
    throw new Error('Google credential is missing required identity claims.');
  }
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    name: typeof payload.name === 'string' ? payload.name : undefined,
    hostedDomain: typeof payload.hd === 'string' ? payload.hd : undefined,
  };
}
