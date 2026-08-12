// manifest-warnings.test.mjs — the two library invariants nothing enforced.
//
// Run: node test/manifest-warnings.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// Both of these were found by review, and both are the same shape: a manifest
// the player accepts, renders, and then quietly gets wrong.
//
//   - `ch.id` is read as a position — by the summary clock, the chapter rows,
//     the progress bars, the active highlight and the transcript element ids —
//     while `Chapter.id` is typed as any number. A 1-based manifest seeks to the
//     wrong place and says nothing.
//   - Two titles that differ only after 60 characters slugify to the same
//     string. Every hash for the pair opens the first book; the second is
//     unreachable by URL.
//
// Warned, not repaired, and the reasons differ. Renumbering chapters would mean
// mutating book objects the host still owns (books.landry.bot re-signs those
// very objects in place). Making a slug unique would change the slug of every
// long-titled book that already exists, orphaning live links — the failure the
// slug rules were written to prevent.
//
// console.warn rather than the rs-diag ring buffer on purpose: rs-diag exists
// for failures on a phone with its screen off, where nobody is watching. A bad
// manifest is deterministic and fires on the first load in any browser, so the
// console is where whoever built the manifest will actually be.
//
// Contract under test:
//   A. a positional, collision-free library warns about nothing
//   B. a 1-based manifest is named, with the book and the chapter
//   C. colliding slugs are named, with the slug
//   D. warning is all it does — the player still boots and opens a book

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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

const warnings = [];
page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

const chapters = (firstId) => [
  { id: firstId, n: 1, title: 'Ch 1', filename: 'chapter_0001.m4a',
    start: 0, end: 4, duration: 4, size: 1 },
  { id: firstId + 1, n: 2, title: 'Ch 2', filename: 'chapter_0002.m4a',
    start: 4, end: 8, duration: 4, size: 1 },
];

// 60 identical characters, then a difference slugify truncates away.
const STEM = 'The same opening sixty characters of a very long book title ';

async function boot(books) {
  warnings.length = 0;
  await page.goto(`${origin}/`);
  await page.evaluate((books) => {
    document.body.innerHTML = '<div id="app"></div>';
    location.hash = '';
    window.RepoStoryPlayer.init({
      container: document.getElementById('app'),
      books,
      audioBaseUrl: 'audio/',
      autoOpenLast: false,
      title: 'Lib',
    });
  }, books);
  await page.waitForSelector('#book-list .book-item');
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
}

// --- A: a correct library is silent -----------------------------------------
await boot([
  { slug: 'alpha', title: 'Alpha', duration: 8, chapters: chapters(0) },
  { slug: 'beta', title: 'Beta', duration: 8, chapters: chapters(0) },
]);
check(warnings.length === 0, `A: nothing warned for a correct library (${warnings.join(' | ')})`);

// --- B: a 1-based manifest is named -----------------------------------------
await boot([
  { slug: 'alpha', title: 'Alpha', duration: 8, chapters: chapters(1) },
]);
const idWarn = warnings.filter((w) => /chapter/i.test(w) && /id/i.test(w));
check(idWarn.length === 1, `B: exactly one chapter-id warning (${warnings.length} warnings total)`);
check(/alpha/i.test(idWarn[0] ?? ''), `B: it names the book ("${idWarn[0]}")`);
check(/\b0\b/.test(idWarn[0] ?? ''), `B: and the offending position ("${idWarn[0]}")`);

// --- C: colliding slugs are named -------------------------------------------
await boot([
  { title: STEM + 'Volume One', duration: 8, chapters: chapters(0) },
  { title: STEM + 'Volume Two', duration: 8, chapters: chapters(0) },
]);
const slugWarn = warnings.filter((w) => /slug/i.test(w));
check(slugWarn.length === 1, `C: exactly one slug-collision warning (${warnings.join(' | ')})`);
check(/the-same-opening-sixty/.test(slugWarn[0] ?? ''),
      `C: it names the colliding slug ("${slugWarn[0]}")`);

// --- D: it warns and gets out of the way ------------------------------------
// The point of detecting rather than repairing is that nothing else changes.
await page.click('#book-list .book-item .book-open');
const opened = await page.waitForSelector('#player-view.active', { timeout: 5000 })
  .then(() => true, () => false);
check(opened, 'D: a library that warned still opens a book');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
