// reading-progress.test.mjs — where you are in the chapter, without the chrome.
//
// Run: node test/reading-progress.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// A FEATURE suite, not a parity suite: it loads the Preact build from
// audiobook/player directly, rather than the audiobook/vanilla path the parity
// suites use. Vanilla does not have this and never will.
//
// Reading mode hides the transport, the track bar and the chapter list — every
// indication of position goes with them. What is left is text, which is the
// point, but a reader with no idea whether a chapter has thirty seconds or
// thirty minutes left is being asked to guess.
//
// A hairline at the top of the view answers that without giving the chrome
// back: it is 2px, it is only there in reading mode, and it says position
// within the CURRENT CHAPTER, which is the unit a reader is actually in.
//
// Contract under test:
//   A. the bar does not exist visually outside reading mode — the track bar
//      already says this there
//   B. entering reading mode reveals it
//   C. it fills left to right as the chapter plays
//   D. it reports the CHAPTER, not the book: at the start of chapter 2 of 3 it
//      is near empty, not two-thirds full
//   E. it is a hairline — a thick bar is chrome, which is what reading mode
//      exists to remove
//   F. leaving reading mode hides it again

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
// The BUILD, deliberately — see the header.
const player = join(here, '../audiobook/player');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  // The fixture asks for /audiobook/vanilla/*; serve the build from there so the
  // shared fixture needs no fork.
  const base = path.startsWith('/audiobook/vanilla/')
    ? join(player, path.slice('/audiobook/vanilla/'.length))
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

const shown = () => page.evaluate(() => {
  const el = document.querySelector('#reading-progress');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { display: cs.display, visible: r.width > 0 && r.height > 0, height: r.height, top: r.top };
});
const fillPct = () => page.evaluate(() => {
  const bar = document.querySelector('#reading-progress-fill');
  if (!bar) return null;
  return parseFloat(bar.style.width) || 0;
});

// --- A: absent outside reading mode ---------------------------------------
const outside = await shown();
// display, not just zero-size: without the reading-mode rule the element has no
// height anyway, so a size check passed even with `display: block` forced on.
// Mutation caught that.
check(outside !== null && outside.display === 'none',
      `A: display:none outside reading mode (was ${outside && outside.display})`);

// --- B, E: reading mode reveals a hairline ---------------------------------
await page.click('#reading-btn');
await page.waitForSelector('#player-view.reading-mode');
const inside = await shown();
check(inside && inside.visible, 'B: visible in reading mode');
check(inside && inside.height > 0 && inside.height <= 3,
      `E: it is a hairline (${inside ? inside.height : '?'}px)`);

// --- C: fills as the chapter plays -----------------------------------------
await page.click('#mini-play-btn');
await page.waitForFunction(() => {
  const a = document.querySelector('audio');
  return a && !a.paused && a.currentTime > 0.3;
}, null, { timeout: 10000 });
const early = await fillPct();
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
const later = await fillPct();
check(later > early, `C: fills left to right (${early}% → ${later}%)`);

// --- D: chapter-relative, not book-relative --------------------------------
await page.evaluate(() => document.querySelector('audio').pause());
await page.click('#mini-next-btn');
await page.waitForFunction(() => {
  const a = document.querySelector('audio');
  return a && a.readyState >= 1 && a.currentTime < 0.5;
}, null, { timeout: 10000 });
await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
const atChapterStart = await fillPct();
check(atChapterStart !== null && atChapterStart < 20,
      `D: near empty at the start of a later chapter, not book-relative (${atChapterStart}%)`);

// --- F: leaving hides it ---------------------------------------------------
await page.click('#reading-btn');
await page.waitForFunction(() => !document.querySelector('#player-view').classList.contains('reading-mode'));
const after = await shown();
check(after !== null && after.display === 'none',
      `F: display:none again after leaving reading mode (was ${after && after.display})`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
