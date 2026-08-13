// sw-cache.test.mjs — the service worker streams, caps, and never poisons.
//
// Run: node test/sw-cache.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
// Served over HTTP: service workers do not register on file://.
//
// Contract under test:
//   A. audio fetched during playback lands in the capped stream cache
//      ('audiobook-stream'), leaving 'audiobook-audio' to explicit offline
//      downloads that must never be evicted underneath their owner
//   B. an error response (403) is not cached, and does not block the same URL
//      from succeeding once the server recovers
//   C. the stream cache is bounded: old entries are evicted once the cap is
//      passed, newest survive
//   D. /api/* requests bypass the service worker's caches entirely
//   E. the shell branch never caches a non-200 response
//   G. a 403 on signed media is repaired in place: the worker mints a fresh
//      signature and retries, once. The signature lives in the URL the audio
//      element is already using, and the page cannot rewrite a URL a fetch is
//      already in flight on — this is the only layer that sees the prefetch
//      and the mid-file seek at all, which are exactly the requests the
//      player's own recovery never gets told about
//   F. a Range that starts past the end of a cached entry is refused with 416,
//      not answered with a malformed 206. Clamping only the END lets `start`
//      overtake it, and the response then carries a negative Content-Length and
//      a backwards Content-Range — which the media element, not this code, has
//      to make sense of
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pwLib = process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright');
const { chromium } = createRequire(import.meta.url)(pwLib);

const outDir = join(here, 'fixture/out');
if (!existsSync(join(outDir, 'index.html'))) execFileSync(join(here, 'fixture/gen.sh'), { stdio: 'inherit' });
const vanilla = join(here, '../audiobook/vanilla');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

// `sig` is the signature the origin will accept right now; anything else 403s,
// which is what an expired one does. `mediaCalls` counts re-mints, because
// "one API call for a burst of denied chapters" is half the contract.
const state = { deny1: false, sig: 'good-1', mediaCalls: 0, mediaStatus: 200,
                mintDenied: false, denyAll: false, audioHits: 0 };
const SPACE = 'a'.repeat(16);
const BOOK = 'bk1';
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  // The API that re-mints a signature for one book.
  const mint = path.match(/^\/api\/books\/([^/]+)\/media$/);
  if (mint) {
    state.mediaCalls++;
    if (state.mediaStatus !== 200) {
      res.writeHead(state.mediaStatus, { 'content-type': 'application/json' });
      res.end('{"error":"no such book"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      // A mint that is itself refused, for the case where re-signing cannot
      // help — an entitlement that is genuinely gone, not merely expired.
      media_query: `Policy=p&Signature=${state.mintDenied ? 'stale' : state.sig}&Key-Pair-Id=KP`,
      media_expires_at: Math.floor(Date.now() / 1000) + 43200,
    }));
    return;
  }

  // Signed media, shaped exactly like production: /priv/<space>/<book>/...
  const signed = path.match(/^\/priv\/([^/]+)\/([^/]+)\/audio\/([^/]+)$/);
  if (signed) {
    state.audioHits++;
    if (state.denyAll || url.searchParams.get('Signature') !== state.sig) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    const body = 'signed-audio-' + signed[3];
    res.writeHead(200, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes',
                         'content-length': body.length });
    res.end(body);
    return;
  }

  if (path.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (path.match(/\/audio\/fake_\d+\.m4a$/)) {
    res.writeHead(200, { 'content-type': 'audio/mp4' });
    res.end('tiny-fake-audio');
    return;
  }
  if (state.deny1 && path.endsWith('chapter_0001.m4a')) {
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end('<Error/>');
    return;
  }
  const base = path === '/sw.js' ? join(vanilla, 'sw.js')
             : path.startsWith('/audiobook/vanilla/') ? join(vanilla, path.slice('/audiobook/vanilla/'.length))
             : join(outDir, path === '/' ? 'index.html' : path.slice(1));
  const file = normalize(base);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  const ext = file.split('.').pop();
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream',
                       'accept-ranges': 'bytes', 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

await page.goto(origin + '/index.html#/test-book');
await page.waitForSelector('.transcript-chunk', { timeout: 5000 });
// The SW must control the page before its fetch handler sees anything — and
// the first load races registration, so reload once it is active.
await page.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise((r) => {
  if (navigator.serviceWorker.controller) return r();
  navigator.serviceWorker.addEventListener('controllerchange', () => r());
})));
await page.reload();
await page.waitForSelector('.transcript-chunk', { timeout: 5000 });

const cacheKeys = (name) => page.evaluate((n) => caches.open(n).then((c) => c.keys())
  .then((ks) => ks.map((k) => new URL(k.url).pathname)), name);

