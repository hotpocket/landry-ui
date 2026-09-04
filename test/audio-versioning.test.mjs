// audio-versioning.test.mjs — a re-rendered chapter reaches the reader.
//
// Run: node test/audio-versioning.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
// Served over HTTP: service workers do not register on file://.
//
// A FEATURE suite: it loads the Preact build from audiobook/player directly,
// and it builds its own page rather than using test/fixture/out — the fixture
// has no content hashes and no signed path, which are the two things under
// test here.
//
// THE CLASS: every artifact derived from source/N.txt that is addressed by a
// name which does not move when the text does.
//
// The measurement that produced this suite, 2026-08-25. A reader in a FRESH
// incognito profile requested
//
//   /priv/<space>/<book>/audio/chapter_0003.m4a?Policy=…&Signature=…
//
// and was served 200, `Age: 165651`, `X-Cache: Hit from cloudfront`,
// `Cache-Control: public, max-age=31536000, immutable`, ETag of a render that
// had been replaced in S3 twenty hours earlier. Readers with the site
// installed as a PWA held copies older still. Nothing was broken: every cache
// in the path was told it could keep that name for a year, and the name did
// not move when the audio did.
//
// So the name moves now. `?v=<content_hash>` — the parameter transcripts.json
// has carried since the same defect bit the text tier — and the S3 key,
// the object, and the upload are all untouched.
//
// Contract under test:
//   A. the audio element's URL carries the chapter's content hash
//   A2. and a host whose manifest has no hashes gets no parameter at all, so A
//       cannot be passing because the player appends one unconditionally
//   B. the service worker's cache key KEEPS `v` and strips the signature: one
//      cached object per RENDER, not one per signature and not one forever
//   C. the defect, reproduced on purpose and then shown fixed. The old URL
//      still answers from cache with the old bytes — that is what a reader was
//      seeing — while the versioned URL cannot be answered by it
//   D. activate() evicts audio cached under a signed path with no version,
//      BESIDE a versioned sibling — which is every byte of a book that has
//      moved to content addressing and was cached before it did. Two things it
//      must not touch: an unsigned host's downloads (this worker ships
//      byte-identical to sites with no API and no hashes — RETIREMENT.md), and
//      a book here whose manifest has no hashes yet, where an unversioned entry
//      is the CURRENT one and deleting it costs the reader a re-download on
//      every shell deploy
//   E. a manifest sweep drops superseded renders under the book's own
//      directory and touches nothing else: another book, the stream index, the
//      shell cache
//   F. an offline download and the probe that reports "Downloaded ✓" use the
//      same key. They are two call sites and they must not disagree, or the
//      badge reports on an object nobody will ever fetch

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pwLib = process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright');
const { chromium } = createRequire(import.meta.url)(pwLib);

// The build, deliberately — this suite tests what ships. PLAYER_DIR points it
// at a copy, which is how revert-and-watch mutates one rule without touching a
// source tree another agent may be editing at the same moment.
const player = process.env.PLAYER_DIR || join(here, '../audiobook/player');

// Before anything else: sw.js is a classic script and cannot import the module
// that defines this constant, so the literal exists twice. This is the check
// that makes it one source of truth anyway.
{
  const fromModule = /AUDIO_MANIFEST_MESSAGE = '([^']+)'/.exec(
    readFileSync(join(here, '../audiobook/player-src/src/core/media-url.ts'), 'utf8'));
  const fromWorker = /AUDIO_MANIFEST_MESSAGE = '([^']+)'/.exec(
    readFileSync(join(player, 'sw.js'), 'utf8'));
  const vModule = /CONTENT_VERSION_PARAM = '([^']+)'/.exec(
    readFileSync(join(here, '../audiobook/player-src/src/core/media-url.ts'), 'utf8'));
  const vWorker = /CONTENT_VERSION_PARAM = '([^']+)'/.exec(
    readFileSync(join(player, 'sw.js'), 'utf8'));
  if (!fromModule || !fromWorker || !vModule || !vWorker) {
    console.log('FAIL: could not find the shared constants in both files');
    process.exit(1);
  }
  if (fromModule[1] !== fromWorker[1] || vModule[1] !== vWorker[1]) {
    console.log(`FAIL: page and worker disagree — message ${fromModule[1]}/${fromWorker[1]}, `
                + `version param ${vModule[1]}/${vWorker[1]}`);
    process.exit(1);
  }
  console.log(`  ok: page and worker share one spelling (${fromModule[1]}, ?${vModule[1]}=)`);
}

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

