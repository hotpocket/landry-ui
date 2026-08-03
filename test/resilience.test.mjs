// resilience.test.mjs — the player survives auth lapses, background gaps, and
// stray gestures.
//
// Run: node test/resilience.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
// Fixture: test/fixture/gen.sh (run automatically if out/ is missing), served
// over HTTP here because the contracts involve real status codes.
//
// Contract under test:
//   A. a chapter fetch that errors (403) calls config.onAuthRefresh and then
//      retries; when the refresh fixes entitlement, playback recovers at the
//      chapter it was loading, unattended
//   B. when refresh does not help, retries are capped — no infinite spin
//   C. a small touch wiggle (< slop) does not disarm transcript follow; a real
//      swipe disarms it for the session WITHOUT persisting the off state
//   D. track-bar drag in summary mode seeks on the summary clock
//   E. MediaSession metadata + action handlers are installed while playing
//   F. the next chapter is prefetched while the current one still plays
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

// --- test server: fixture over HTTP, with a controllable 403 on chapter 2 ---
const state = { deny2: false, requests: [] };
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  state.requests.push(path);
  if (path === '/fix') { state.deny2 = false; res.end('ok'); return; }
  if (state.deny2 && path.endsWith('chapter_0002.m4a')) {
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end('<Error/>');
    return;
  }
  // player assets live outside the fixture dir; everything else inside it.
  const base = path.startsWith('/audiobook/vanilla/') ? join(vanilla, path.slice('/audiobook/vanilla/'.length))
             : join(outDir, path === '/' ? 'index.html' : path.slice(1));
  const file = normalize(base);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  const ext = file.split('.').pop();
  const body = readFileSync(file);
  const range = req.headers.range && req.headers.range.match(/bytes=(\d+)-(\d*)/);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = range[2] ? parseInt(range[2], 10) : body.length - 1;
    res.writeHead(206, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream',
                       'accept-ranges': 'bytes', 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

async function freshPage(hash) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', (e) => bad(`page error: ${e.message}`));
  // Wrap init before the page's scripts run: inject onAuthRefresh and spy on
  // MediaSession, without forking the fixture.
  await page.addInitScript(() => {
    window.__authRefreshes = 0;
    window.__msActions = [];
    if (navigator.mediaSession) {
      const orig = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (a, h) => { window.__msActions.push(a); return orig(a, h); };
    }
    let real;
    Object.defineProperty(window, 'RepoStoryPlayer', {
      configurable: true,
      get() { return real; },
      set(v) {
        real = Object.assign({}, v, {
          init(cfg) {
            cfg.onAuthRefresh = function () {
              window.__authRefreshes++;
              return fetch('/fix').then(() => {});
            };
            return v.init(cfg);
          },
        });
      },
    });
  });
  await page.goto(origin + '/index.html' + hash);
  await page.waitForSelector('.transcript-chunk', { timeout: 5000 });
  return page;
}

// --- A: 403 at the chapter boundary → refresh → unattended recovery ---
{
  state.deny2 = true;
  const page = await freshPage('#/test-book');
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = Math.max(0, a.duration - 0.6);
    return a.play();
  });
  const recovered = await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return /chapter_0002/.test(a.currentSrc) && !a.paused && !a.error;
  }, { timeout: 15000 }).then(() => true, () => false);
  check(recovered, 'A: playback recovers into chapter 2 after refresh, unattended');
  const refreshes = await page.evaluate(() => window.__authRefreshes);
  check(refreshes >= 1, `A: onAuthRefresh was called (${refreshes}x)`);
  await page.close();
}

// --- B: refresh that never helps → capped retries ---
{
  state.deny2 = true;
  const page = await freshPage('#/test-book');
  // Break the fix endpoint for this page: refresh "succeeds" but 403 persists.
  await page.route('**/fix', (route) => route.fulfill({ status: 200, body: 'no' }));
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = Math.max(0, a.duration - 0.6);
    return a.play();
  });
  // The window must extend past where an UNCAPPED 4th retry would land
  // (delays 0.8+2.5+8s put it at ~11.5s) or this assertion can never fail.
  await new Promise((r) => setTimeout(r, 14000));
  const refreshes = await page.evaluate(() => window.__authRefreshes);
  check(refreshes === 3, `B: retries are capped at exactly 3 (saw ${refreshes} in 14s)`);
  await page.close();
  state.deny2 = false;
}

