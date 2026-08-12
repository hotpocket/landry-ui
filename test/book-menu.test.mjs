// book-menu.test.mjs — the host-supplied per-book menu.
//
// Run: node test/book-menu.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// The menu is the one deliberate extension point for hosts. It has to be
// absent unless a host asks for it, because karagame and brandonlandry.com run
// this same player with no API behind them — a menu there would offer actions
// that 404.
//
// Items cross the boundary as {id, label, onSelect}: values and callbacks, not
// components. That is what lets books.landry.bot supply a menu while staying
// plain JS with no build step of its own.
//
// Contract under test:
//   A. no bookActions means no menu button at all
//   B. bookActions renders a button per book
//   C. the menu is closed until opened
//   D. opening it lists the host's labels, in the host's order
//   E. choosing an item calls the host's callback WITH the book
//   F. choosing an item closes the menu
//   G. only one book's menu is open at a time
//   F2. clicking the same button again closes it
//   H. opening the menu does not open the book — the click must not fall
//      through to the row behind it
//   I. the row that opens the book is reachable and operable from the keyboard.
//      The download and menu buttons beside it are real buttons and have always
//      been focusable, which is exactly why the gap in the row itself survived
//      manual testing: tabbing through the library looks like it works.

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

const BOOKS = [
  { slug: 'alpha', title: 'Alpha' },
  { slug: 'beta', title: 'Beta' },
];

async function boot(withActions) {
  await page.goto(`${origin}/`);
  await page.evaluate(({ books, withActions }) => {
    document.body.innerHTML = '<div id="app"></div>';
    window.__calls = [];
    const cfg = {
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
    if (withActions) {
      cfg.bookActions = [
        { id: 'visibility', label: 'Visibility…',
          onSelect: (b) => window.__calls.push(['visibility', b.title]) },
        { id: 'share', label: 'Share with…',
          onSelect: (b) => window.__calls.push(['share', b.title]) },
      ];
    }
    window.RepoStoryPlayer.init(cfg);
  }, { books: BOOKS, withActions });
  await page.waitForSelector('#book-list .book-item');
}

// --- A: absent without bookActions -----------------------------------------
await boot(false);
check(await page.$$eval('.book-menu-btn', (n) => n.length) === 0,
      'A: no menu button when the host supplies no actions');

// --- B, C: present, closed -------------------------------------------------
await boot(true);
check(await page.$$eval('.book-menu-btn', (n) => n.length) === 2,
      'B: a menu button per book');
check(await page.$$eval('.book-menu-items', (n) => n.length) === 0,
      'C: closed until opened');

// --- D: the host's labels, in the host's order -----------------------------
await page.click('#book-menu-btn-0');
await page.waitForSelector('.book-menu-items');
const labels = await page.$$eval('.book-menu-item', (n) => n.map((x) => x.textContent.trim()));
check(labels.join('|') === 'Visibility…|Share with…',
      `D: host labels in host order (${labels.join('|')})`);

// --- H: opening the menu did not open the book ----------------------------
check(!(await page.$('#player-view.active')),
      'H: opening the menu did not open the book');

// --- E, F: choosing calls back with the book, and closes -------------------
await page.click('.book-menu-item[data-action="share"]');
const calls = await page.evaluate(() => window.__calls);
check(JSON.stringify(calls) === JSON.stringify([['share', 'Alpha']]),
      `E: callback got the action and the book (${JSON.stringify(calls)})`);
check(await page.$$eval('.book-menu-items', (n) => n.length) === 0,
      'F: choosing an item closed the menu');

// --- F2: the same button toggles ------------------------------------------
// Switching between two books hid this: the second click landed on a different
// button and "one menu open" stayed true either way. Mutation caught it.
await page.click('#book-menu-btn-0');
await page.waitForSelector('.book-menu-items');
await page.click('#book-menu-btn-0');
await page.waitForTimeout(50);
check(await page.$$eval('.book-menu-items', (n) => n.length) === 0,
      'F2: clicking the same button again closes the menu');

// --- G: one at a time ------------------------------------------------------
await page.click('#book-menu-btn-0');
await page.waitForSelector('.book-menu-items');
await page.click('#book-menu-btn-1');
await page.waitForTimeout(50);
const open = await page.$$eval('.book-menu-items', (n) => n.length);
check(open === 1, `G: only one menu open at a time (${open})`);

// --- I: the book row is keyboard-operable ----------------------------------
await page.keyboard.press('Escape');
await page.waitForTimeout(50);
const row = await page.$('#book-list .book-item .book-open');
check(!!row, 'I: the row that opens a book is a named, addressable control');
const semantics = await page.$eval('#book-list .book-item .book-open',
  (el) => ({ role: el.getAttribute('role'), tab: el.getAttribute('tabindex'), tag: el.tagName }));
check(semantics.tag === 'BUTTON' || (semantics.role === 'button' && semantics.tab === '0'),
      `I: it announces itself as a button and takes focus (${JSON.stringify(semantics)})`);

// Operate it the way a keyboard user does, not by synthesising a click.
await page.$eval('#book-list .book-item .book-open', (el) => el.focus());
await page.keyboard.press('Enter');
const openedByEnter = await page.waitForSelector('#player-view.active', { timeout: 5000 })
  .then(() => true, () => false);
check(openedByEnter, 'I: Enter on the focused row opens the book');

await page.click('#back-btn');
await page.waitForSelector('#book-list .book-item .book-open', { state: 'visible' });
await page.$eval('#book-list .book-item .book-open', (el) => el.focus());
await page.keyboard.press('Space');
const openedBySpace = await page.waitForSelector('#player-view.active', { timeout: 5000 })
  .then(() => true, () => false);
check(openedBySpace, 'I: Space on the focused row opens the book');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
