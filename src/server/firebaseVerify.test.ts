import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };
import { BOOTSTRAPPED_ADMIN_EMAIL, verifyFirebaseIdToken } from './firebaseVerify.ts';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: string
): string {
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(privateKey).toString('base64url');
  return `${signingInput}.${sig}`;
}

test('verifyFirebaseIdToken verifies valid RS256 Firebase JWTs and rejects invalid/expired/unverified tokens', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ kid_test_1: publicKey }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
    })) as typeof fetch;

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const basePayload = {
      aud: firebaseConfig.projectId,
      iss: `https://securetoken.google.com/${firebaseConfig.projectId}`,
      sub: 'user_uid_123',
      iat: nowSec - 60,
      exp: nowSec + 3600,
      email: BOOTSTRAPPED_ADMIN_EMAIL,
      email_verified: true,
      name: 'Admin User',
    };

    const validToken = signJwt({ alg: 'RS256', kid: 'kid_test_1' }, basePayload, privateKey);
    const verified = await verifyFirebaseIdToken(validToken);
    assert.equal(verified.uid, 'user_uid_123');
    assert.equal(verified.email, BOOTSTRAPPED_ADMIN_EMAIL);
    assert.equal(verified.emailVerified, true);

    // Tampered signature must fail
    const tampered = `${validToken.slice(0, -4)}AAAA`;
    await assert.rejects(() => verifyFirebaseIdToken(tampered), /Invalid Firebase token signature/);

    // Expired token must fail
    const expired = signJwt(
      { alg: 'RS256', kid: 'kid_test_1' },
      { ...basePayload, exp: nowSec - 10 },
      privateKey
    );
    await assert.rejects(() => verifyFirebaseIdToken(expired), /expired/);

    // Wrong audience must fail
    const wrongAud = signJwt(
      { alg: 'RS256', kid: 'kid_test_1' },
      { ...basePayload, aud: 'other-project' },
      privateKey
    );
    await assert.rejects(() => verifyFirebaseIdToken(wrongAud), /audience mismatch/);

    // Unverified email must fail
    const unverified = signJwt(
      { alg: 'RS256', kid: 'kid_test_1' },
      { ...basePayload, email_verified: false },
      privateKey
    );
    await assert.rejects(() => verifyFirebaseIdToken(unverified), /Verified email/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sole admin policy grants admin strictly to bowenzou0@gmail.com', async () => {
  const { isSoleAdminEmail, SOLE_ADMIN_EMAIL } = await import('./firebaseVerify.ts');
  assert.equal(SOLE_ADMIN_EMAIL, 'bowenzou0@gmail.com');
  assert.equal(isSoleAdminEmail('bowenzou0@gmail.com'), true);
  assert.equal(isSoleAdminEmail('  BoWeNzOu0@gmail.com '), true);
  assert.equal(isSoleAdminEmail('other@gmail.com'), false);
  assert.equal(isSoleAdminEmail('bowenzou0@gmail.com.evil.com'), false);
  assert.equal(isSoleAdminEmail(''), false);
  assert.equal(isSoleAdminEmail(null), false);
});
