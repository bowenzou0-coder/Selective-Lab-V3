import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { LoginTicket, OAuth2Client, type TokenPayload } from 'google-auth-library';
import {
  AUTH_COOKIE_NAME,
  assertAuthRuntimeConfig,
  attachAuth,
  isLocalDevPinAuthEnabled,
  parseCookies,
  setAuthCookie,
  signSessionToken,
  verifySessionToken,
  type AuthenticatedRequest,
  type UserIdentity,
} from './auth.ts';
import { getGoogleStudentId, isGoogleAdminEmail, verifyGoogleCredential } from './authGoogle.ts';

const secret = 'test-secret';
const clientId = 'unit-tests.apps.googleusercontent.com';
const googleIdentity = {
  role: 'student',
  studentId: 'google_0123456789',
  email: 'student@gmail.com',
  authMethod: 'google',
  googleSub: '0123456789',
} satisfies Omit<UserIdentity, 'exp'>;

test('sessions reject tampering, expiry and Firebase-era methods', () => {
  const token = signSessionToken(googleIdentity, 60_000, secret);
  const decoded = verifySessionToken(token, secret);
  assert.ok(decoded);
  assert.equal(decoded.role, 'student');
  assert.equal(decoded.studentId, googleIdentity.studentId);

  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(verifySessionToken(tampered, secret), null);
  assert.equal(verifySessionToken(signSessionToken(googleIdentity, -1, secret), secret), null);
  const legacyIdentity = { ...googleIdentity, authMethod: 'firebase' as UserIdentity['authMethod'] };
  assert.equal(verifySessionToken(signSessionToken(legacyIdentity, 60_000, secret), secret), null);
});

test('student identity uses the verified subject and links only explicit legacy IDs', (t) => {
  t.mock.property(process, 'env', {
    ...process.env,
    GOOGLE_LEGACY_STUDENT_IDS: '{"0123456789":"legacyStudent42"}',
  });
  assert.equal(getGoogleStudentId('0123456789'), 'legacyStudent42');
  assert.equal(getGoogleStudentId('9876543210'), 'google_9876543210');
  const old = signSessionToken(googleIdentity, 60_000, secret);
  assert.equal(verifySessionToken(old, secret), null);
  const linked = signSessionToken({ ...googleIdentity, studentId: 'legacyStudent42' }, 60_000, secret);
  assert.equal(verifySessionToken(linked, secret)?.studentId, 'legacyStudent42');

  process.env.GOOGLE_LEGACY_STUDENT_IDS = '{"first":"sameUID","second":"sameUID"}';
  assert.throws(() => assertAuthRuntimeConfig(), /GOOGLE_LEGACY_STUDENT_IDS/);
  process.env.GOOGLE_LEGACY_STUDENT_IDS = '{"first":"default-student"}';
  assert.throws(() => assertAuthRuntimeConfig(), /GOOGLE_LEGACY_STUDENT_IDS/);
  process.env.GOOGLE_LEGACY_STUDENT_IDS = '{"first":"google_second"}';
  assert.throws(() => assertAuthRuntimeConfig(), /GOOGLE_LEGACY_STUDENT_IDS/);
});

test('admin access requires an allowlisted authoritative Google email and follows config changes', (t) => {
  t.mock.property(process, 'env', { ...process.env });
  delete process.env.ADMIN_EMAILS;
  assert.equal(isGoogleAdminEmail('bowenzou0@gmail.com'), true);
  assert.equal(isGoogleAdminEmail('yolandayue0319@gmail.com'), true);
  assert.equal(isGoogleAdminEmail('bowenzou0@gmail.com.evil.example'), false);

  process.env.ADMIN_EMAILS = ' First@Gmail.com , admin@school.example ';
  assert.equal(isGoogleAdminEmail('first@gmail.com'), true);
  assert.equal(isGoogleAdminEmail('admin@school.example', 'school.example'), true);
  assert.equal(isGoogleAdminEmail('admin@school.example'), false);
  assert.equal(isGoogleAdminEmail('admin@school.example', 'other.example'), false);
  assert.equal(isGoogleAdminEmail('bowenzou0@gmail.com'), false);

  const token = signSessionToken({ ...googleIdentity, role: 'admin', email: 'first@gmail.com' }, 60_000, secret);
  assert.equal(verifySessionToken(token, secret)?.role, 'admin');
  process.env.ADMIN_EMAILS = '';
  assert.equal(verifySessionToken(token, secret)?.role, 'student');
});