const SPACE = 'b975dcdfc79cadcf';
const BOOK = 'fbff04477a58';
const BASE = `priv/${SPACE}/${BOOK}/audio/`;
const SIG = 'Policy=p1&Signature=s1&Key-Pair-Id=KP';

// The renders the origin is currently holding, keyed by chapter. Changing one
// is a re-render: same S3 key, different bytes — exactly the event no cache in
// the path could see.
const renders = { 1: 'r1', 2: 'r1', 3: 'r1' };
let audioHits = 0;

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };

function pageHtml(books) {
  const transcripts = { books: books.map((b) => ({ slug: b.slug, chapters: [] })) };
  const uri = 'data:application/json;base64,'
    + Buffer.from(JSON.stringify(transcripts)).toString('base64');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>audio-versioning</title><link rel="stylesheet" href="/player.css"></head>
<body><div id="app"></div>
<script>var RepoStoryFeedback = { init: function () {}, send: function () {} };</script>
<script src="/player.js"></script>
<script>
RepoStoryPlayer.init({
  container: document.getElementById('app'),
  books: ${JSON.stringify(books)},
  // '/' with the per-book prefix on the chapter, exactly as books.landry.bot
  // mounts it (site/app.js prepareForPlayer).
  audioBaseUrl: '/',
  transcriptUrl: ${JSON.stringify(uri)}
});
</script></body></html>`;
}

// Two books. The first carries content hashes, the second deliberately does
// not — that is assertion A2's instrument.
const HASHED = {
  slug: BOOK, title: 'Hashed Book', artist: 'Fixture', duration: 60.0,
  media_query: SIG,
  chapters: [
    { id: 0, n: 1, title: 'Chapter 1: One', filename: BASE + 'chapter_0001.m4a',
      start: 0.0, end: 30.0, duration: 30.0, size: 1, content_hash: 'aaaaaaaaaaaaaaa1' },
    { id: 1, n: 2, title: 'Chapter 2: Two', filename: BASE + 'chapter_0002.m4a',
      start: 30.0, end: 60.0, duration: 30.0, size: 1, content_hash: 'aaaaaaaaaaaaaaa2' },
  ],
};
const PLAIN = {
  slug: 'plain', title: 'Plain Book', artist: 'Fixture', duration: 30.0,
  chapters: [
    { id: 0, n: 1, title: 'Chapter 1: Only', filename: 'audio/chapter_0001.m4a',
      start: 0.0, end: 30.0, duration: 30.0, size: 1 },
  ],
};

// The shell version the worker is currently stamped with. A build stamps this
// line; bumping it here is exactly what a deploy does, and it is what makes the
// browser install a new worker and run activate().
let shellVersion = 'test-1';

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (path === '/sw.js') {
    const body = readFileSync(join(player, 'sw.js'), 'utf8')
      .replace(/var SHELL_VERSION = '[^']*';/, `var SHELL_VERSION = '${shellVersion}';`);
    res.writeHead(200, { 'content-type': 'text/javascript',
                         'cache-control': 'no-store',
                         'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  const chapter = path.match(/\/audio\/chapter_(\d+)\.m4a$/);
  if (chapter) {
    audioHits++;
    const n = parseInt(chapter[1], 10);
    const body = `audio-ch${n}-${renders[n] || 'r1'}`;
    res.writeHead(200, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes',
                         'content-length': body.length,
                         // The header the whole defect rests on.
                         'cache-control': 'public, max-age=31536000, immutable' });
    res.end(body);
    return;
  }

  if (path === '/' || path === '/index.html') {
    const body = pageHtml([HASHED, PLAIN]);
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  const file = join(player, path.slice(1));
  if (!file.startsWith(player) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[file.split('.').pop()] || 'application/octet-stream',
                       'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

await page.goto(origin + '/#/' + BOOK);
await page.waitForSelector('audio', { state: 'attached', timeout: 10000 });
// The SW must control the page before its fetch handler sees anything, and the
// first load races registration.
await page.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise((r) => {
  if (navigator.serviceWorker.controller) return r();
  navigator.serviceWorker.addEventListener('controllerchange', () => r());
})));
await page.reload();
await page.waitForSelector('audio', { state: 'attached', timeout: 10000 });

const keys = (name) => page.evaluate((n) => caches.open(n)
  .then((c) => c.keys()).then((ks) => ks.map((k) => k.url.replace(location.origin, ''))), name);
const fetchText = (u) => page.evaluate((url) => fetch(url).then((r) => r.text()), u);
const wipe = () => page.evaluate(() => Promise.all(
  ['audiobook-audio', 'audiobook-stream'].map((n) => caches.delete(n))));

// --- A: the chapter's own hash is in the URL the element fetches -----------
{
  const src = await page.evaluate(() => document.querySelector('audio').src);
  check(src.includes('v=aaaaaaaaaaaaaaa1'),
        `A: the audio URL carries the chapter's content hash (${src.replace(/^https?:\/\/[^/]+/, '')})`);
  check(src.split('?')[0].endsWith('/audio/chapter_0001.m4a'),
        'A: and still names the same S3 object — no key change, no re-upload');
  // Both present and in this order. `indexOf(v) < indexOf(Signature)` alone is
  // true when there is no `v` at all (-1), which is an assertion that cannot
  // fail against the very defect it is here for.
  check(/\?v=[0-9a-f]+&Policy=/.test(src),
        'A: the version precedes the signature, so the object path is intact');
}

