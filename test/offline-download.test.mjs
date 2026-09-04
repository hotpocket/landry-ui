// offline-download.test.mjs — a failed download must say so, and offer retry.
//
// Run: node test/offline-download.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// A FEATURE suite: it loads the Preact build from audiobook/player directly.
// (parity.sh also runs it against its staged copy of the same build, which is
// harmless — it never exercises vanilla.)
//
// The defect this guards: downloadForOffline caught every failure by resetting
// the button to its idle state. On a phone — expired signature, dropped radio —
// the button flashed "Preparing…" and went straight back to "Download ⇣", and
// the only evidence anything failed was a console nobody can open.
//
// Rewritten 2026-08-26, not relaxed. The control shrank from a 128px pill with
// a word in it to an icon the size of the menu button beside it — the action
// itself moved into the chapter menu (landry-ui/docs/spec-chapter-list.md §6),
// and what stays on the shelf is the state REPORT. So the assertions moved off
// the visible words and onto the ACCESSIBLE NAME, which is what a reader with a
// screen reader or a hover gets and the only place the states are still spelt
// out. Stricter, not looser: the name has to name the state AND the control has
// to stay small, which the old version never checked.
//
// Contract under test:
//   A. a failing download leaves the button in a visible FAILED state, named as
//      such, not the idle name it started with
//   B. the failed state is styled distinctly from an idle button — colour is
//      how the list is scanned, and a failure that only differs in wording is
//      invisible at a glance
//   C. the failed button stays clickable, and clicking it retries: once the
//      network recovers, the same button reaches its downloaded state
//   D. and it stays an icon — the size is the whole point of the change

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
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream',
                       'accept-ranges': 'bytes', 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

// Kill the audio fetches: this is the phone with an expired signature or a
// dropped connection. Shell files still load — shell failure is non-fatal by
// design, so only an audio failure exercises the path under test.
await page.route('**/audio/*.m4a', (route) => route.abort());

await page.goto(origin);
await page.waitForSelector('#book-list .book-item .dl-btn');

const btnState = (idx) => page.evaluate((i) => {
  const btn = document.querySelectorAll('#book-list .book-item .dl-btn')[i];
  const cs = getComputedStyle(btn);
  const r = btn.getBoundingClientRect();
  // The NAME, not the glyph: the glyph is a tick or an arrow and says nothing
  // on its own, and the name is what a hover and a screen reader read.
  return { name: btn.getAttribute('aria-label') || btn.getAttribute('title') || '',
           glyph: btn.textContent.trim(), cls: btn.className,
           color: cs.color, border: cs.borderColor, w: Math.round(r.width) };
}, idx);

const idle = await btnState(0);

// --- A: failure is visible -------------------------------------------------
await page.click('#book-list .book-item .dl-btn');
await page.waitForFunction(() => {
  const btn = document.querySelector('#book-list .book-item .dl-btn');
  // Settled: no longer idle-labelled and no longer in the downloading state.
  return btn && !btn.classList.contains('downloading') && btn.classList.contains('error');
}, null, { timeout: 15000 }).catch(() => {});
// Park the mouse first: page.click leaves the pointer on the button, and the
// :hover rule paints an idle button blue — which made this check pass against
// an implementation with no error styling at all.
await page.mouse.move(0, 0);
// …and let the 0.15s hover transition finish, or the sample reads mid-fade.
await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
const failed = await btnState(0);
check(failed.name !== idle.name,
      `A: a failed download is not named as an idle one ("${failed.name}")`);
check(/fail|retry/i.test(failed.name),
      `A: and the name says it failed ("${failed.name}")`);
check(failed.glyph !== idle.glyph,
      `A: the glyph changes too, so the state reads without a hover ("${idle.glyph}" -> "${failed.glyph}")`);

// --- B: styled distinctly --------------------------------------------------
const idleNow = await btnState(1);  // second book's button, untouched
check(failed.color !== idleNow.color || failed.border !== idleNow.border,
      `B: failed state is styled apart from idle (${failed.color} vs ${idleNow.color})`);

// --- C: the failed button retries, and can succeed -------------------------
await page.unroute('**/audio/*.m4a');
await page.click('#book-list .book-item .dl-btn');
await page.waitForFunction(() => {
  const btn = document.querySelector('#book-list .book-item .dl-btn');
  return btn && btn.classList.contains('downloaded');
}, null, { timeout: 30000 }).catch(() => {});
const after = await btnState(0);
check(/downloaded/.test(after.cls) && /offline/i.test(after.name),
      `C: retry from the failed button succeeds ("${after.name}", ${after.cls})`);

// --- D: it is an icon, not a pill -----------------------------------------
// The reason this change was made at all. 128px of "Download ⇣" beside every
// title read as the primary thing to do with a book; opening it is.
check(after.w <= 48 && idle.w <= 48,
      `D: the control is an icon at every state (idle ${idle.w}px, settled ${after.w}px)`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
