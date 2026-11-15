import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  attachAuth,
  parseCookies,
  setAuthCookie,
  signSessionToken,
  verifySessionToken,
  type AuthenticatedRequest,
} from './auth';

test('signSessionToken and verifySessionToken preserve role and studentId', () => {
  const secret = 'test-secret-123';
  const token = signSessionToken({ role: 'student', studentId: 'student-42' }, 60_000, secret);
  const decoded = verifySessionToken(token, secret);
  assert.ok(decoded);
  assert.equal(decoded.role, 'student');
  assert.equal(decoded.studentId, 'student-42');
});

test('verifySessionToken rejects tampered or expired tokens', () => {
  const secret = 'test-secret-123';
  const token = signSessionToken({ role: 'student' }, 60_000, secret);
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(verifySessionToken(tampered, secret), null);

  const expired = signSessionToken({ role: 'admin' }, -1000, secret);
  assert.equal(verifySessionToken(expired, secret), null);
});

test('parseCookies decodes cookie pairs cleanly', () => {
  const cookies = parseCookies('foo=bar; nsw_sel_session=abc%2Edef; theme=warm');
  assert.equal(cookies.foo, 'bar');
  assert.equal(cookies.nsw_sel_session, 'abc.def');
  assert.equal(cookies.theme, 'warm');
});

test('attachAuth authenticates Bearer token when cookies are blocked and setAuthCookie sets SameSite=None over HTTPS', () => {
  const token = signSessionToken({ role: 'admin', studentId: 'default-student' }, 60_000);
  const req = {
    headers: {
      authorization: `Bearer ${token}`,
    },
  } as unknown as AuthenticatedRequest;

  let nextCalled = false;
  attachAuth(req, {} as Response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.auth?.role, 'admin');

  let setHeaderValue = '';
  const mockReq = {
    secure: false,
    headers: { 'x-forwarded-proto': 'https' },
  } as unknown as Request;
  const mockRes = {
    setHeader(_name: string, val: string) {
      setHeaderValue = val;
    },
  } as unknown as Response;
  setAuthCookie(mockRes, token, mockReq);
  assert.match(setHeaderValue, /SameSite=None/);
  assert.match(setHeaderValue, /Secure/);
  assert.match(setHeaderValue, /HttpOnly/);
});