// --- B2: re-initializing the player must not stack page-level wiring ---
{
  const page = await freshPage('#/test-book');
  const counts = await page.evaluate(() => {
    window.__mmCount = 0;
    const orig = document.addEventListener.bind(document);
    document.addEventListener = (type, fn, opts) => {
      if (type === 'mousemove') window.__mmCount++;
      return orig(type, fn, opts);
    };
    const cfg = {
      container: document.querySelector('#app') || document.body.firstElementChild,
    };
    // Re-init twice against the live container, as a host re-render does.
    const container = document.querySelector('audio').parentElement;
    for (let i = 0; i < 2; i++) {
      RepoStoryPlayer.init({ container, books: [], audioBaseUrl: 'audio/' });
    }
    return window.__mmCount;
  });
  check(counts === 0, `B2: re-init adds no document mousemove listeners (${counts} added)`);
  await page.close();
}

// --- C: follow — wiggle survives, swipe disarms without persisting ---
{
  const page = await freshPage('#/test-book');
  const touch = (type, x, y) => page.evaluate(([type, x, y]) => {
    const el = document.querySelector('#transcript-chunks');
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent(type, { touches: [t], bubbles: true, cancelable: true }));
  }, [type, x, y]);

  const box = await page.evaluate(() => {
    const r = document.querySelector('#transcript-chunks').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  await touch('touchstart', box.x, box.y);
  await touch('touchmove', box.x + 3, box.y + 4);       // wiggle, under slop
  await touch('touchend', box.x + 3, box.y + 4);
  let on = await page.evaluate(() => document.querySelector('#follow-btn').classList.contains('on'));
  check(on, 'C: a sub-slop wiggle does not disarm follow');

  await touch('touchstart', box.x, box.y);
  await touch('touchmove', box.x, box.y - 60);          // real swipe
  await touch('touchend', box.x, box.y - 60);
  on = await page.evaluate(() => document.querySelector('#follow-btn').classList.contains('on'));
  check(!on, 'C: a real swipe disarms follow');
  const persisted = await page.evaluate(() => localStorage.getItem('rs-follow'));
  check(persisted !== '0', 'C: gesture disarm is session-only, not persisted');

  // The explicit button IS persisted, both ways.
  await page.click('#follow-btn');
  await page.click('#follow-btn');
  const persistedOff = await page.evaluate(() => {
    document.querySelector('#follow-btn').click();
    return localStorage.getItem('rs-follow');
  });
  check(persistedOff === '0' || persistedOff === '1',
        'C: the follow button still persists explicit choices');
  await page.close();
}

// --- D: track-bar drag in summary mode uses the summary clock ---
{
  const page = await freshPage('#/test-book');
  await page.click('#mode-summary');
  await page.waitForFunction(() => /summary/.test(document.querySelector('audio').currentSrc),
    { timeout: 5000 });
  const bar = await page.evaluate(() => {
    const r = document.querySelector('#track-bar').getBoundingClientRect();
    return { left: r.left, width: r.width, y: r.top + r.height / 2 };
  });
  // Drag to 25% of the bar: summary timeline is 12s, so book-time 3.0 —
  // chapter 1's summary at ~3s. On the full clock this would be 15s and
  // clamp to the summary end instead.
  await page.mouse.move(bar.left + bar.width * 0.5, bar.y);
  await page.mouse.down();
  await page.mouse.move(bar.left + bar.width * 0.25, bar.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return /chapter_0001\.summary/.test(a.currentSrc) &&
           a.currentTime > 2.0 && a.currentTime < 4.0;
  }, { timeout: 4000 }).then(
    () => ok('D: summary-mode drag lands at 25% of the summary clock'),
    async () => {
      const s = await page.evaluate(() => {
        const a = document.querySelector('audio');
        return a.currentSrc.split('/').pop() + ' @ ' + a.currentTime.toFixed(2);
      });
      bad(`D: summary-mode drag landed at ${s} (wanted chapter_0001.summary @ ~3s)`);
    });
  await page.close();
}

// --- E: MediaSession wired while playing ---
{
  const page = await freshPage('#/test-book');
  await page.evaluate(() => document.querySelector('audio').play());
  await new Promise((r) => setTimeout(r, 500));
  const ms = await page.evaluate(() => ({
    actions: window.__msActions,
    title: navigator.mediaSession.metadata && navigator.mediaSession.metadata.title,
  }));
  ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'].forEach((a) =>
    check(ms.actions.includes(a), `E: mediaSession handles '${a}'`));
  check(!!ms.title, `E: mediaSession metadata is set ('${ms.title}')`);
  await page.close();
}

// --- F: next chapter prefetched while the current one plays ---
{
  state.requests.length = 0;
  const page = await freshPage('#/test-book');
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = 5;              // 25s remain — inside the prefetch window
    return a.play();
  });
  const t0 = Date.now();
  let prefetched = false;
  while (Date.now() - t0 < 6000) {
    if (state.requests.some((p) => p.endsWith('chapter_0002.m4a'))) { prefetched = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  check(prefetched, 'F: chapter 2 was requested while chapter 1 still had time left');
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
