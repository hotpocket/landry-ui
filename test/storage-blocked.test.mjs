// storage-blocked.test.mjs — the player still mounts when storage is refused.
//
// Run: node test/storage-blocked.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// iOS Safari with Settings → Safari → Advanced → "Block All Cookies" does not
// hand back an empty Storage. It throws SecurityError from the `localStorage`
// GETTER, so a line that merely names the identifier is a throw. init() named
// it while constructing the engine, which meant the mount never happened and
// books.landry.bot rendered its static footer and nothing else — reported as
// "on an iphone it doesn't render", with no console to read it in.
//
// The seam is init(), not the storage helper: the helper can be right while the
// one call site still reaches for the raw global, which is exactly the bug.
//
// Contract under test:
//   A. init() does not throw when `localStorage` is refused
//   B. the library actually renders — a silent mount is not a mount
//   C. a book opens, so the reading surface works without persistence
//   D. a preference toggle survives within the session, in memory
//   E. nothing reaches the page as an unhandled error

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
const player = join(here, '../audiobook/player');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const base = path.startsWith('/audiobook/vanilla/')
    ? join(player, path.slice('/audiobook/vanilla/'.length))
    : join(outDir, path === '/' ? 'index.html' : path.slice(1));
  const file = normalize(base);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[file.split('.').pop()] || 'application/octet-stream',
                       'content-length': body.length, 'accept-ranges': 'bytes' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 900, height: 700 } });

// What "Block All Cookies" does, modelled on the only surface that matters:
// the getter. Installed before any of the page's own script runs, because the
// bundle reads the identifier during init() and a late override would miss it.
await context.addInitScript(() => {
  const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
  Object.defineProperty(window, 'localStorage', { configurable: true, get: boom });
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get: boom });
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Prove the instrument before trusting it: if the override did not take, every
// assertion below passes against unfixed code.
await page.goto(`${origin}/`);
const refuses = await page.evaluate(() => {
  try { void window.localStorage; return false; } catch { return true; }
});
check(refuses, 'instrument: localStorage refuses access in this context');

const BOOKS = [{ slug: 'alpha', title: 'Alpha' }];

const threw = await page.evaluate(({ books }) => {
  document.body.innerHTML = '<div id="app"></div>';
  try {
    window.RepoStoryPlayer.init({
      container: document.getElementById('app'),
      books: books.map((b) => ({
        ...b, duration: 4,
        chapters: [{ id: 0, n: 1, title: 'Ch 1', filename: 'chapter_0001.m4a',
                     start: 0, end: 4, duration: 4, size: 1 }],
      })),
      audioBaseUrl: 'audio/',
      autoOpenLast: false,
      title: 'Lib',
    });
    return null;
  } catch (e) { return String(e && e.message || e); }
}, { books: BOOKS });
check(threw === null, `A. init() does not throw when storage is refused${threw ? ` (threw: ${threw})` : ''}`);

let listed = false;
try { await page.waitForSelector('#book-list .book-item', { timeout: 5000 }); listed = true; } catch { /* reported below */ }
check(listed, 'B. the library renders');

let opened = false;
if (listed) {
  await page.click('#book-list .book-item .book-open');
  try { await page.waitForSelector('#player-view.active', { timeout: 5000 }); opened = true; } catch { /* below */ }
}
check(opened, 'C. a book opens');

if (opened) {
  const before = await page.getAttribute('#follow-btn', 'class');
  await page.click('#follow-btn');
  const after = await page.getAttribute('#follow-btn', 'class');
  check(before !== after, 'D. a preference toggles within the session');
} else {
  check(false, 'D. a preference toggles within the session (book never opened)');
}

check(pageErrors.length === 0, `E. no unhandled page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
