// re-init.test.mjs — what a second init() into the same container leaves behind.
//
// Run: node test/re-init.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// The vanilla player was one IIFE with one <audio> element and module-level
// guards, so re-init was free. The port made the engine a class and moved the
// element and the animation loop onto the INSTANCE — and a host that re-renders
// (books.landry.bot does, on navigation) constructs another one. The page-level
// wiring is already guarded against that, in start(); nothing disposed the
// engine itself, so the old one kept its rAF loop running over detached DOM and
// its <audio> element in the container, able to keep playing under the new one.
//
// The engine is not exported, so the observable surface is what it leaves in the
// DOM. That is the right seam anyway: an orphan audio element is precisely what
// a listener hears.
//
// Contract under test:
//   A. a second init leaves one <audio> element, not one per init
//   B. the first init's element is stopped and detached, so nothing plays twice
//   C. the surviving player still works — disposal must not take the live one

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
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

const BOOKS = [{ slug: 'alpha', title: 'Alpha' }];

await page.goto(`${origin}/`);
await page.evaluate(({ books }) => {
  document.body.innerHTML = '<div id="app"></div>';
  window.__cfg = {
    container: document.getElementById('app'),
    books: books.map((b) => ({
      ...b, duration: 4,
      chapters: [{ id: 0, n: 1, title: 'Ch 1', filename: 'chapter_0001.m4a',
                   start: 0, end: 4, duration: 4, size: 1 }],
    })),
    audioBaseUrl: 'audio/',
    autoOpenLast: false,
    title: 'Lib',
  };
  window.RepoStoryPlayer.init(window.__cfg);
}, { books: BOOKS });
await page.waitForSelector('#book-list .book-item');

// Play, so the first engine owns something audible to leave behind. A silent
// orphan would satisfy A and B without proving anything a listener would notice.
await page.click('#book-list .book-item .book-open');
await page.waitForSelector('#player-view.active');
await page.click('#play-btn');
await page.waitForFunction(() => {
  const a = document.querySelector('audio');
  return a && !a.paused && a.currentTime > 0.1;
}, null, { timeout: 10000 }).catch(() => {});

// Hold onto the first element so it can be inspected after it is replaced.
await page.evaluate(() => { window.__first = document.querySelector('audio'); });

// --- the host re-renders ----------------------------------------------------
await page.evaluate(() => { window.RepoStoryPlayer.init(window.__cfg); });
// The hash still names the book, so the fresh engine reopens it — which is the
// realistic case: two engines pointed at the same chapter.
await page.waitForSelector('#player-view.active');
await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));

const n = await page.$$eval('audio', (els) => els.length);
check(n === 1, `A: one audio element after a re-init (${n})`);

const first = await page.evaluate(() => ({
  paused: window.__first.paused,
  attached: document.contains(window.__first),
}));
check(first.paused, 'B: the first init\'s element is stopped');
check(!first.attached, 'B: and is out of the document');

// --- C: the surviving player is not collateral damage ----------------------
await page.click('#play-btn');
const alive = await page.waitForFunction(() => {
  const a = document.querySelector('audio');
  return a && !a.paused && a.currentTime > 0.1;
}, null, { timeout: 10000 }).then(() => true, () => false);
check(alive, 'C: the player from the second init still plays');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
