/**
 * sso-gate/server through the seam a site actually uses: an Express app with
 * the gate mounted, driven over HTTP. Google is replaced by an injected
 * verifier — the only part of the request path that is not ours.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  createSsoGate,
  emailAllowed,
  FileAllowListStore,
  ssoConfigFromEnv,
  type IdTokenClaims,
  type SsoGateOptions,
} from '../server/index.js';
import { DynamoAllowListStore, type DocSender } from '../server/dynamo.js';

function fileStore() {
  return new FileAllowListStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sso-gate-')));
}

/** Tokens are just the email they claim; 'bad' fails verification. */
const fakeGoogle = async (idToken: string): Promise<IdTokenClaims | undefined> => {
  if (idToken === 'bad') throw new Error('Token used too late');
  if (idToken === 'no-email') return { sub: 'x' };
  const [email, hd, unverified] = idToken.split('|');
  return {
    sub: `sub-${email}`,
    email: email!,
    email_verified: unverified !== 'unverified',
    name: 'Some One',
    ...(hd ? { hd } : {}),
  };
};

/** An app as a site wires it: gate, then a protected route of its own. */
function app(opts: Partial<SsoGateOptions> = {}) {
  const logs: string[] = [];
  const gate = createSsoGate({
    googleClientId: 'client-123',
    adminEmail: 'Admin@Example.com',
    store: fileStore(),
    verifyIdToken: fakeGoogle,
    log: (l) => logs.push(l),
    ...opts,
  });
  const a = express();
  a.use(express.json());
  a.use('/api', gate.requireAuth);
  a.use('/api', gate.router);
  a.get('/api/private', (req, res) => res.json({ sub: req.user!.sub }));
  return { app: a, gate, logs };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

// --- the gate --------------------------------------------------------------

test('no bearer token is 401 with a reason code', async () => {
  const { app: a, logs } = app();
  const res = await request(a).get('/api/private');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'missing bearer token' });
  assert.match(logs[0]!, /^auth reject 401 missing bearer token GET \/private/);
});

test('a token Google rejects is 401 and the log says why', async () => {
  const { app: a, logs } = app();
  const res = await request(a).get('/api/private').set(bearer('bad'));
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'token verification failed' });
  assert.match(logs[0]!, /lib="Token used too late"/);
});

test('a verified token without an email is 401', async () => {
  const res = await request(app().app).get('/api/private').set(bearer('no-email'));
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'invalid token payload' });
});

test('the verifier is asked about the configured client id', async () => {
  let audience = '';
  const { app: a } = app({
    allowedEmails: ['a@example.com'],
    verifyIdToken: async (t, aud) => {
      audience = aud;
      return fakeGoogle(t);
    },
  });
  await request(a).get('/api/private').set(bearer('a@example.com'));
  assert.equal(audience, 'client-123');
});

test('an allow-listed email Google has not verified is refused', async () => {
  // A Google account can carry an address it never proved it owns; letting
  // that in would let anyone claim an invited (or the Admin's) email.
  const { app: a } = app({ allowedEmails: ['friend@corp.com'] });
  const res = await request(a).get('/api/private').set(bearer('friend@corp.com||unverified'));
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'email not verified' });
});

test('a signed-in account off the allow-list is 403', async () => {
  const { app: a } = app({ allowedEmails: ['owner@example.com'] });
  const res = await request(a).get('/api/private').set(bearer('rando@example.com'));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'account not authorized for this app' });
});

test('an allowed account reaches the route as req.user', async () => {
  const { app: a } = app({ allowedEmails: ['owner@example.com'] });
  const res = await request(a).get('/api/private').set(bearer('Owner@Example.com'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sub: 'sub-Owner@Example.com' });
});

test('the allowed domain admits by hosted domain or email domain', async () => {
  const { app: a } = app({ allowedDomain: 'Corp.com' });
  assert.equal((await request(a).get('/api/private').set(bearer('x@gmail.com|corp.com'))).status, 200);
  assert.equal((await request(a).get('/api/private').set(bearer('y@corp.com'))).status, 200);
  assert.equal((await request(a).get('/api/private').set(bearer('z@gmail.com'))).status, 403);
});

test('an email the Admin added in the store gets in without a redeploy', async () => {
  const store = fileStore();
  const { app: a } = app({ store, allowedEmails: ['owner@example.com'] });
  assert.equal((await request(a).get('/api/private').set(bearer('beta@example.com'))).status, 403);
  await store.addAllowedEmail('beta@example.com');
  assert.equal((await request(a).get('/api/private').set(bearer('beta@example.com'))).status, 200);
});

