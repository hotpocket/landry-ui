// search.test.mjs — searching the library, and what it refuses to download.
//
// Run: node test/search.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// The searching itself is covered by core-search.test.mjs without a browser.
// What needs a browser is the loading behaviour, which is the entire design:
// transcripts are not on the client when the reader starts typing, and audio
// must never be fetched to answer a search.
//
// Contract under test:
//   A. results appear for the book whose transcript is already loaded, without
//      waiting for the others
//   B. the other transcripts are fetched, and their results stream in after
//   C. searching NEVER fetches audio — this is the one that costs real money
//      and battery if it regresses
//   D. the spinner shows while transcripts are in flight and clears after
//   E. the spinner says WHAT is loading, so a hover explains itself
//   F. clearing the query restores the library
//   G. choosing a result opens that book and seeks — and only then is audio
//      fetched
//   H. book titles match too, from the payload already in memory

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

// Two books, each with its own transcript URL, so "loaded" and "not loaded" are
// genuinely different states. Chapter audio is real fixture audio.
const BOOKS = [
  { slug: 'alpha', title: 'Alpha Book' },
  { slug: 'beta', title: 'Beta Book' },
];
const TRANSCRIPTS = {
  'alpha.json': { books: [{ slug: 'alpha', chapters: [
    { index: 1, chunks: [
      { index: 0, text: 'The alpha dragon roared at dawn.', start: 0, end: 2 },
      { index: 1, text: 'Nothing else here.', start: 2, end: 4 },
    ] },
  ] }] },
  'beta.json': { books: [{ slug: 'beta', chapters: [
    { index: 1, chunks: [
      { index: 0, text: 'A beta dragon slept in the valley.', start: 0, end: 2 },
    ] },
  ] }] },
};

const requests = [];
let holdBeta = null;   // a promise that gates beta.json, to observe streaming

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  requests.push(path);

  if (path === '/alpha.json' || path === '/beta.json') {
    if (path === '/beta.json' && holdBeta) await holdBeta;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(TRANSCRIPTS[path.slice(1)]));
    return;
  }

  if (/_0001\.m4a$/.test(path)) {
    const body = readFileSync(join(outDir, 'audio', 'chapter_0001.m4a'));
    res.writeHead(200, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes',
                         'content-length': body.length });
    res.end(body);
    return;
  }

  const base = path.startsWith('/audiobook/vanilla/')
    ? join(player, path.slice('/audiobook/vanilla/'.length))
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
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

// Drive the player directly rather than through the shared fixture, so the two
// books can have separate transcript URLs.
await page.goto(`${origin}/`);
await page.evaluate(({ books }) => {
  document.body.innerHTML = '<div id="app"></div>';
  window.RepoStoryPlayer.init({
    container: document.getElementById('app'),
    books: books.map((b, i) => ({
      ...b,
      transcriptUrl: `/${b.slug}.json`,
      duration: 4,
      // Distinct filename per book on purpose: with a shared one the browser
      // serves the second book's chapter from cache and makes no request, so
      // "audio was fetched" becomes untestable.
      chapters: [{ id: 0, n: 1, title: 'Ch 1', filename: `${b.slug}_0001.m4a`,
                   start: 0, end: 4, duration: 4, size: 1 }],
    })),
    audioBaseUrl: 'audio/',
    autoOpenLast: false,
    title: 'Test Library',
  });
}, { books: BOOKS });

await page.waitForSelector('#search-input');

const audioRequests = () => requests.filter((p) => p.endsWith('.m4a'));

// --- A: the loaded book answers immediately --------------------------------
// Open alpha so its transcript is in memory, then return to the library.
await page.click('#book-list .book-item .title');
await page.waitForSelector('#player-view.active');
await page.waitForFunction(() => document.querySelectorAll('.transcript-chunk').length > 0,
                           null, { timeout: 10000 });
await page.click('#back-btn');
await page.waitForSelector('#library:not([style*="none"])');

holdBeta = new Promise((r) => setTimeout(r, 2500));
const beforeAudio = audioRequests().length;

await page.fill('#search-input', 'dragon');
await page.waitForSelector('.search-results .search-group[data-book="alpha"]', { timeout: 5000 });
const earlyBooks = await page.$$eval('.search-group[data-book]', (n) => n.map((x) => x.dataset.book));
check(earlyBooks.includes('alpha') && !earlyBooks.includes('beta'),
      `A: the loaded book answered first (${earlyBooks.join(',') || 'none'})`);

// --- D, E: spinner while beta is in flight ---------------------------------
const spin = await page.evaluate(() => {
  const el = document.querySelector('#search-spinner');
  return { hidden: el.hidden, title: el.title };
});
check(!spin.hidden, 'D: spinner is showing while a transcript is in flight');
check(/transcript/i.test(spin.title) && /beta/i.test(spin.title),
      `E: spinner names what is loading ("${spin.title}")`);

// --- B: beta streams in ----------------------------------------------------
await page.waitForSelector('.search-group[data-book="beta"]', { timeout: 10000 })
  .then(() => ok('B: the second book streamed in when its transcript landed'),
        () => bad('B: the second book never streamed in'));

await page.waitForFunction(() => document.querySelector('#search-spinner').hidden,
                           null, { timeout: 5000 })
  .then(() => ok('D2: spinner cleared once nothing is in flight'),
        () => bad('D2: spinner never cleared'));

// --- C: no audio fetched by searching --------------------------------------
check(audioRequests().length === beforeAudio,
      `C: searching fetched no audio (${audioRequests().length - beforeAudio} chapter requests)`);

// --- H: titles match from memory -------------------------------------------
await page.fill('#search-input', 'Beta Book');
await page.waitForSelector('.search-hit-book', { timeout: 5000 })
  .then(() => ok('H: book titles match too'),
        () => bad('H: book titles did not match'));

// --- F: clearing restores the library --------------------------------------
await page.fill('#search-input', '');
await page.waitForFunction(() => {
  const r = document.querySelector('#search-results');
  const l = document.querySelector('#book-list');
  return r.hidden && !l.hidden;
}, null, { timeout: 5000 })
  .then(() => ok('F: clearing the query restores the library'),
        () => bad('F: clearing the query did not restore the library'));

// --- G: choosing a result opens and seeks, and only then loads audio -------
await page.fill('#search-input', 'dragon');
await page.waitForSelector('.search-group[data-book="beta"] .search-hit', { timeout: 10000 });
const audioBeforeClick = audioRequests().length;
await page.click('.search-group[data-book="beta"] .search-hit');
await page.waitForSelector('#player-view.active', { timeout: 5000 });
await page.waitForFunction((n) => window.__none || true, null).catch(() => {});
await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
check(audioRequests().length > audioBeforeClick,
      'G: audio is fetched only once a result is chosen');
const openTitle = await page.textContent('#book-title');
check(/beta/i.test(openTitle || ''), `G2: it opened the right book ("${openTitle}")`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