// --- A2: prove the instrument — no hash, no parameter ----------------------
{
  await page.evaluate(() => { location.hash = '#/plain'; });
  await page.waitForFunction(() => /chapter_0001\.m4a/.test(document.querySelector('audio')?.src || ''),
                             null, { timeout: 10000 });
  const src = await page.evaluate(() => document.querySelector('audio').src);
  check(!/[?&]v=/.test(src),
        `A2: a book with no content_hash gets no version parameter (${src.replace(/^https?:\/\/[^/]+/, '')})`);
  await page.evaluate((b) => { location.hash = '#/' + b; }, BOOK);
  // On the signed path, not on the version: this wait must succeed even when
  // the version is missing, or a reverted implementation aborts the suite here
  // and every assertion after it silently stops being a check at all.
  await page.waitForFunction(() => /\/priv\//.test(document.querySelector('audio')?.src || ''),
                             null, { timeout: 10000 });
}

// --- B: the cache key keeps the version and drops the signature ------------
{
  await wipe();
  const u = `/${BASE}chapter_0003.m4a?v=v1&${SIG}`;
  await fetchText(u);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  const stream = await keys('audiobook-stream');
  check(stream.includes(`/${BASE}chapter_0003.m4a?v=v1`),
        `B: cached under the versioned URL, signature stripped (${JSON.stringify(stream)})`);
  // A rotated signature must not produce a second copy of a 4 MB chapter.
  const before = audioHits;
  const again = await fetchText(`/${BASE}chapter_0003.m4a?v=v1&Policy=p2&Signature=s2&Key-Pair-Id=KP`);
  check(audioHits === before, 'B: a rotated signature is answered from the same entry');
  check(again === 'audio-ch3-r1', `B: with the right bytes ("${again}")`);
}

// --- C: the defect, on purpose, then the fix -------------------------------
{
  // The origin re-renders chapter 3. Same key, same size class, new bytes.
  renders[3] = 'r2';

  const stale = await fetchText(`/${BASE}chapter_0003.m4a?v=v1&${SIG}`);
  check(stale === 'audio-ch3-r1',
        `C: THE DEFECT — the old URL still answers with the dead render ("${stale}")`);

  const fresh = await fetchText(`/${BASE}chapter_0003.m4a?v=v2&${SIG}`);
  check(fresh === 'audio-ch3-r2',
        `C: the re-rendered chapter's URL cannot be answered by it ("${fresh}")`);
}