// waitForFunction does not await a promise-returning predicate (the pending
// Promise object is itself truthy) — poll cache state via evaluate instead.
async function pollCache(name, want, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const keys = await cacheKeys(name);
    if (keys.some((p) => p.includes(want))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// --- A: playback populates the stream cache, not the offline cache ---
// Asserted on chapter 2: chapter 1 was fetched before the SW controlled the
// page (first-load race) and the media cache can satisfy it without a fetch
// event, so the boundary load is the honest interception case.
{
  await page.evaluate(() => caches.delete('audiobook-stream'));
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = Math.max(0, a.duration - 0.5);
    return a.play();
  });
  const cached = await pollCache('audiobook-stream', 'chapter_0002.m4a', 8000);
  check(cached, 'A: audio fetched during playback lands in audiobook-stream');
  const offline = await cacheKeys('audiobook-audio');
  check(!offline.some((p) => p.includes('chapter_000')),
        'A: audiobook-audio stays reserved for explicit downloads');
  await page.evaluate(() => document.querySelector('audio').pause());
}

// --- B: a 403 is not cached and does not poison the URL ---
{
  await page.evaluate(() => caches.delete('audiobook-stream'));
  state.deny1 = true;
  const denied = await page.evaluate(() =>
    fetch('/audio/chapter_0001.m4a').then((r) => r.status));
  check(denied === 403, `B: denied fetch surfaces the 403 (got ${denied})`);
  let keys = await cacheKeys('audiobook-stream');
  check(!keys.some((p) => p.includes('chapter_0001')), 'B: the 403 was not cached');
  state.deny1 = false;
  const recovered = await page.evaluate(() =>
    fetch('/audio/chapter_0001.m4a').then((r) => r.status));
  check(recovered === 200, `B: the URL recovers once the server does (got ${recovered})`);
}

// --- C: stream cache is bounded, oldest evicted — under CONCURRENT writes ---
// The player prefetches the next chapter while the current one is still being
// cached, so the bound must hold for concurrent puts, not just a polite
// sequence. A serial loop here hid a lost-update race in the FIFO index.
{
  await page.evaluate(() => caches.delete('audiobook-stream'));
  await page.evaluate(() => Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      fetch('/audio/fake_' + String(i + 1).padStart(2, '0') + '.m4a'))
  ));
  await new Promise((r) => setTimeout(r, 800));   // let waitUntil puts settle
  const keys = (await cacheKeys('audiobook-stream')).filter((p) => p.endsWith('.m4a'));
  check(keys.length <= 20, `C: stream cache bounded under concurrency (${keys.length} entries)`);
  // Order among concurrent fetches is not deterministic; the bound is the
  // contract. A follow-up sequential write must still evict the oldest.
  await page.evaluate(() => fetch('/audio/fake_99.m4a'));
  await new Promise((r) => setTimeout(r, 400));
  const keys2 = (await cacheKeys('audiobook-stream')).filter((p) => p.endsWith('.m4a'));
  check(keys2.length <= 20, `C: still bounded after one more (${keys2.length})`);
  check(keys2.some((p) => p.includes('fake_99')), 'C: newest entry survives');
}

// --- C2: cached entries serve ranges; uncached seeks pass through uncached ---
{
  const sliced = await page.evaluate(() =>
    fetch('/audio/fake_99.m4a', { headers: { Range: 'bytes=2-6' } })
      .then((r) => Promise.all([r.status, r.text()])));
  check(sliced[0] === 206 && sliced[1] === 'ny-fa',
        `C2: cached entry serves a range slice (${sliced[0]} "${sliced[1]}")`);
  await page.evaluate(() => caches.delete('audiobook-stream'));
  const seek = await page.evaluate(() =>
    fetch('/audio/fake_50.m4a', { headers: { Range: 'bytes=5-' } }).then((r) => r.status));
  await new Promise((r) => setTimeout(r, 300));
  const keys = (await cacheKeys('audiobook-stream')).filter((p) => p.endsWith('.m4a'));
  check(!keys.some((p) => p.includes('fake_50')),
        `C2: a mid-file seek into an uncached chapter is not cached (status ${seek})`);
}

