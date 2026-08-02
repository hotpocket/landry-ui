// embed.test.mjs — the player works inside a host page, not only as the page.
//
// Run: node test/embed.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// The player was written to be the whole document: .player-view.active takes
// height:100svh, and it renders its own back button and now-playing block.
// Embedded under a host's header that is exactly the header's height too tall
// — the transport ends up below the fold — and any chrome the host already
// provides is duplicated.
//
// books.landry.bot hit all three and worked around them in its own stylesheet.
// These are the upstream fixes so the next consumer does not have to.
//
// Contract under test:
//   A. standalone is unchanged — the player still fills the viewport
//   B. embedded: true makes it fill its container instead
//   C. embedded, the transport stays inside the container
//   D. chrome options suppress the back button and the now-playing block
//   E. those options default to on, so existing consumers see no change
//   F. narrow viewports stack the panes instead of splitting them 50/50
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const vanilla = join(here, '../audiobook/vanilla');
const pwLib = process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright');
const { chromium } = createRequire(import.meta.url)(pwLib);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

const playerJs = readFileSync(join(vanilla, 'player.js'), 'utf8');
const playerCss = readFileSync(join(vanilla, 'player.css'), 'utf8');
const feedbackJs = readFileSync(join(vanilla, 'feedback.js'), 'utf8');

function chapters(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i, n: i + 1, title: `Chapter ${i + 1}`,
    filename: `ch${i + 1}.m4a`,
    start: i * 10, end: (i + 1) * 10, duration: 10, size: 1000,
  }));
}
const BOOKS = [{ slug: 'b', book_id: 'b', title: 'Test Book', artist: '',
                 duration: 80, chapters: chapters(8) }];

// HOST_HEADER stands in for a consumer's own chrome above the player.
function page(opts, host) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0}${playerCss}</style>
${host ? '<style>#host{display:flex;flex-direction:column;height:100svh}' +
         '#bar{height:52px;flex:none;background:#222}' +
         '#app{flex:1;min-height:0;display:flex}</style>' : ''}
</head><body>
${host ? '<div id="host"><div id="bar"></div><div id="app"></div></div>'
       : '<div id="app"></div>'}
<script>${feedbackJs}</script>
<script>${playerJs}</script>
<script>RepoStoryPlayer.init(Object.assign(
  { container: document.getElementById('app'), books: ${JSON.stringify(BOOKS)},
    audioBaseUrl: 'audio/' }, ${JSON.stringify(opts)}));</script>
</body></html>`;
}

let pending = null;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(pending);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

async function open(opts, host, viewport) {
  pending = page(opts, host);
  const p = await browser.newPage({ viewport: viewport || { width: 900, height: 700 } });
  p.on('pageerror', (e) => bad(`page error: ${e.message}`));
  await p.goto(origin + '/index.html');
  await p.waitForSelector('.book-item', { timeout: 5000 });
  await p.click('.book-item .title');
  await p.waitForSelector('#player-view.active', { timeout: 5000 });
  await p.waitForTimeout(200);
  return p;
}

// --- A: standalone is untouched ---
{
  const p = await open({}, false);
  const h = await p.$eval('#player-view', (e) => Math.round(e.getBoundingClientRect().height));
  check(h >= 690 && h <= 700, `A: standalone still fills the viewport (${h} of 700)`);
  await p.close();
}

// --- B + C: embedded fills its container, transport included ---
{
  const p = await open({ embedded: true }, true);
  const m = await p.evaluate(() => {
    const host = document.getElementById('app').getBoundingClientRect();
    const view = document.querySelector('#player-view').getBoundingClientRect();
    const ctl = document.querySelector('.player-controls').getBoundingClientRect();
    return { hostH: Math.round(host.height), viewH: Math.round(view.height),
             hostBottom: Math.round(host.bottom), ctlBottom: Math.round(ctl.bottom),
             pageScrolls: document.documentElement.scrollHeight >
                          document.documentElement.clientHeight + 2 };
  });
  check(Math.abs(m.viewH - m.hostH) <= 2,
    `B: embedded fills its container (${m.viewH} vs ${m.hostH})`);
  check(m.ctlBottom <= m.hostBottom + 1,
    `C: transport stays inside the container (${m.ctlBottom} <= ${m.hostBottom})`);
  check(!m.pageScrolls, 'C: the host page does not scroll');
  await p.close();
}

// --- D + E: optional chrome ---
{
  const p = await open({ embedded: true, chrome: { back: false, nowPlaying: false } }, true);
  const back = await p.$$eval('#back-btn', (e) => e.filter((x) => x.offsetParent !== null).length);
  const np = await p.$$eval('.now-playing', (e) => e.filter((x) => x.offsetParent !== null).length);
  check(back === 0, 'D: chrome.back:false hides the back button');
  check(np === 0, 'D: chrome.nowPlaying:false hides the now-playing block');
  await p.close();
}
{
  const p = await open({}, false);
  const back = await p.$$eval('#back-btn', (e) => e.filter((x) => x.offsetParent !== null).length);
  const np = await p.$$eval('.now-playing', (e) => e.filter((x) => x.offsetParent !== null).length);
  check(back === 1, 'E: back button shown by default');
  check(np === 1, 'E: now-playing shown by default');
  await p.close();
}

// --- F: narrow viewports stack the panes ---
{
  const p = await open({}, false, { width: 390, height: 844 });
  const m = await p.evaluate(() => {
    const c = document.querySelector('.chapter-panel').getBoundingClientRect();
    const t = document.querySelector('.transcript-panel').getBoundingClientRect();
    return { chapterBottom: Math.round(c.bottom), transcriptTop: Math.round(t.top),
             transcriptWidth: Math.round(t.width), viewport: window.innerWidth };
  });
  check(m.transcriptTop >= m.chapterBottom - 2,
    `F: transcript sits below the chapter list (${m.transcriptTop} >= ${m.chapterBottom})`);
  check(m.transcriptWidth > m.viewport * 0.8,
    `F: transcript uses the full width (${m.transcriptWidth} of ${m.viewport})`);
  await p.close();
}

// --- F2: wide viewports keep the side-by-side split ---
{
  const p = await open({}, false, { width: 1200, height: 800 });
  const m = await p.evaluate(() => {
    const c = document.querySelector('.chapter-panel').getBoundingClientRect();
    const t = document.querySelector('.transcript-panel').getBoundingClientRect();
    return { sideBySide: t.left >= c.right - 2 };
  });
  check(m.sideBySide, 'F2: wide screens keep chapters and transcript side by side');
  await p.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