// --- D: activate evicts what can never be proven current -------------------
{
  await wipe();
  await page.evaluate(async (base) => {
    const c = await caches.open('audiobook-audio');
    const put = (u) => c.put(new Request(new URL(u, location.href).href),
                             new Response('old', { headers: { 'Content-Type': 'audio/mp4' } }));
    await put('/' + base + 'chapter_0009.m4a');            // signed path, no version
    await put('/' + base + 'chapter_0008.m4a?v=keepme');   // signed path, versioned
    // A book on this very site that still publishes unversioned URLs: an older
    // manifest with no content_hash. Nothing here can be shown stale, and
    // evicting it would delete a reader's offline download on every shell
    // deploy and hand them a re-download in its place.
    await put('/priv/space3/legacybook/audio/chapter_0001.m4a');
    await put('/audio/chapter_0001.m4a');                  // an unsigned host's download
    await put('/player.css');                              // a shell file in the same cache
  }, BASE);
  // A shell deploy, exactly: new bytes in sw.js, so the browser installs a new
  // worker and runs activate(). Driven through the real event rather than a
  // message invented for the test — a listener that only the test can reach is
  // a listener production never runs.
  shellVersion = 'test-2';
  await page.evaluate(() => navigator.serviceWorker.getRegistration()
    .then((r) => r && r.update()));
  await page.waitForFunction(
    () => navigator.serviceWorker.controller
      && !navigator.serviceWorker.controller.scriptURL.endsWith('#none'),
    null, { timeout: 10000 }).catch(() => {});
  // The eviction runs inside waitUntil, so activation being observable is not
  // the same as the sweep having finished. Poll for the absence, and the two
  // survivors below are what proves the poll saw a real sweep rather than a
  // cache that never had the entry.
  for (let i = 0; i < 40; i++) {
    const now = await keys('audiobook-audio');
    if (!now.some((k) => k.endsWith('chapter_0009.m4a'))) break;
    await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));
  }
  const after = await keys('audiobook-audio');
  check(!after.some((k) => k.endsWith('chapter_0009.m4a')),
        `D: an unversioned chapter under a signed path is evicted (${JSON.stringify(after)})`);
  check(after.some((k) => k.includes('chapter_0008.m4a?v=keepme')),
        'D: a versioned one under the same path survives');
  check(after.some((k) => k === '/audio/chapter_0001.m4a'),
        "D: an unsigned host's offline download is untouched");
  check(after.some((k) => k === '/priv/space3/legacybook/audio/chapter_0001.m4a'),
        'D: and so is a book here that has no versioned URLs to be stale against');
  check(after.some((k) => k === '/player.css'),
        'D: and a shell file in the same cache is not audio and is not touched');
}

// --- E: the manifest sweep drops superseded renders ------------------------
{
  await wipe();
  await page.evaluate(async (base) => {
    const c = await caches.open('audiobook-audio');
    const put = (u) => c.put(new Request(new URL(u, location.href).href),
                             new Response('x', { headers: { 'Content-Type': 'audio/mp4' } }));
    await put('/' + base + 'chapter_0001.m4a?v=current');
    await put('/' + base + 'chapter_0001.m4a?v=superseded');
    await put('/' + base + 'chapter_0002.m4a?v=current');
    await put('/priv/space2/otherbook/audio/chapter_0001.m4a?v=whatever');
    await put('/player.css');
    const s = await caches.open('audiobook-stream');
    // A survivor alongside the victim: without one, "no superseded entry
    // here" is equally true of a cache that was never written to, and the
    // assertion would pass against a sweep that skips this cache entirely.
    for (const u of ['/' + base + 'chapter_0001.m4a?v=superseded',
                     '/' + base + 'chapter_0002.m4a?v=current']) {
      await s.put(new Request(new URL(u, location.href).href),
                  new Response('x', { headers: { 'Content-Type': 'audio/mp4' } }));
    }
  }, BASE);

  await page.evaluate((base) => new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    navigator.serviceWorker.controller.postMessage({
      type: 'audiobook-manifest',
      keys: [new URL('/' + base + 'chapter_0001.m4a?v=current', location.href).href,
             new URL('/' + base + 'chapter_0002.m4a?v=current', location.href).href],
    }, [ch.port2]);
    setTimeout(resolve, 3000);
  }), BASE);

  const offline = await keys('audiobook-audio');
  const stream = await keys('audiobook-stream');
  check(!offline.some((k) => k.includes('v=superseded')),
        `E: a superseded render is dropped (${JSON.stringify(offline)})`);
  check(offline.filter((k) => k.includes('v=current')).length === 2,
        'E: the renders the manifest names survive');
  check(offline.some((k) => k.includes('otherbook')),
        "E: another book's directory is not swept — the manifest says nothing about it");
  check(offline.includes('/player.css'), 'E: a shell file is not audio');
  check(!stream.some((k) => k.includes('v=superseded'))
        && stream.some((k) => k.includes('chapter_0002.m4a?v=current')),
        `E: and the stream cache is swept too, without losing a current one (${JSON.stringify(stream)})`);
}