// --- /me and the Admin's allow-list routes ----------------------------------

test('/me tells a regular user they are not the Admin', async () => {
  const { app: a } = app({ allowedEmails: ['friend@example.com'] });
  const res = await request(a).get('/api/me').set(bearer('friend@example.com'));
  assert.deepEqual(res.body, { email: 'friend@example.com', name: 'Some One', isAdmin: false });
});

test('a regular user cannot read or change the allow-list', async () => {
  const { app: a } = app({ allowedEmails: ['friend@example.com'] });
  const get = await request(a).get('/api/allowlist').set(bearer('friend@example.com'));
  assert.equal(get.status, 403);
  assert.deepEqual(get.body, { error: 'admin only' });
  const post = await request(a)
    .post('/api/allowlist')
    .set(bearer('friend@example.com'))
    .send({ email: 'x@example.com' });
  assert.equal(post.status, 403);
});

test('the Admin (matched case-insensitively) manages the allow-list', async () => {
  const { app: a } = app({ allowedEmails: ['admin@example.com'] });
  const as = bearer('ADMIN@example.com');
  assert.equal((await request(a).get('/api/me').set(as)).body.isAdmin, true);

  assert.deepEqual((await request(a).get('/api/allowlist').set(as)).body, { emails: [] });
  const post = await request(a).post('/api/allowlist').set(as).send({ email: 'Beta@Example.com' });
  assert.deepEqual(post.body, { emails: ['beta@example.com'] });
  assert.equal((await request(a).post('/api/allowlist').set(as).send({ email: 'nope' })).status, 400);
  const del = await request(a).delete('/api/allowlist/beta%40example.com').set(as);
  assert.deepEqual(del.body, { emails: [] });
  const missing = await request(a).delete('/api/allowlist/gone%40example.com').set(as);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'not in allow-list' });
});

test('a failing store answers 500 through the error handler, not a hung request', async () => {
  const broken = {
    listAllowedEmails: async () => {
      throw new Error('store down');
    },
    addAllowedEmail: async () => {
      throw new Error('store down');
    },
    removeAllowedEmail: async () => {
      throw new Error('store down');
    },
  };
  const { app: a } = app({ googleClientId: '', store: broken });
  a.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: 'handled' });
  });
  for (const r of [
    request(a).get('/api/allowlist'),
    request(a).post('/api/allowlist').send({ email: 'a@b.co' }),
    request(a).delete('/api/allowlist/a%40b.co'),
  ]) {
    const res = await r.timeout(2000);
    assert.equal(res.status, 500);
  }
});

test('no Admin configured means nobody is the Admin', async () => {
  const { app: a } = app({ adminEmail: '', allowedEmails: ['admin@example.com'] });
  assert.equal((await request(a).get('/api/me').set(bearer('admin@example.com'))).body.isAdmin, false);
});

// --- local dev: no client id ------------------------------------------------

test('no Google client id: auth is off and the dev user is the Admin', async () => {
  const { app: a, gate } = app({ googleClientId: '' });
  assert.equal(gate.authDisabled, true);
  const me = await request(a).get('/api/me');
  assert.deepEqual(me.body, { email: 'dev@localhost', name: 'Local Dev', isAdmin: true });
  assert.deepEqual((await request(a).get('/api/private')).body, { sub: 'local-dev' });
  assert.equal((await request(a).post('/api/allowlist').send({ email: 'a@b.co' })).status, 200);
});

test('the dev user id can impersonate a real account', async () => {
  const { app: a } = app({ googleClientId: '', devUserSub: 'google-sub-1' });
  assert.deepEqual((await request(a).get('/api/private')).body, { sub: 'google-sub-1' });
});

// --- the allow decision -----------------------------------------------------

test('open mode only when env lists and the store are all empty', async () => {
  const s = fileStore();
  const env = { emails: new Set<string>(), domain: '' };
  assert.equal(await emailAllowed('anyone@example.com', undefined, s, env), true);
  await s.addAllowedEmail('beta@example.com');
  assert.equal(await emailAllowed('anyone@example.com', undefined, s, env), false);
  assert.equal(await emailAllowed('beta@example.com', undefined, s, env), true);
});

