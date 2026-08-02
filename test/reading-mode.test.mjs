// reading-mode.test.mjs — reading mode is for text.
//
// Run: node test/reading-mode.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// Reading mode already drops the chapter list, the transport and the
// now-playing block. The "Transcript" heading was still holding a slot in the
// one row that survives, crowding the controls that share it — and a heading
// naming the only thing on screen tells the reader nothing.
//
// The rule it has to obey: maximise text, keep the controls usable, and always
// leave a way out.
//
// Contract under test:
//   A. the "Transcript" heading is gone in reading mode
//   B. it comes back on the way out
//   C. the way out (#reading-btn) stays visible and works
//   D. playback stays reachable — the mini play button survives
//   E. the text size and follow controls survive
//   F. the transcript really does get taller
//   G. chapter navigation is reachable — without the chapter list there is no
//      other way to change chapter, so prev/next join the surviving row
//   H. a row above that one names the chapter being read, because the chapter
//      list that used to say so is gone
//   I. neither appears outside reading mode — the transport and the chapter
//      list already do both jobs there
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

const BOOKS = [{
  slug: 'b', book_id: 'b', title: 'Test Book', artist: '', duration: 240,
  chapters: Array.from({ length: 3 }, (_, i) => ({
    id: i, n: i + 1, title: `Chapter ${i + 1}`, filename: `c${i}.m4a`,
    start: i * 80, end: (i + 1) * 80, duration: 80, size: 1000,
  })),
}];

const TRANSCRIPT = { books: [{ slug: 'b', chapters: [{
  index: 1, title: 'Chapter 1', timing: 'chunks',
  chunks: Array.from({ length: 12 }, (_, i) => ({
    index: i, text: `Paragraph ${i + 1}. `.repeat(12), start: i * 6, end: (i + 1) * 6,
  })),
}] }] };

const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0}${playerCss}</style></head><body>
<div id="app"></div>
<script>${feedbackJs}</script>
<script>${playerJs}</script>
<script>RepoStoryPlayer.init({ container: document.getElementById('app'),
  books: ${JSON.stringify(BOOKS)}, audioBaseUrl: 'audio/',
  transcriptUrl: 'transcripts.json' });</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url.includes('transcripts.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(TRANSCRIPT));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const visible = (p, sel) => p.$$eval(sel, (e) => e.filter((x) => x.offsetParent !== null).length);

async function open() {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  p.on('pageerror', (e) => bad(`page error: ${e.message}`));
  await p.goto(origin + '/index.html');
  await p.waitForSelector('.book-item', { timeout: 5000 });
  await p.click('.book-item .title');
  await p.waitForSelector('#player-view.active', { timeout: 5000 });
  await p.waitForTimeout(400);
  return p;
}

{
  const p = await open();
  check(await visible(p, '.transcript-panel-header h3') === 1,
    'baseline: the "Transcript" heading is shown normally');
  check(await visible(p, '#reading-chapter') === 0,
    'I: no chapter row outside reading mode');
  check(await visible(p, '#mini-prev-btn') === 0 && await visible(p, '#mini-next-btn') === 0,
    'I: no mini chapter nav outside reading mode');
  const before = await p.$eval('#transcript-chunks', (e) => Math.round(e.getBoundingClientRect().height));

  await p.click('#reading-btn');
  await p.waitForTimeout(300);
  check(await p.$eval('#player-view', (e) => e.classList.contains('reading-mode')),
    'reading mode engaged');

  check(await visible(p, '.transcript-panel-header h3') === 0,
    'A: the "Transcript" heading is gone in reading mode');
  check(await visible(p, '#reading-btn') === 1, 'C: the way out is still on screen');
  check(await visible(p, '#mini-play-btn') === 1, 'D: playback stays reachable');
  check(await visible(p, '#ts-dec') === 1 && await visible(p, '#ts-inc') === 1,
    'E: text size controls survive');
  check(await visible(p, '#follow-btn') === 1, 'E: follow survives');

  const after = await p.$eval('#transcript-chunks', (e) => Math.round(e.getBoundingClientRect().height));
  check(after > before, `F: the transcript gets taller (${before} -> ${after})`);

  check(await visible(p, '#mini-prev-btn') === 1 && await visible(p, '#mini-next-btn') === 1,
    'G: chapter navigation is on the surviving row');
  check(await visible(p, '#reading-chapter') === 1, 'H: the chapter row is shown');
  const named = await p.$eval('#reading-chapter', (e) => e.textContent.trim());
  check(named === 'Chapter 1', `H: it names the current chapter ("${named}")`);
  // Above the controls, not below them: the reader's eye lands on the label
  // before the buttons that change it.
  const above = await p.evaluate(() => {
    const r = document.querySelector('#reading-chapter').getBoundingClientRect();
    const h = document.querySelector('.transcript-panel-header').getBoundingClientRect();
    return r.bottom <= h.top + 1;
  });
  check(above, 'H: the chapter row sits above the controls row');

  await p.click('#mini-next-btn');
  await p.waitForTimeout(200);
  const named2 = await p.$eval('#reading-chapter', (e) => e.textContent.trim());
  check(named2 === 'Chapter 2', `G: next chapter navigates and relabels ("${named2}")`);
  await p.click('#mini-prev-btn');
  await p.waitForTimeout(200);
  check(await p.$eval('#reading-chapter', (e) => e.textContent.trim()) === 'Chapter 1',
    'G: previous chapter navigates back');

  // The controls must not be crowded off the row by what is left.
  const row = await p.evaluate(() => {
    const h = document.querySelector('.transcript-panel-header').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.transcript-panel-header button')]
      .filter((b) => b.offsetParent !== null);
    return { overflowing: btns.filter((b) => b.getBoundingClientRect().right > h.right + 1).length,
             count: btns.length };
  });
  check(row.overflowing === 0,
    `A: all ${row.count} controls still fit the row (${row.overflowing} overflow)`);

  await p.click('#reading-btn');
  await p.waitForTimeout(300);
  check(!(await p.$eval('#player-view', (e) => e.classList.contains('reading-mode'))),
    'C: the way out works');
  check(await visible(p, '.transcript-panel-header h3') === 1,
    'B: the heading comes back on the way out');
  check(await visible(p, '#reading-chapter') === 0 && await visible(p, '#mini-prev-btn') === 0,
    'I: the chapter row and mini nav go away again');
  await p.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
