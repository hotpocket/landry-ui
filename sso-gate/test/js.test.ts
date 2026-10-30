/**
 * sso-gate/js (plain-JS client) driven the way a page drives it: create,
 * init on load, read status. The browser is a small fake: a URL, two storages
 * (which can be made to THROW from the getter, as iOS Safari "Block All
 * Cookies" does), and a fetch that plays the broker's token endpoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LandryAuth = require('../js/landry-auth.js');

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: object) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
const now = () => Math.floor(Date.now() / 1000);
const access = (extra: object = {}) =>
  jwt({ email: 'ann@x.com', landry_site: 'graph', landry_role: 'user', exp: now() + 3600, ...extra });

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

function browser(url: string, opts: { blocked?: boolean; shared?: { local: MemStorage; session: MemStorage } } = {}) {
  const local = opts.shared?.local ?? new MemStorage();
  const session = opts.shared?.session ?? new MemStorage();
  const calls: { url: string; body: URLSearchParams | null; headers: Record<string, string> }[] = [];
  let tokenAnswer: () => { status: number; body: object } = () => ({
    status: 200,
    body: { access_token: access(), id_token: jwt({}), refresh_token: 'r1', expires_in: 3600 },
  });
  const win: any = {
    location: new URL(url),
    navigated: null as string | null,
    history: { replaceState: (_s: unknown, _t: string, u: string) => { win.location = new URL(u, win.location); } },
  };
  Object.defineProperty(win, 'localStorage', { get() { if (opts.blocked) throw new Error('SecurityError'); return local; } });
  Object.defineProperty(win, 'sessionStorage', { get() { if (opts.blocked) throw new Error('SecurityError'); return session; } });
  const fetch = async (u: string, init: any = {}) => {
    const body = init.body ? new URLSearchParams(init.body) : null;
    calls.push({ url: u, body, headers: init.headers ?? {} });
    if (u.endsWith('/oauth2/token')) {
      const a = tokenAnswer();
      return new Response(JSON.stringify(a.body), { status: a.status });
    }
    if (u.endsWith('/oauth2/revoke')) return new Response('', { status: 200 });
    const h = new Headers(init.headers);
    return new Response(JSON.stringify({ ok: true, auth: h.get('Authorization'), type: h.get('Content-Type') }), { status: 200 });
  };
  const auth = LandryAuth.create({
    site: 'graph',
    clientId: 'cid',
    hostedDomain: 'https://auth.landry.bot',
    apiUrl: 'https://api.auth.landry.bot',
    window: win,
    fetch,
    navigate: (u: string) => { win.navigated = u; },
  });
  return { auth, win, calls, local, session, setToken: (f: typeof tokenAnswer) => { tokenAnswer = f; } };
}

test('a first visit is signed out; signIn goes to the broker with PKCE and Google preselected', async () => {
  const b = browser('https://graph.landry.bot/some/page?x=1');
  assert.equal((await b.auth.init()).status, 'signedOut');
  await b.auth.signIn();
  const u = new URL(b.win.navigated);
  assert.equal(u.origin + u.pathname, 'https://auth.landry.bot/oauth2/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('identity_provider'), 'Google');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((u.searchParams.get('code_challenge') ?? '').length >= 43);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://graph.landry.bot/');
  assert.ok(u.searchParams.get('state'));
});

test('coming back with a code: exchanged with the verifier, URL cleaned, back on the page they left', async () => {
  const first = browser('https://graph.landry.bot/some/page?x=1');
  await first.auth.init();
  await first.auth.signIn();
  const sent = new URL(first.win.navigated);
  const back = browser(`https://graph.landry.bot/?code=abc&state=${sent.searchParams.get('state')}`, {
    shared: { local: first.local, session: first.session },
  });
  const s = await back.auth.init();
  assert.equal(s.status, 'signedIn');
  assert.deepEqual(s.user, { email: 'ann@x.com', role: 'user', site: 'graph', isAdmin: false });
  const ex = back.calls.find((c) => c.url.endsWith('/oauth2/token'))!;
  assert.equal(ex.body!.get('grant_type'), 'authorization_code');
  assert.equal(ex.body!.get('code'), 'abc');
  assert.ok(ex.body!.get('code_verifier'));
  assert.equal(back.win.location.href, 'https://graph.landry.bot/some/page?x=1');
});

test('a code with a state we did not issue is refused and never exchanged', async () => {
  const b = browser('https://graph.landry.bot/?code=abc&state=forged');
  const s = await b.auth.init();
  assert.equal(s.status, 'error');
  assert.equal(b.calls.length, 0);
  assert.equal(b.win.location.search, '');
});

test('the broker refusing (not on the allow-list) is "denied", not an error', async () => {
  const b = browser(
    'https://graph.landry.bot/?error_description=PreTokenGeneration+failed+with+error+not_allowed.&error=invalid_request',
  );
  const s = await b.auth.init();
  assert.equal(s.status, 'denied');
  assert.equal(b.win.location.search, '');
});

test('a returning visitor is signed in from the stored session; an expired access token is refreshed', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access({ exp: now() - 5 }), refresh: 'r0' }));
  const s = await b.auth.init();
  assert.equal(s.status, 'signedIn');
  const r = b.calls.find((c) => c.url.endsWith('/oauth2/token'))!;
  assert.equal(r.body!.get('grant_type'), 'refresh_token');
  assert.equal(r.body!.get('refresh_token'), 'r0');
});

test('refresh refused (removed from the site, or revoked) signs out and tells listeners', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access({ exp: now() - 5 }), refresh: 'r0' }));
  b.setToken(() => ({ status: 400, body: { error: 'invalid_grant' } }));
  const seen: unknown[] = [];
  b.auth.onChange((s: any) => seen.push(s.status));
  assert.equal((await b.auth.init()).status, 'signedOut');
  assert.equal(b.local.getItem('landry.graph.auth'), null);
  assert.deepEqual(seen, ['signedOut']);
});

test('concurrent token requests share one refresh, and nobody gets an empty token meanwhile', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access(), refresh: 'r0' }));
  await b.auth.init();
  b.auth.expireForTest();
  const tokens = await Promise.all([b.auth.accessToken(), b.auth.accessToken(), b.auth.accessToken()]);
  assert.equal(b.calls.filter((c) => c.url.endsWith('/oauth2/token')).length, 1);
  assert.ok(tokens.every((t: string) => t && t.split('.').length === 3));
});

test('auth.fetch sends the bearer token', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access(), refresh: 'r0' }));
  await b.auth.init();
  const res = await (await b.auth.fetch('/api/thing')).json();
  assert.match(res.auth, /^Bearer /);
});

test('members API talks to the broker for this site', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access({ landry_role: 'admin' }), refresh: 'r0' }));
  await b.auth.init();
  await b.auth.members.list();
  await b.auth.members.add('New@x.com', 'user');
  await b.auth.members.remove('a b@x.com');
  const urls = b.calls.map((c) => c.url).filter((u) => u.includes('api.auth'));
  assert.deepEqual(urls, [
    'https://api.auth.landry.bot/sites/graph/members',
    'https://api.auth.landry.bot/sites/graph/members',
    'https://api.auth.landry.bot/sites/graph/members/a%20b%40x.com',
  ]);
});

test('signOut forgets tokens, revokes the refresh token, and leaves through the broker logout', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access(), refresh: 'r0' }));
  await b.auth.init();
  await b.auth.signOut();
  assert.equal(b.local.getItem('landry.graph.auth'), null);
  assert.ok(b.calls.some((c) => c.url.endsWith('/oauth2/revoke') && c.body!.get('token') === 'r0'));
  const u = new URL(b.win.navigated);
  assert.equal(u.pathname, '/logout');
  assert.equal(u.searchParams.get('logout_uri'), 'https://graph.landry.bot/');
});

test('Block All Cookies: storage getters throw, init still answers with a sentence, nothing throws', async () => {
  const b = browser('https://graph.landry.bot/', { blocked: true });
  const s = await b.auth.init();
  assert.equal(s.status, 'signedOut');
  assert.equal(b.auth.storageBlocked, true);
  // Leaving would strand the PKCE verifier in memory: the return could only fail.
  await b.auth.signIn();
  assert.equal(b.win.navigated, null);
  assert.equal(b.auth.status.status, 'error');
  assert.match(b.auth.status.message, /cookies/i);
  const back = browser('https://graph.landry.bot/?code=abc&state=s', { blocked: true });
  const r = await back.auth.init();
  assert.equal(r.status, 'error');
  assert.match(r.message, /cookies/i);
});

test('auth.fetch keeps headers given as a Headers object or pairs', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access(), refresh: 'r0' }));
  await b.auth.init();
  for (const headers of [new Headers({ 'Content-Type': 'application/json' }), [['Content-Type', 'application/json']]]) {
    const res = await (await b.auth.fetch('/api/thing', { headers })).json();
    assert.equal(res.type, 'application/json');
    assert.match(res.auth, /^Bearer /);
  }
});

test('a refresh that lands after sign-out is thrown away, not saved', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access(), refresh: 'r0' }));
  await b.auth.init();
  b.setToken(() => ({ status: 200, body: { access_token: access(), refresh_token: 'r9' } }));
  b.auth.expireForTest();
  const pending = b.auth.accessToken();
  await b.auth.signOut();
  await pending.catch(() => null);
  assert.equal(b.local.getItem('landry.graph.auth'), null);
  assert.equal(b.auth.status.status, 'signedOut');
});

test('listeners hear a role change at refresh, not only status changes', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem('landry.graph.auth', JSON.stringify({ access: access(), refresh: 'r0' }));
  await b.auth.init();
  const seen: string[] = [];
  b.auth.onChange((s: any) => seen.push(`${s.status}:${s.user?.role}`));
  b.setToken(() => ({ status: 200, body: { access_token: access({ landry_role: 'admin' }), refresh_token: 'r1' } }));
  b.auth.expireForTest();
  await b.auth.accessToken();
  assert.deepEqual(seen, ['signedIn:admin']);
});

test('a storage that takes reads but refuses writes still remembers in memory', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.setItem = () => { throw new Error('QuotaExceededError'); };
  b.setToken(() => ({ status: 200, body: { access_token: access(), refresh_token: 'r1' } }));
  const first = browser('https://graph.landry.bot/x');
  await first.auth.init();
  await first.auth.signIn();
  const state = new URL(first.win.navigated).searchParams.get('state');
  const back = browser(`https://graph.landry.bot/?code=c&state=${state}`, { shared: { local: b.local, session: first.session } });
  assert.equal((await back.auth.init()).status, 'signedIn');
  assert.ok(await back.auth.accessToken());
});

test('sessionStorage that reads but refuses writes: sign-in stays put and says why', async () => {
  const b = browser('https://graph.landry.bot/');
  b.session.setItem = () => { throw new Error('QuotaExceededError'); };
  await b.auth.init();
  await b.auth.signIn();
  assert.equal(b.win.navigated, null);
  assert.equal(b.auth.status.status, 'error');
});

test('localStorage blocked but sessionStorage fine: sign-in stays put (the return would be refused)', async () => {
  const b = browser('https://graph.landry.bot/');
  b.local.getItem = () => { throw new Error('SecurityError'); };
  const auth = LandryAuth.create({ site: 'graph', clientId: 'cid', window: b.win, fetch: async () => new Response('{}'), navigate: (u: string) => { b.win.navigated = u; } });
  await auth.init();
  await auth.signIn();
  assert.equal(b.win.navigated, null);
  assert.equal(auth.status.status, 'error');
});
