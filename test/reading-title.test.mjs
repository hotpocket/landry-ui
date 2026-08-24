// reading-title.test.mjs — a long chapter title must not cost the controls.
//
// Run: node test/reading-title.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// A FEATURE suite, not a parity suite: it loads the Preact build from
// audiobook/player directly, rather than the audiobook/vanilla path the parity
// suites use. Frozen vanilla has the same defect and keeps it.
//
// Reported from a phone on books.landry.bot, reading mode, chapter titled
// "Chapter 3: Interrogating Your Own Motivation Until You Find the Extrinsic
// Goal Underneath": the title ran off the right edge and took the transcript
// text and the whole control row with it — A+ half off screen, follow and read
// past it and unreachable.
//
// The title is `white-space: nowrap` with an ellipsis, so the row looked like
// it should clip. It does not, and the reason is the whole finding: nowrap
// gives the element a min-content width as long as the title, `#player-view`
// is a flex item with the default `min-width: auto`, and a flex item is never
// laid out narrower than its min-content. Measured live: a 412px viewport, a
// 379px mount, and a #player-view 605px wide. The host's `overflow-x: hidden`
// then hid the fact that anything had overflowed at all — the controls were
// not pushed out of a scrollable area, they were clipped away.
//
// So the containment is the test. A standalone page cannot see this defect:
// there #player-view is a block in a block and simply cannot exceed its
// parent. This suite mounts the player the way books.landry.bot does — a flex
// column, `overflow-x: hidden` above it — because that is where the bug lives.
//
// The rule: the title may take a second line, and only a second (vertical
// space in reading mode is text), and nothing it does may move a control.
//
// Contract under test:
//   A. a long title wraps rather than running off — it uses more than one line
//   B. it stops at two lines, whatever its length — checked with a title that
//      would otherwise take four, since the reported one happens to fit in two
//      and cannot tell a clamp from its absence
//   C. #player-view stays inside its mount — the min-content blowout is gone
//   D. the title stays inside the viewport
//   E. every mini transport button is fully on screen, and play still plays
//   F. the text-size, follow and read controls are fully on screen
//   G. a short title still takes one line — the clamp is a ceiling, not a
//      reserved two-line slot
//   H. a title that is one unbreakable token is broken anyway, rather than
//      sizing the player again by a line nothing can wrap

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import os from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pwLib = process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright');
const { chromium } = createRequire(import.meta.url)(pwLib);

// The BUILD, deliberately — see the header.
const player = join(here, '../audiobook/player');
const fixture = join(here, 'fixture/out');
if (!existsSync(join(fixture, 'audio/chapter_0001.m4a'))) execFileSync(join(here, 'fixture/gen.sh'), { stdio: 'inherit' });

