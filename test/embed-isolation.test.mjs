// embed-isolation.test.mjs — player.css stops at the player.
//
// Run: node test/embed-isolation.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// player.css is a committed artifact loaded by host pages, and its first two
// lines were `* { margin:0; padding:0; box-sizing:border-box }` and a `body`
// rule setting font, background, colour and min-height. A host that wanted the
// player as a COMPONENT — which is what init({embedded:true}) and
// .player-embedded-host exist for — got its entire page restyled by including
// the stylesheet.
//
// The reset still has to apply inside the player: it is doing real work there
// (the chapter list is a <ul>, and the UA gives it 40px of padding). So the fix
// is scope, not deletion — and the player has to stop borrowing the host's
// `body` for its own background and text colour, because after scoping there is
// nothing to borrow. That is why .rs-player carries them now.
//
// Standalone keeps every bit of its old behaviour by being the DEFAULT: the
// body rule applies unless the page carries .rs-embedded-page, which init()
// adds only when the host asked to embed. Stated as the negative so the shell
// is styled by the stylesheet alone and never waits on a script — see case F.
// No consumer changes: karagame, chatterbook and books all get the mode they
// already had.
//
// Contract under test:
//   A. embedded, the host page keeps its own margins and padding
//   B. embedded, the host page keeps its own background
//   C. the reset still applies INSIDE the player, in both modes
//   D. the player carries its own background and text colour, so it is legible
//      on a light host rather than depending on having darkened the page
//   E. standalone is unchanged: the body rule still applies, in full
//   F. a host can opt out from the very first paint, with no JavaScript — the
//      class init() sets is one it can set itself. This is the guarantee the
//      JS path cannot give: init() runs a script-execution after the stylesheet
//      and a paint can land in between

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

// A host page that has opinions of its own: a light background, a heading and a
// list carrying the UA's default margins and padding. Everything the old
// stylesheet flattened.
// Deliberately sets NO background of its own: a host that declares one would
// win the cascade anyway and the assertion would pass without the fix.
const HOST = `<!doctype html>
<html><head>
<link rel="stylesheet" href="/audiobook/vanilla/player.css">
</head><body>
<h1 id="host-heading">Host heading</h1>
<ul id="host-list"><li>Host item</li></ul>
<div id="app"></div>
<script src="/audiobook/vanilla/player.js"></script>
</body></html>`;

// The same page, opting out in its own markup — no init(), no JavaScript.
const HOST_OPTOUT = HOST.replace('<body>', '<body class="rs-embedded-page">');

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/host.html' || path === '/host-optout.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(path === '/host.html' ? HOST : HOST_OPTOUT);
    return;
  }
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

const BOOKS = [{
  slug: 'alpha', title: 'Alpha', duration: 8,
  chapters: [
    { id: 0, n: 1, title: 'Ch 1', filename: 'chapter_0001.m4a', start: 0, end: 4, duration: 4, size: 1 },
    { id: 1, n: 2, title: 'Ch 2', filename: 'chapter_0002.m4a', start: 4, end: 8, duration: 4, size: 1 },
  ],
}];

async function boot(embedded, url = '/host.html') {
  await page.goto(`${origin}${url}`);
  if (url !== '/host.html') await page.evaluate(() => { document.body.innerHTML = '<div id="app"></div>'; });
  await page.evaluate(({ books, embedded }) => {
    location.hash = '';
    window.RepoStoryPlayer.init({
      container: document.getElementById('app'),
      books, audioBaseUrl: 'audio/', autoOpenLast: false, title: 'Lib', embedded,
    });
  }, { books: BOOKS, embedded });
  await page.waitForSelector('#book-list .book-item');
}

const css = (sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el)[p], prop);

// --- embedded: the host page is left alone ----------------------------------
await boot(true);

const h1Margin = await css('#host-heading', 'marginTop');
check(h1Margin !== '0px', `A: the host's own heading keeps its margin (${h1Margin})`);
const hostListPad = await css('#host-list', 'paddingLeft');
check(hostListPad !== '0px', `A: the host's own list keeps its padding (${hostListPad})`);

const hostBg = await css('body', 'backgroundColor');
check(hostBg !== 'rgb(15, 15, 15)', `B: the player does not darken the host's page (${hostBg})`);

// --- embedded: the player still gets its reset and its own palette ----------
await page.click('#book-list .book-item .book-open');
await page.waitForSelector('#player-view.active');

const chapterPad = await css('#chapter-list', 'paddingLeft');
check(chapterPad === '0px', `C: the reset still applies inside the player (${chapterPad})`);

const playerBg = await css('#app', 'backgroundColor');
check(playerBg === 'rgb(15, 15, 15)',
      `D: the player paints its own background rather than the host's (${playerBg})`);
const playerColor = await css('#book-title', 'color');
check(playerColor === 'rgb(224, 224, 224)',
      `D: and its own text colour, so it is legible on a light host (${playerColor})`);

// --- standalone: nothing changed --------------------------------------------
// The shell page, not the host page: standalone IS the shell, and a host that
// declares its own background would decide the assertion instead of the fix.
await boot(false, '/');

const bodyBg = await css('body', 'backgroundColor');
check(bodyBg === 'rgb(15, 15, 15)', `E: standalone still darkens the page (${bodyBg})`);
const bodyColor = await css('body', 'color');
check(bodyColor === 'rgb(224, 224, 224)', `E: and still sets the page text colour (${bodyColor})`);
const bodyMinH = await css('body', 'minHeight');
check(bodyMinH !== '0px' && bodyMinH !== 'auto', `E: and still claims the viewport (${bodyMinH})`);
// The old global `*` matched <body> too, so scoping the reset handed the UA's
// 8px body margin back and shifted the whole standalone shell down. Caught by
// screenshotting before against after, not by any assertion above.
const bodyMargin = await css('body', 'margin');
check(bodyMargin === '0px', `E: and still has no page margin of its own (${bodyMargin})`);

await page.click('#book-list .book-item .book-open');
await page.waitForSelector('#player-view.active');
const chapterPad2 = await css('#chapter-list', 'paddingLeft');
check(chapterPad2 === '0px', `C: the reset applies standalone too (${chapterPad2})`);

// --- F: the static opt-out, before any script has run -----------------------
await page.goto(`${origin}/host-optout.html`);
const staticBg = await css('body', 'backgroundColor');
check(staticBg !== 'rgb(15, 15, 15)',
      `F: a host marking its own body is not styled without init() (${staticBg})`);
const staticMargin = await css('#host-heading', 'marginTop');
check(staticMargin !== '0px', `F: and keeps its margins too (${staticMargin})`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