// --- C3: explicit offline downloads (audiobook-audio) win over the stream cache ---
{
  await page.evaluate(async () => {
    const offline = await caches.open('audiobook-audio');
    await offline.put(new Request(location.origin + '/audio/fake_77.m4a'),
      new Response('OFFLINE-COPY', { headers: { 'Content-Type': 'audio/mp4' } }));
    const stream = await caches.open('audiobook-stream');
    await stream.put(new Request(location.origin + '/audio/fake_77.m4a'),
      new Response('stream-copy', { headers: { 'Content-Type': 'audio/mp4' } }));
  });
  const body = await page.evaluate(() => fetch('/audio/fake_77.m4a').then((r) => r.text()));
  check(body === 'OFFLINE-COPY', `C3: offline download preferred over stream copy ("${body}")`);
  await page.evaluate(async () => {
    (await caches.open('audiobook-audio')).delete(new Request(location.origin + '/audio/fake_77.m4a'));
  });
}

// --- F: a range past the end of a cached entry is refused ------------------
{
  await page.evaluate(async () => {
    const stream = await caches.open('audiobook-stream');
    await stream.put(new Request(location.origin + '/audio/fake_88.m4a'),
      new Response('0123456789', { headers: { 'Content-Type': 'audio/mp4' } }));
  });
  // Ten bytes cached, and a seek that lands at 5000 — what a stale cache entry
  // for a file that has since grown produces.
  const past = await page.evaluate(() =>
    fetch('/audio/fake_88.m4a', { headers: { Range: 'bytes=5000-6000' } })
      .then((r) => ({ status: r.status, range: r.headers.get('Content-Range'),
                      len: r.headers.get('Content-Length') })));
  check(past.status === 416,
        `F: a start past the end is refused (${past.status}, Content-Range "${past.range}")`);
  check(!past.len || Number(past.len) >= 0,
        `F: and carries no negative Content-Length (${past.len})`);

  // The satisfiable neighbour must be untouched by the guard: an open-ended
  // range at the last byte is legal and is what a seek to the end of a chapter
  // actually sends.
  const lastByte = await page.evaluate(() =>
    fetch('/audio/fake_88.m4a', { headers: { Range: 'bytes=9-' } })
      .then((r) => Promise.all([r.status, r.text()])));
  check(lastByte[0] === 206 && lastByte[1] === '9',
        `F: the last byte is still servable (${lastByte[0]} "${lastByte[1]}")`);
  await page.evaluate(async () => {
    (await caches.open('audiobook-stream')).delete(new Request(location.origin + '/audio/fake_88.m4a'));
  });
}