test('a configured domain closes open mode', async () => {
  const env = { emails: new Set<string>(), domain: 'corp.com' };
  assert.equal(await emailAllowed('anyone@example.com', undefined, fileStore(), env), false);
});

// --- stores -----------------------------------------------------------------

test('file store: starts empty, lowercases, dedupes, sorts, removes', async () => {
  const s = fileStore();
  assert.deepEqual(await s.listAllowedEmails(), []);
  await s.addAllowedEmail('Friend@Example.com');
  await s.addAllowedEmail('other@example.com');
  await s.addAllowedEmail('friend@example.com');
  assert.deepEqual(await s.listAllowedEmails(), ['friend@example.com', 'other@example.com']);
  assert.equal(await s.removeAllowedEmail('FRIEND@example.com'), true);
  assert.equal(await s.removeAllowedEmail('friend@example.com'), false);
  assert.deepEqual(await s.listAllowedEmails(), ['other@example.com']);
});

test('file store keeps the list at <dataDir>/allowlist.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-gate-'));
  await new FileAllowListStore(dir).addAllowedEmail('a@example.com');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'allowlist.json'), 'utf8'));
  assert.deepEqual(onDisk, { emails: ['a@example.com'] });
});

/** A DynamoDB document client that answers Get/Put against one map. */
function fakeDoc() {
  const items = new Map<string, Record<string, unknown>>();
  const calls: { table: string; key: string; consistent?: boolean }[] = [];
  const keyOf = (k: Record<string, unknown>) => `${k['pk']}|${k['sk']}`;
  const doc = {
    async send(cmd: unknown) {
      if (cmd instanceof GetCommand) {
        const { TableName, Key, ConsistentRead } = cmd.input;
        calls.push({ table: TableName!, key: keyOf(Key!), consistent: ConsistentRead === true });
        return { Item: items.get(keyOf(Key!)) };
      }
      if (cmd instanceof PutCommand) {
        const { TableName, Item } = cmd.input;
        calls.push({ table: TableName!, key: keyOf(Item!) });
        items.set(keyOf(Item!), Item!);
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return { doc, items, calls };
}

// Compile-time: the real document client is what sites pass in.
export const realClientFits: (c: DynamoDBDocumentClient) => DocSender = (c) => c;

test('dynamo store: one CONFIG/ALLOWLIST item in the given table', async () => {
  const { doc, items, calls } = fakeDoc();
  const s = new DynamoAllowListStore(doc, 'SiteTable');
  assert.deepEqual(await s.listAllowedEmails(), []);
  await s.addAllowedEmail('B@example.com');
  await s.addAllowedEmail('a@example.com');
  assert.deepEqual(items.get('CONFIG|ALLOWLIST'), {
    pk: 'CONFIG',
    sk: 'ALLOWLIST',
    emails: ['a@example.com', 'b@example.com'],
  });
  await s.addAllowedEmail('b@example.com');
  assert.deepEqual(await s.listAllowedEmails(), ['a@example.com', 'b@example.com']);
  assert.equal(await s.removeAllowedEmail('A@example.com'), true);
  assert.equal(await s.removeAllowedEmail('a@example.com'), false);
  assert.deepEqual(await s.listAllowedEmails(), ['b@example.com']);
  assert.ok(calls.every((c) => c.table === 'SiteTable' && c.key === 'CONFIG|ALLOWLIST'));
  // Read-modify-write: an eventually consistent read could resurrect an
  // email the Admin just removed.
  assert.ok(calls.filter((c) => 'consistent' in c).every((c) => c.consistent));
});

// --- config from env --------------------------------------------------------

test('ssoConfigFromEnv reads the standard variables and normalises them', () => {
  const c = ssoConfigFromEnv({
    GOOGLE_CLIENT_ID: 'cid',
    ADMIN_EMAIL: ' Admin@Example.com ',
    ALLOWED_EMAILS: 'A@x.com, b@x.com,,',
    ALLOWED_DOMAIN: ' Corp.COM ',
    DEV_USER_SUB: 'sub-1',
  });
  assert.deepEqual(c, {
    googleClientId: 'cid',
    adminEmail: 'admin@example.com',
    allowedEmails: new Set(['a@x.com', 'b@x.com']),
    allowedDomain: 'corp.com',
    devUserSub: 'sub-1',
  });
  assert.deepEqual(ssoConfigFromEnv({}), {
    googleClientId: '',
    adminEmail: '',
    allowedEmails: new Set(),
    allowedDomain: '',
    devUserSub: '',
  });
});
