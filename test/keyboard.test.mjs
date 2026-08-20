// keyboard.test.mjs — Space plays and pauses from anywhere on the page.
//
// Run: node test/keyboard.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// Reported from books.landry.bot: "space works to pause/play, but only after
// clicking pause". That was not a shortcut at all. It was the browser
// activating a focused button, so the key worked exactly as long as focus
// happened to be sitting on the transport and nowhere else. A listener
// reading a book with the page scrolled to the transcript had nothing.
//
// The rules a global key handler has to respect, each of which is a way to
// make this worse than not having it:
//
//   A. it works with focus nowhere in particular, which is where focus is
//   B. it stops the page scrolling, which is what Space does otherwise
//   C. it does not fire while somebody is typing. A space in a search box that
//      pauses the book instead of typing a space is a worse bug than the one
//      this fixes
//   D. it does not double-fire when the transport already has focus. The
//      browser activates that button on its own, and a handler that also runs
//      toggles twice, which reads as the key doing nothing
//   E. it leaves the library alone: Space on a focused book row opens that
//      book, and that is book-menu's case I
//   F. a held key does not machine-gun the transport

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

// Sound without a click, so intent and element state agree and a failure here
// is about the key rather than about autoplay policy.
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

// The transport's glyph IS the playing state, and it is drawn from intent
// rather than from the element: a chapter still loading is silent and still
// intends to play. Reading the glyph therefore asks the same question the
// listener is asking.
const PLAY = '▶';
const playing = () => page.$eval('#play-btn', (b) => b.textContent.trim() !== '▶');

async function boot() {
  await page.goto(`${origin}/`);
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="app"></div>';
    window.RepoStoryPlayer.init({
      container: document.getElementById('app'),
      books: [{ slug: 'alpha', title: 'Alpha', duration: 4,
                chapters: [{ id: 0, n: 1, title: 'Ch 1', filename: 'chapter_0001.m4a',
                             start: 0, end: 4, duration: 4, size: 1 }] }],
      audioBaseUrl: 'audio/',
      autoOpenLast: false,
      title: 'Lib',
    });
  });
  await page.waitForSelector('#book-list .book-item');
}

// Where a reader's focus actually is: nowhere. Clicking the transcript pane or
// any inert region leaves document.body active, which is the state every
// keyboard shortcut on the web has to work from.
const focusNothing = () => page.evaluate(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});

// --- E: the library is not the player -------------------------------------
await boot();
await focusNothing();
await page.keyboard.press('Space');
await page.waitForTimeout(200);
check(!(await page.$('#player-view.active')),
      'E: Space in the library does not start something invisible');

// Open the book the way a reader does.
await page.click('#book-list .book-item .book-open');
await page.waitForSelector('#player-view.active');
await page.waitForTimeout(300);
check(!(await playing()), 'precondition: a freshly opened book is paused');

// --- A, B: it works from nowhere, and does not scroll the page ------------
{
  await focusNothing();
  // Armed, NOT awaited: this resolves on the keypress below, so awaiting it
  // first waits for an event only the next line can cause. It deadlocked the
  // suite on its first run.
  const prevented = page.evaluate(() => new Promise((resolve) => {
    // The page's own view of the event, after every handler has seen it.
    // Asserting on scrollY instead would pass on a page too short to scroll,
    // which this fixture is.
    document.addEventListener('keydown', function once(e) {
      if (e.key !== ' ') return;
      document.removeEventListener('keydown', once);
      resolve(e.defaultPrevented);
    });
  }));
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  check(await playing(), 'A: Space with focus nowhere starts playback');
  check(await prevented, 'B: and the page does not scroll under it');
}

// --- A2: and it toggles back ----------------------------------------------
await page.keyboard.press('Space');
await page.waitForTimeout(300);
check(!(await playing()), 'A2: Space again pauses');

// --- C: not while somebody is typing --------------------------------------
{
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.id = 'typing';
    document.body.appendChild(i);
    i.focus();
  });
  await page.keyboard.type('a b');
  await page.waitForTimeout(200);
  check(await page.$eval('#typing', (i) => i.value) === 'a b',
        'C: a space typed into a field is a space');
  check(!(await playing()), 'C: and it does not touch the book');
  await page.evaluate(() => document.getElementById('typing').remove());
}

// --- D: no double toggle when the transport has focus ---------------------
{
  await focusNothing();
  await page.$eval('#play-btn', (b) => b.focus());
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  check(await playing(),
        'D: Space on the focused transport toggles once, not twice');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  check(!(await playing()), 'D: and once more the other way');
}

// --- F: holding it down is one toggle -------------------------------------
//
// Synthesised, and it has to be. `keyboard.down` holds the key without ever
// repeating it — the repeats a real listener produces come from the OS, not
// from the browser — so the first version of this case pressed and held for
// 600ms, passed, and could not have failed: deleting the `e.repeat` guard left
// it green. The events below are what an OS repeat actually delivers.
{
  await focusNothing();
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const wasPlaying = await playing();
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ', code: 'Space', repeat: true, bubbles: true, cancelable: true,
      }));
    }
  });
  await page.waitForTimeout(300);
  check(await playing() === wasPlaying,
        `F: five repeats of a held key change nothing (was ${wasPlaying})`);
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