// --- G: an expired signature is repaired at the worker, once ---------------
//
// The failure this exists for, from a real listener on 2026-08-13: the session
// alive, the cookies fresh, and every uncached chapter 403 because the
// signature baked into the URL had died ten hours earlier. CloudFront uses the
// URL signature and ignores the cookies when both are present, so nothing the
// page could refresh was going to help.
{
  const chapter = (n, q) =>
    `/priv/${SPACE}/${BOOK}/audio/chapter_${n}.m4a?Policy=p&Signature=${q}&Key-Pair-Id=KP`;
  const get = (u, init) => page.evaluate(([url, i]) =>
    fetch(url, i).then((r) => Promise.all([r.status, r.text()])), [u, init || null]);

  // G1: a stale signature is replaced and the chapter arrives.
  {
    await page.evaluate(() => caches.delete('audiobook-stream'));
    state.sig = 'good-1'; state.mediaCalls = 0;
    const [status, body] = await get(chapter('0101', 'expired'));
    check(status === 200, `G: an expired signature is re-minted and retried (got ${status})`);
    check(body === 'signed-audio-chapter_0101.m4a', `G: with the real bytes ("${body}")`);
    check(state.mediaCalls === 1, `G: one re-mint (${state.mediaCalls})`);

    // And the mint is remembered: the NEXT chapter to run into the same dead
    // signature — minutes later, at the next boundary, long after the first
    // mint resolved — reuses it. Re-minting per chapter would put an API call
    // between every chapter of a 1,100-chapter book for the rest of the listen.
    const [next] = await get(chapter('0102', 'expired'));
    check(next === 200, `G: a later chapter recovers too (got ${next})`);
    check(state.mediaCalls === 1,
          `G: on the mint already paid for, not a new one (${state.mediaCalls})`);
  }

  // G2: a burst of denied chapters is ONE re-mint. A chapter boundary and a
  // prefetch fail together, and a mint per denied request would hammer the API
  // at the exact moment the radio is already struggling.
  {
    await page.evaluate(() => caches.delete('audiobook-stream'));
    state.sig = 'good-2'; state.mediaCalls = 0;
    const many = await page.evaluate(([space, book]) => Promise.all(
      ['0201', '0202', '0203', '0204'].map((n) =>
        fetch(`/priv/${space}/${book}/audio/chapter_${n}.m4a?Policy=p&Signature=expired&Key-Pair-Id=KP`)
          .then((r) => r.status))), [SPACE, BOOK]);
    check(many.every((s) => s === 200), `G: every denied chapter recovers (${many.join(',')})`);
    check(state.mediaCalls === 1,
          `G: four denials, one re-mint (${state.mediaCalls})`);
  }

  // G3: a mid-file seek — the request the player's own recovery never sees,
  // because it is issued by the media element inside a chapter already playing.
  {
    await page.evaluate(() => caches.delete('audiobook-stream'));
    state.sig = 'good-3'; state.mediaCalls = 0;
    const [status] = await get(chapter('0301', 'expired'), { headers: { Range: 'bytes=5-' } });
    check(status === 200 || status === 206,
          `G: a mid-file seek is re-signed too (got ${status})`);
  }

  // G4: the retry happens once. A signature that is refused even when fresh is
  // an entitlement that is gone, and reloading it forever is a spin.
  {
    await page.evaluate(() => caches.delete('audiobook-stream'));
    state.sig = 'good-4'; state.mintDenied = true; state.mediaCalls = 0;
    const [status] = await get(chapter('0401', 'expired'));
    check(status === 403, `G: a mint that is also refused surfaces the 403 (got ${status})`);
    check(state.mediaCalls <= 1, `G: and does not loop (${state.mediaCalls} re-mints)`);
    state.mintDenied = false;
  }

  // G5: a book the API will not sign — the reader lost access, or it is gone.
  {
    await page.evaluate(() => caches.delete('audiobook-stream'));
    state.sig = 'good-5'; state.mediaStatus = 404; state.mediaCalls = 0;
    const [status] = await get(chapter('0501', 'expired'));
    check(status === 403, `G: an unsignable book keeps its 403 (got ${status})`);
    state.mediaStatus = 200;
  }

  // G6: this worker ships byte-identical to sites that serve audio unsigned
  // and have no such API. A 403 that is not signed media must not go asking.
  {
    await page.evaluate(() => caches.delete('audiobook-stream'));
    state.deny1 = true; state.mediaCalls = 0;
    const [status] = await get('/audio/chapter_0001.m4a');
    check(status === 403, `G: an unsigned 403 is passed through (got ${status})`);
    check(state.mediaCalls === 0,
          `G: and asks no API that host does not have (${state.mediaCalls} calls)`);
    state.deny1 = false;
  }

  // G8: when the API hands back the signature the URL already carries, there
  // is nothing to retry. Re-issuing an identical URL is not a retry — the
  // network stack coalesces it onto the request that already failed, which is
  // the same trap the stall watchdog hit and why it appends `rsr`.
  {
    await page.evaluate(() => caches.delete('audiobook-stream'));
    state.sig = 'same-sig'; state.denyAll = true;
    state.mediaCalls = 0; state.audioHits = 0;
    const [status] = await get(chapter('0801', 'same-sig'));
    check(status === 403, `G: an unrepairable 403 stays a 403 (got ${status})`);
    check(state.audioHits === 1,
          `G: and the identical URL is not re-issued (${state.audioHits} origin hits)`);
    state.denyAll = false;
  }

  // G7: the repaired chapter is cached under the unsigned key, so the next
  // request needs neither the network nor a signature.
  {
    await page.evaluate(() => caches.delete('audiobook-stream'));
    state.sig = 'good-7'; state.mediaCalls = 0;
    await get(chapter('0701', 'expired'));
    const cached = await pollCache('audiobook-stream', 'chapter_0701.m4a', 4000);
    check(cached, 'G: the recovered chapter is cached');
    const keys = await cacheKeys('audiobook-stream');
    check(!keys.some((p) => p.includes('Signature')),
          'G: keyed without the signature that fetched it');
  }
}

// --- D: /api/* bypasses SW caching ---
{
  await page.evaluate(() => fetch('/api/library'));
  await new Promise((r) => setTimeout(r, 300));
  const names = await page.evaluate(() => caches.keys());
  let found = false;
  for (const n of names) {
    const keys = await cacheKeys(n);
    if (keys.some((p) => p.startsWith('/api/'))) found = true;
  }
  check(!found, 'D: no /api/ response in any cache');
}

// --- E: shell branch does not cache non-200s ---
{
  await page.evaluate(() => fetch('/no-such-shell-file.css'));
  await new Promise((r) => setTimeout(r, 300));
  const names = await page.evaluate(() => caches.keys());
  let found = false;
  for (const n of names) {
    const keys = await cacheKeys(n);
    if (keys.some((p) => p.includes('no-such-shell-file'))) found = true;
  }
  check(!found, 'E: 404 shell response not cached');
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
