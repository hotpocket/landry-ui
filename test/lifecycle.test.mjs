// lifecycle.test.mjs — the player survives the page being frozen and thawed.
//
// Run: node test/lifecycle.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// This is the closest a headless test gets to the screen going off. A real
// backgrounded phone suspends timers, stops rAF, and can reclaim the audio
// element; Chrome's `Page.setWebLifecycleState` reproduces the first two, and
// `visibilitychange` reproduces the moment of leaving and returning.
//
// It exists because the decomposition is riskiest exactly here: the vanilla
// player kept its recovery state in module-level vars that no test read, so a
// port could drop a listener and every existing suite would stay green.
//
// Contract under test:
//   A. leaving the page saves progress — a tab discarded while hidden must not
//      lose the position
//   B. the rAF loop resumes after a freeze/thaw, so the clock keeps moving
//   C. position does not reset across the freeze
//   D. returning to a page whose audio element errored while away retries
//      immediately, rather than waiting for a listener who has already given up
//   E. the retry on return gets a FRESH cap — an element that exhausted its
//      retries while frozen must not come back permanently dead

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
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

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };

// Chapter 2 can be made to fail, so an element can be errored on purpose.
const state = { deny2: false };

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/deny') { state.deny2 = true; res.end('ok'); return; }
  if (path === '/allow') { state.deny2 = false; res.end('ok'); return; }
  if (state.deny2 && path.endsWith('chapter_0002.m4a')) {
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end('<Error/>');
    return;
  }
  const base = path.startsWith('/audiobook/vanilla/')
    ? join(vanilla, path.slice('/audiobook/vanilla/'.length))
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
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

await page.goto(origin);
await page.waitForSelector('#book-list .book-item');
await page.click('#book-list .book-item .title');
await page.waitForSelector('#player-view.active');
await page.click('#play-btn');
await page.waitForFunction(() => {
  const a = document.querySelector('audio');
  return a && !a.paused && a.currentTime > 0.2;
}, null, { timeout: 10000 });

const cdp = await page.context().newCDPSession(page);

// --- A: leaving saves progress -------------------------------------------
await page.evaluate(() => {
  window.__before = Object.keys(localStorage)
    .filter((k) => k.startsWith('rs-progress-'))
    .map((k) => localStorage.getItem(k));
  localStorage.removeItem('rs-progress-0');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
const savedOnHide = await page.evaluate(() => localStorage.getItem('rs-progress-0'));
check(savedOnHide !== null, 'A: going hidden writes progress');

// --- B/C: freeze, thaw, clock recovers ------------------------------------
const tBefore = await page.evaluate(() => document.querySelector('audio').currentTime);

await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
await new Promise((r) => setTimeout(r, 1200));
await cdp.send('Page.setWebLifecycleState', { state: 'active' });
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
});

const tAfter = await page.evaluate(() => document.querySelector('audio').currentTime);
check(tAfter >= tBefore, `C: position did not reset across the freeze (${tBefore} → ${tAfter})`);

// The rAF loop is what paints the clock; if it did not restart, the displayed
// time stops moving even while the audio element advances.
const shown1 = await page.textContent('#current-time');
await page.waitForFunction(() => {
  const a = document.querySelector('audio');
  return a && !a.paused;
}, null, { timeout: 5000 }).catch(() => {});
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
const tMoved = await page.evaluate(() => document.querySelector('audio').currentTime);
const shown2 = await page.textContent('#current-time');
check(tMoved > tAfter, `B: audio kept advancing after thaw (${tAfter} → ${tMoved})`);
check(shown1 !== shown2 || tMoved === tAfter,
  `B: the rAF loop repainted the clock after thaw (${shown1} → ${shown2})`);

// --- D/E: returning to an errored element retries --------------------------
await page.evaluate(() => { window.__loads = 0; });
await page.evaluate(() => {
  const a = document.querySelector('audio');
  const orig = a.load.bind(a);
  a.load = function () { window.__loads++; return orig(); };
});

// Exhaust the retry budget while "away": deny chapter 2 and go there.
await fetch(`${origin}/deny`);
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.click('#btn-next', { force: true });
await page.waitForFunction(() => document.querySelector('audio').error !== null, null, { timeout: 15000 })
  .catch(() => {});
const erroredWhileAway = await page.evaluate(() => document.querySelector('audio').error !== null);
check(erroredWhileAway, 'D: the element really did error while hidden');

const loadsBeforeReturn = await page.evaluate(() => window.__loads);
await fetch(`${origin}/allow`);
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForFunction(
  (n) => window.__loads > n,
  loadsBeforeReturn,
  { timeout: 15000 },
).then(
  () => ok('D/E: returning to an errored element reloads it with a fresh retry budget'),
  () => bad('D/E: returning to an errored element did NOT retry'),
);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