const playerJs = readFileSync(join(player, 'player.js'), 'utf8');
const playerCss = readFileSync(join(player, 'player.css'), 'utf8');
const feedbackJs = readFileSync(join(player, 'feedback.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

// The reported title, verbatim. Long in WORDS, not one unbreakable token —
// that is the case an ellipsis was supposed to cover.
const LONG = 'Chapter 3: Interrogating Your Own Motivation Until You Find the Extrinsic Goal Underneath';
const SHORT = 'Chapter 4: Two';
// Long enough to need four lines at this width: the clamp is invisible against
// a title that would have taken two anyway. Removing -webkit-line-clamp with
// only LONG in the fixture leaves the suite green — that is why this exists.
const HUGE = `${LONG}, ${LONG.toLowerCase()}`;
// The case wrapping alone cannot help: one run of letters, no space and no
// hyphen, so there is no break opportunity anywhere in it. (Hyphens ARE break
// opportunities — a hyphenated version of this leaves the suite green with
// overflow-wrap removed, and proves nothing.)
const TOKEN = 'Chapter6' + 'InterrogatingYourOwnMotivationUntilYouFindTheExtrinsicGoalUnderneath'.repeat(2);

const BOOKS = [{
  slug: 'b', book_id: 'b', title: 'Test Book', artist: '', duration: 120,
  chapters: [
    { id: 0, n: 3, title: LONG, filename: 'chapter_0001.m4a', start: 0, end: 30, duration: 30, size: 1 },
    { id: 1, n: 4, title: SHORT, filename: 'chapter_0002.m4a', start: 30, end: 60, duration: 30, size: 1 },
    { id: 2, n: 5, title: HUGE, filename: 'chapter_0001.m4a', start: 60, end: 90, duration: 30, size: 1 },
    { id: 3, n: 6, title: TOKEN, filename: 'chapter_0002.m4a', start: 90, end: 120, duration: 30, size: 1 },
  ],
}];
const chunks = (n, tag) => Array.from({ length: n }, (_, i) => ({
  index: i, text: `${tag} chunk ${i}, spoken words for testing.`, start: i * 0.7, end: (i + 1) * 0.7,
}));
const TRANSCRIPTS = { books: [{ slug: 'b', chapters: [
  { index: 3, title: LONG, chunks: chunks(40, 'one') },
  { index: 4, title: SHORT, chunks: chunks(10, 'two') },
  { index: 5, title: HUGE, chunks: chunks(10, 'three') },
  { index: 6, title: TOKEN, chunks: chunks(10, 'four') },
] }] };

// The host, as books.landry.bot builds it: a flex column page, a flex <main>
// that clips horizontally, and the mount as a flex child. Every one of those
// is load-bearing for the defect — see the header.
const HOST = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0}${playerCss}</style>
<style>
  body{display:flex;flex-direction:column;height:100svh}
  main.view{flex:1;min-height:0;display:flex;overflow-x:hidden}
  .space{flex:1 1 0;display:flex;min-height:0}
  #player-mount{flex:1 1 0;display:flex;min-height:0}
</style></head>
<body class="rs-embedded-page">
<main class="view"><div class="space"><div id="player-mount"
  class="rs-player player-embedded-host player-no-library-heading"></div></div></main>
<script>${feedbackJs}</script>
<script>${playerJs}</script>
<script>RepoStoryPlayer.init({
  container: document.getElementById('player-mount'),
  books: ${JSON.stringify(BOOKS)},
  transcripts: ${JSON.stringify(TRANSCRIPTS)},
  transcriptUrl: "data:application/json;base64,${Buffer.from(JSON.stringify(TRANSCRIPTS)).toString('base64')}",
  audioBaseUrl: 'audio/', embedded: true,
  chrome: { back: false, nowPlaying: false, libraryHeading: false },
});</script>
</body></html>`;

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', m4a: 'audio/mp4' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/' || path.endsWith('.html')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HOST);
    return;
  }
  const file = join(fixture, path.slice(1));
  if (!file.startsWith(fixture) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  const body = readFileSync(file);
  const ext = file.split('.').pop();
  const range = req.headers.range && req.headers.range.match(/bytes=(\d+)-(\d*)/);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = range[2] ? parseInt(range[2], 10) : body.length - 1;
    res.writeHead(206, { 'content-type': MIME[ext] || 'application/octet-stream',
                         'content-range': `bytes ${start}-${end}/${body.length}`,
                         'accept-ranges': 'bytes', 'content-length': end - start + 1 });
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
// The reported device.
const page = await browser.newPage({ viewport: { width: 412, height: 915 },
                                     deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

await page.goto(origin + '/index.html');
await page.waitForSelector('.book-item', { timeout: 10000 });
await page.click('.book-item .title');
await page.waitForSelector('#player-view.active', { timeout: 10000 });
await page.click('#reading-btn');
await page.waitForSelector('#player-view.reading-mode');
await page.waitForFunction((t) => document.querySelector('#reading-chapter').textContent === t, LONG, { timeout: 5000 });

const titleBox = () => page.evaluate(() => {
  const el = document.querySelector('#reading-chapter');
  const r = el.getBoundingClientRect();
  // Lines by measurement, not by reading back the clamp property: a rule that
  // sets -webkit-line-clamp but is overridden elsewhere still reports itself.
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
  // VISIBLE lines: a clamped -webkit-box still lays out every line box and
  // Range still reports it — the clamp hides them, it does not delete them.
  // Counting all of them says "4 lines" about a row that is two lines tall,
  // which is a measurement of the wrong thing, not a defect. Measured that way
  // first, and it called the working clamp broken.
  const inside = rects.filter((x) => x.top >= r.top - 1 && x.bottom <= r.bottom + 1);
  return {
    lines: new Set(inside.map((x) => Math.round(x.top))).size,
    laidOut: new Set(rects.map((x) => Math.round(x.top))).size,
    height: r.height, right: r.right, left: r.left,
    textRight: Math.max(0, ...inside.map((x) => x.right)),
  };
});
const box = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
           vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
}, sel);
const inView = (b) => !!b && b.w > 0 && b.h > 0 && b.left >= -0.5 && b.right <= b.vw + 0.5
                   && b.top >= -0.5 && b.bottom <= b.vh + 0.5;
const fmt = (b) => (b ? `${b.left.toFixed(0)}–${b.right.toFixed(0)} of ${b.vw}` : 'missing');

// --- A: the reported title wraps -------------------------------------------
const t = await titleBox();
check(t.lines > 1, `A: the long title wraps (${t.lines} line(s))`);

// --- C: the player stays inside the screen ---------------------------------
// Against the VIEWPORT, not the mount: the mount is a flex item with the same
// `min-width: auto` and blows out alongside the player, so a view-vs-mount
// comparison passes while both hang off the right edge. Measured that way
// before the fix: view 637, mount 637, screen 412 — a green light on a broken
// layout.
const fit = await page.evaluate(() => ({
  view: document.querySelector('#player-view').getBoundingClientRect().width,
  mount: document.querySelector('#player-mount').getBoundingClientRect().width,
  screen: document.documentElement.clientWidth,
}));
check(fit.view <= fit.screen + 0.5,
      `C: #player-view fits the screen (view ${fit.view.toFixed(0)}, mount ${fit.mount.toFixed(0)}, screen ${fit.screen})`);

// --- D: the title stays inside the screen ----------------------------------
check(t.right <= fit.screen + 0.5 && t.textRight <= fit.screen + 0.5,
      `D: title inside the screen (box right ${t.right.toFixed(0)}, text right ${t.textRight.toFixed(0)}, screen ${fit.screen})`);

// --- E, F: the controls are all still on screen -----------------------------
for (const sel of ['#mini-prev-btn', '#mini-play-btn', '#mini-next-btn']) {
  const b = await box(sel);
  check(inView(b), `E: ${sel} fully on screen (${fmt(b)})`);
}
for (const sel of ['#ts-dec', '#ts-inc', '#follow-btn', '#reading-btn']) {
  const b = await box(sel);
  check(inView(b), `F: ${sel} fully on screen (${fmt(b)})`);
}
// Visible and inert is not visible.
await page.click('#mini-play-btn');
await page.waitForFunction(() => { const a = document.querySelector('audio'); return a && !a.paused; }, null, { timeout: 10000 });
ok('E: the mini play button still starts playback');
await page.evaluate(() => document.querySelector('audio').pause());

// --- G: a short title takes one line ---------------------------------------
const next = async (title) => {
  await page.click('#mini-next-btn');
  await page.waitForFunction((x) => document.querySelector('#reading-chapter').textContent === x, title, { timeout: 5000 });
  return titleBox();
};
const short = await next(SHORT);
check(short.lines === 1, `G: a short title takes one line (${short.lines})`);
check(short.height < t.height,
      `G: and less height than the wrapped one (${short.height.toFixed(1)} vs ${t.height.toFixed(1)})`);

// --- B: the clamp, against a title that would take four lines ---------------
const huge = await next(HUGE);
check(huge.lines <= 2, `B: a four-line title is clamped to two (${huge.lines} visible of ${huge.laidOut})`);
check(huge.height <= t.height + 0.5,
      `B: and costs no more height than a two-line one (${huge.height.toFixed(1)} vs ${t.height.toFixed(1)})`);
const stillFitsHuge = await page.evaluate(() => ({
  view: document.querySelector('#player-view').getBoundingClientRect().width,
  screen: document.documentElement.clientWidth,
}));
check(stillFitsHuge.view <= stillFitsHuge.screen + 0.5,
      `B: and does not size the player (${stillFitsHuge.view.toFixed(0)} vs ${stillFitsHuge.screen})`);

// --- H: one unbreakable token ----------------------------------------------
const token = await next(TOKEN);
check(token.lines <= 2, `H: an unbreakable title is clamped to two lines (${token.lines} visible of ${token.laidOut})`);
const fitToken = await page.evaluate(() => ({
  view: document.querySelector('#player-view').getBoundingClientRect().width,
  screen: document.documentElement.clientWidth,
  read: document.querySelector('#reading-btn').getBoundingClientRect().right,
}));
check(fitToken.view <= fitToken.screen + 0.5,
      `H: #player-view still fits the screen (${fitToken.view.toFixed(0)} vs ${fitToken.screen})`);
check(fitToken.read <= fitToken.screen + 0.5,
      `H: and the way out is still on it (read ends at ${fitToken.read.toFixed(0)})`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