test('auth uses only the session cookie and forces secure cookie options in production', (t) => {
  t.mock.property(process, 'env', {
    ...process.env,
    NODE_ENV: 'production',
    SESSION_SECRET: 'unit-test-secret-valid-length-32-bytes',
  });

  const token = signSessionToken(googleIdentity);
  const bearerReq = { headers: { authorization: `Bearer ${token}` } } as AuthenticatedRequest;
  const cookieReq = { headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` } } as AuthenticatedRequest;
  let calls = 0;
  const next = () => { calls++; };
  attachAuth(bearerReq, {} as Response, next);
  attachAuth(cookieReq, {} as Response, next);
  assert.equal(calls, 2);
  assert.equal(bearerReq.auth, undefined);
  assert.equal(cookieReq.auth?.studentId, googleIdentity.studentId);
  assert.equal(parseCookies('foo=bar; session=abc%2Edef; theme=warm').session, 'abc.def');

  const cookie = t.mock.fn();
  setAuthCookie({ cookie } as unknown as Response, token, { secure: false } as Request);
  assert.deepEqual(cookie.mock.calls[0].arguments, [
    AUTH_COOKIE_NAME, token, {
      path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 2_592_000_000,
    },
  ]);
});

test('production and Vercel previews reject local credentials and require sign-in configuration', (t) => {
  t.mock.property(process, 'env', {
    ...process.env,
    NODE_ENV: 'development',
    VERCEL: '1',
    SESSION_SECRET: 'unit-test-secret-valid-length-32-bytes',
    GOOGLE_CLIENT_ID: clientId,
    ALLOW_LOCAL_DEV_PIN: 'true',
  });
  delete process.env.ALLOW_DEMO_MEMORY_DB;
  assert.equal(isLocalDevPinAuthEnabled(), false);
  assert.throws(() => assertAuthRuntimeConfig(), /ALLOW_LOCAL_DEV_PIN/);
  const local = signSessionToken({ role: 'admin', studentId: 'default-student', authMethod: 'local_admin' });
  assert.equal(verifySessionToken(local), null);

  delete process.env.ALLOW_LOCAL_DEV_PIN;
  delete process.env.ALLOW_LOCAL_DEV_LOGIN;
  process.env.ALLOW_DEMO_MEMORY_DB = 'true';
  assert.throws(() => assertAuthRuntimeConfig(), /ALLOW_DEMO_MEMORY_DB/);
  delete process.env.ALLOW_DEMO_MEMORY_DB;
  assert.doesNotThrow(() => assertAuthRuntimeConfig());
  process.env.GOOGLE_CLIENT_ID = '';
  assert.throws(() => assertAuthRuntimeConfig(), /GOOGLE_CLIENT_ID/);
  process.env.GOOGLE_CLIENT_ID = clientId;
  process.env.SESSION_SECRET = 'short';
  assert.throws(() => assertAuthRuntimeConfig(), /SESSION_SECRET/);
});

test('Google verification checks audience through the library and requires verified email, nonce and current expiry', async (t) => {
  const claims = {
    iss: 'https://accounts.google.com',
    aud: clientId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: '0123456789',
    email: 'FIRST@gmail.com',
    email_verified: true,
    nonce: 'browser-nonce',
  } satisfies TokenPayload;
  let payload: TokenPayload = claims;
  const verify = t.mock.method(OAuth2Client.prototype, 'verifyIdToken', async () => new LoginTicket('', payload));
  assert.deepEqual(await verifyGoogleCredential('credential', clientId, 'browser-nonce'), {
    sub: claims.sub, email: 'first@gmail.com', name: undefined, hostedDomain: undefined,
  });
  assert.deepEqual(verify.mock.calls[0].arguments, [{ idToken: 'credential', audience: clientId }]);
  await assert.rejects(verifyGoogleCredential('credential', clientId, 'wrong-nonce'), /identity claims/);
  payload = { ...claims, email_verified: false };
  await assert.rejects(verifyGoogleCredential('credential', clientId, 'browser-nonce'), /identity claims/);
  payload = { ...claims, exp: claims.iat - 1 };
  await assert.rejects(verifyGoogleCredential('credential', clientId, 'browser-nonce'), /identity claims/);
});
