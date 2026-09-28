// resume-last-book.test.mjs — a launch opens the book you were in, every time.
//
// Run: node test/resume-last-book.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// A FEATURE suite: it loads the Preact build from audiobook/player directly.
//
// Going back to the library used to blank the stored last book, so one trip
// to the shelf meant the next launch opened the shelf — and a reader who uses
// the shelf to look around walked back to their book by hand every morning.
// The shelf is somewhere you visit; only opening a book moves the target.
//
// A host that routes for itself (books.landry.bot passes autoOpenLast:false)
// decides WHEN to resume, and asks the player WHICH book — resumeTarget() —
// because the choice spans devices: the newest place the reader was, here or
// on any device the host's progress backend knows about.
//
// Contract under test:
//   A. open a book, go back to the library, reload: the book opens again
//   B. opening a different book moves the target; visiting the shelf does not
//   C. resumeTarget() answers this device's last book with no remote records
//   D. resumeTarget() prefers a newer record from another device, for another
//      book, and skips ids the host says are not in its library
//   E. with storage that throws from its getter (iOS "Block All Cookies"),
//      resumeTarget() answers null instead of throwing

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

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', m4a: 'audio/mp4' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const base = path.startsWith('/audiobook/vanilla/')
    ? join(player, path.slice('/audiobook/vanilla/'.length))
    : join(outDir, path === '/' ? 'index.html' : path.slice(1));
  const file = normalize(base);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[file.split('.').pop()] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

async function fresh(init) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => bad(`page error: ${e.message}`));
  return { ctx, page };
}
const openTitle = (page) => page.evaluate(() =>
  document.querySelector('#player-view.active') ? document.title : null);
const openBook = async (page, title) => {
  await page.click(`#book-list .book-item:has-text("${title}") .title`);
  await page.waitForSelector('#player-view.active');
};
const toShelf = async (page) => {
  // Tolerant of already being there, so one red assertion does not cascade.
  if (!await page.$('#player-view.active')) return;
  await page.click('#back-btn');
  await page.waitForSelector('#player-view.active', { state: 'detached', timeout: 3000 })
    .catch(() => page.waitForFunction(() => !document.querySelector('#player-view.active')));
};
// Lands on the shelf without a hash, the way a launch does.
const launch = async (page) => {
  await page.goto(origin + '/');
  await page.waitForSelector('#book-list .book-item', { state: 'attached' });
  await page.waitForTimeout(300);
};

// --- A, B ------------------------------------------------------------------
{
  const { ctx, page } = await fresh();
  await launch(page);
  check(await openTitle(page) === null, 'A0: a first visit starts on the shelf');
  await openBook(page, 'Plain Book');
  await toShelf(page);
  check(await openTitle(page) === null, 'A1: back went to the shelf');
  await launch(page);
  check(await page.$('#player-view.active') !== null,
    'A: after a trip to the shelf, the next launch reopens the book');

  await toShelf(page);
  await openBook(page, 'Test Book');
  await toShelf(page);
  await launch(page);
  const id = await page.evaluate(() => localStorage.getItem('rs-last-book-id'));
  check(id === 'test-book', `B: the last book OPENED is the target (was ${id})`);

  // --- C, D ----------------------------------------------------------------
  const api = await page.evaluate(() => typeof RepoStoryPlayer.resumeTarget);
  check(api === 'function', `C: the player exposes resumeTarget (was ${api})`);
  if (api === 'function') {
    const r = await page.evaluate(() => {
      const far = new Date(Date.now() + 864e5).toISOString();
      const old = '2000-01-01T00:00:00Z';
      return {
        alone: RepoStoryPlayer.resumeTarget(),
        older: RepoStoryPlayer.resumeTarget([{ bookId: 'plain-book', updatedAt: old }]),
        newer: RepoStoryPlayer.resumeTarget([{ bookId: 'plain-book', updatedAt: far }]),
        unknown: RepoStoryPlayer.resumeTarget([{ bookId: 'nope', updatedAt: far }],
                                              ['test-book', 'plain-book']),
      };
    });
    check(r.alone === 'test-book', `C: alone, this device's last book (was ${r.alone})`);
    check(r.older === 'test-book', `D: an older record elsewhere loses (was ${r.older})`);
    check(r.newer === 'plain-book', `D: a newer record elsewhere wins (was ${r.newer})`);
    check(r.unknown === 'test-book', `D: an id outside the library is skipped (was ${r.unknown})`);
  }
  await ctx.close();
}

// --- E ---------------------------------------------------------------------
{
  const { ctx, page } = await fresh(() => {
    for (const k of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, k, { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    }
  });
  await launch(page);
  const r = await page.evaluate(() => {
    try { return { v: RepoStoryPlayer.resumeTarget([]) }; } catch (e) { return { err: String(e) }; }
  });
  check(!r.err && r.v === null, `E: blocked storage answers null (was ${JSON.stringify(r)})`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