// --- E2: opening a book is what triggers the sweep -------------------------
//
// E proves the worker sweeps when told. This proves anything ever tells it.
// The two are separate assertions because the message handler and the call
// site fail independently, and a worker nobody talks to is a cache that grows
// forever with nothing on screen to say so.
{
  await wipe();
  await page.evaluate((base) => caches.open('audiobook-audio').then((c) => Promise.all([
    c.put(new Request(new URL('/' + base + 'chapter_0001.m4a?v=deadrender', location.href).href),
          new Response('x', { headers: { 'Content-Type': 'audio/mp4' } })),
    // The survivor: it is in the book's current manifest, so a sweep that ran
    // must leave it. Without it, "the dead entry is gone" is also what a
    // cleared cache looks like.
    c.put(new Request(new URL('/' + base + 'chapter_0002.m4a?v=aaaaaaaaaaaaaaa2', location.href).href),
          new Response('x', { headers: { 'Content-Type': 'audio/mp4' } })),
  ])), BASE);

  // Leave the book and come back: openBook is the trigger.
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#book-list .book-item', { timeout: 10000 });
  await page.evaluate((b) => { location.hash = '#/' + b; }, BOOK);
  await page.waitForFunction(() => /\/priv\//.test(document.querySelector('audio')?.src || ''),
                             null, { timeout: 10000 });

  let after = [];
  for (let i = 0; i < 40; i++) {
    after = await keys('audiobook-audio');
    if (!after.some((k) => k.includes('v=deadrender'))) break;
    await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));
  }
  check(!after.some((k) => k.includes('v=deadrender')),
        `E2: opening the book swept a render it no longer contains (${JSON.stringify(after)})`);
  check(after.some((k) => k.includes('v=aaaaaaaaaaaaaaa2')),
        'E2: and kept the one it does — the sweep ran, the cache was not merely empty');
}

// --- F: the download and the badge agree on the key ------------------------
{
  await wipe();
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('#book-list .book-item .dl-btn', { timeout: 10000 });
  await page.click('#book-list .book-item .dl-btn');
  await page.waitForFunction(() => {
    const b = document.querySelector('#book-list .book-item .dl-btn');
    return b && (b.classList.contains('downloaded') || b.classList.contains('error'));
  }, null, { timeout: 30000 }).catch(() => {});
  const cls = await page.evaluate(() =>
    document.querySelector('#book-list .book-item .dl-btn').className);
  check(/downloaded/.test(cls), `F: the download completes and the badge reports it (${cls})`);
  const stored = await keys('audiobook-audio');
  check(stored.some((k) => k.includes('chapter_0001.m4a?v=aaaaaaaaaaaaaaa1')),
        `F: stored under the versioned key the player will ask for (${JSON.stringify(
          stored.filter((k) => k.includes('.m4a')))})`);
  check(!stored.some((k) => /chapter_000\d\.m4a$/.test(k)),
        'F: and never under the bare name, which is the key the probe would miss');
}

// --- F2: the badge still says so after a reload ----------------------------
//
// F's "downloaded" comes from downloadForOffline setting its own state, which
// is true whatever key it wrote. The PROBE is a second call site and only runs
// on load — checkOfflineStatus, deciding what the shelf shows before anything
// is clicked. A probe asking for the bare name while the download stored the
// versioned one reports "not downloaded" for a book that is, and the reader is
// invited to download 4.2 GB they already have.
{
  // reload(), not goto(): the page is already at this URL and Playwright would
  // treat a goto differing only in the fragment as a same-document navigation —
  // no new document, no fresh engine, and this assertion would be reading the
  // state the download itself set. That is a green that measures nothing, and
  // it is exactly what happened the first time this was written.
  //
  // 'attached', not 'visible': autoOpenLast reopens the last book on a cold
  // load, so the list is in the document with the book view over it. The badge
  // is still what refreshOfflineBadges just decided.
  await page.reload();
  await page.waitForSelector('#book-list .book-item .dl-btn',
                             { state: 'attached', timeout: 10000 });
  let cls = '';
  for (let i = 0; i < 40; i++) {
    cls = await page.evaluate(() =>
      document.querySelector('#book-list .book-item .dl-btn').className);
    if (/downloaded/.test(cls)) break;
    await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));
  }
  check(/downloaded/.test(cls),
        `F2: after a reload the probe still finds the download (${cls})`);
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
