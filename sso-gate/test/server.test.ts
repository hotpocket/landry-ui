/**
 * sso-gate/server through the seam a site actually uses: an Express app with
 * the gate mounted, driven over HTTP, with real RS256 access tokens checked by
 * aws-jwt-verify against a JWKS we hold the key for. Nothing in the request
 * path is faked except where the JWKS comes from.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createSsoGate, ssoConfigFromEnv, type SsoGateOptions } from '../server/index.js';

const POOL = 'us-east-1_TestPool';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const CLIENT = 'client-graph';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' }] };

function token(claims: Record<string, unknown> = {}, key = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'k1', typ: 'JWT' };
  const payload = {
    iss: ISSUER,
    sub: 'cognito-sub-1',
    client_id: CLIENT,
    token_use: 'access',
    scope: 'openid email profile',
    username: 'google_1234567890',
    email: 'ann@x.com',
    landry_site: 'graph',
    landry_role: 'user',
    iat: now,
    exp: now + 600,
    ...claims,
  };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64(header)}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256').update(data).sign(key).toString('base64url');
  return `${data}.${sig}`;
}

function app(opts: Partial<SsoGateOptions> = {}) {
  const logs: string[] = [];
  const gate = createSsoGate({ site: 'graph', userPoolId: POOL, clientId: CLIENT, jwks: JWKS, log: (l) => logs.push(l), ...opts });
  const a = express();
  a.use(express.json());
  a.use('/api', gate.requireAuth);
  a.use('/api', gate.router);
  a.get('/api/private', (req, res) => res.json(req.user));
  a.get('/api/admin-only', gate.requireAdmin, (_req, res) => res.json({ ok: true }));
  return { app: a, gate, logs };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

test('no bearer token is 401 with a reason code', async () => {
  const { app: a, logs } = app();
  const res = await request(a).get('/api/private');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'missing bearer token' });
  assert.match(logs[0]!, /^auth reject 401 missing bearer token/);
});

test('a valid access token for this site sets req.user, including the old Google sub', async () => {
  const { app: a } = app();
  const res = await request(a).get('/api/private').set(bearer(token()));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    sub: 'cognito-sub-1',
    email: 'ann@x.com',
    role: 'user',
    site: 'graph',
    googleSub: '1234567890',
  });
});

test('a forged, expired, or other-pool token is 401', async () => {
  const { app: a } = app();
  const now = Math.floor(Date.now() / 1000);
  for (const t of [
    'forged',
    token({}, otherKey),
    token({ exp: now - 10, iat: now - 700 }),
    token({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other' }),
  ]) {
    const res = await request(a).get('/api/private').set(bearer(t));
    assert.equal(res.status, 401, t.slice(0, 20));
    assert.equal(res.body.error, 'token verification failed');
  }
});

test("an ID token, or another site's client, is not accepted as this site's access token", async () => {
  const { app: a } = app();
  assert.equal((await request(a).get('/api/private').set(bearer(token({ token_use: 'id' })))).status, 401);
  assert.equal((await request(a).get('/api/private').set(bearer(token({ client_id: 'client-books' })))).status, 401);
});

test("a token the broker stamped for another site is 403", async () => {
  const { app: a } = app();
  const res = await request(a).get('/api/private').set(bearer(token({ landry_site: 'books' })));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'account not authorized for this app');
});

test('a token with no broker stamp (no role) is 403: the pre-token check did not run', async () => {
  const { app: a } = app();
  const res = await request(a).get('/api/private').set(bearer(token({ landry_role: undefined })));
  assert.equal(res.status, 403);
});

test('/me reports role and isAdmin from the token', async () => {
  const { app: a } = app();
  const user = await request(a).get('/api/me').set(bearer(token()));
  assert.deepEqual(user.body, { email: 'ann@x.com', role: 'user', isAdmin: false, site: 'graph' });
  const admin = await request(a).get('/api/me').set(bearer(token({ landry_role: 'admin' })));
  assert.equal(admin.body.isAdmin, true);
});

test('requireAdmin: 403 for a user, through for an admin', async () => {
  const { app: a } = app();
  assert.equal((await request(a).get('/api/admin-only').set(bearer(token()))).status, 403);
  assert.equal((await request(a).get('/api/admin-only').set(bearer(token({ landry_role: 'admin' })))).status, 200);
});

test('fail closed: missing pool or client id refuses everything unless dev mode is explicit', async () => {
  for (const missing of [{ userPoolId: '' }, { clientId: '' }]) {
    const { app: a } = app(missing);
    assert.equal((await request(a).get('/api/private').set(bearer(token()))).status, 401);
  }
  const dev = app({ userPoolId: '', clientId: '', devMode: true });
  const res = await request(dev.app).get('/api/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.isAdmin, true);
});

test('ssoConfigFromEnv reads the LANDRY_* variables the site-client construct sets', () => {
  assert.deepEqual(
    ssoConfigFromEnv({ LANDRY_SITE: 'graph', LANDRY_USER_POOL_ID: POOL, LANDRY_CLIENT_ID: CLIENT }),
    { site: 'graph', userPoolId: POOL, clientId: CLIENT, devMode: false },
  );
  // AUTH=off is local dev only: inside Lambda it is ignored.
  assert.equal(ssoConfigFromEnv({ AUTH: 'off' }).devMode, true);
  assert.equal(ssoConfigFromEnv({ AUTH: 'off', AWS_LAMBDA_FUNCTION_NAME: 'x' }).devMode, false);
});
