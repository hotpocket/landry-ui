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

const state = { deny1: false };
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
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
