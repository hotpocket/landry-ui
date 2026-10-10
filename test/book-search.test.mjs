// book-search.test.mjs — searching inside the open book (docs/spec-book-search.md).
//
// Run: node test/book-search.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
// PW_ENGINE=webkit runs it in Safari's engine.
//
// Contract under test:
//   A. the box is on the book page; a query lists only the chapters that match,
//      in book order, each with its passage count and a marked snippet
//   B. under two characters lists nothing; matching ignores case
//   C. picking a chapter jumps to its first match: that chapter, playback at the
//      passage start, the passage on screen, the term marked, "k of N" shown
//   D. next and previous step through every match across chapters, and wrap
//   E. a paused player stays paused through a jump
//   F. close removes the bar and the marks, and leaves the text unchanged
//   G. typing a query fetches no audio
//   H. the box is hidden in reading mode
//   I. Enter jumps to the first match at or after the playback position

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const player = join(here, '../audiobook/player');
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright'));
const engine = pw[process.env.PW_ENGINE || 'chromium'];
const fixture = join(here, 'fixture/out');
if (!existsSync(join(fixture, 'audio/chapter_0001.m4a'))) execFileSync(join(here, 'fixture/gen.sh'));

// Ten passages of three seconds per chapter. The dragon appears in chapter 1
// passage 7, chapter 3 passages 2 and 8 (twice in 8), and never in chapter 2.
const filler = (c, i) => `Chapter ${c} passage ${i} talks about the weather and the road.`;
const text = (c, i) =>
  c === 1 && i === 7 ? 'A DRAGON landed on the roof.'
    : c === 3 && i === 2 ? 'The dragon slept all day.'
      : c === 3 && i === 8 ? 'Dragon after dragon flew past.'
        : filler(c, i);
const chapters = [1, 2, 3].map((n) => ({ n, id: n - 1, title: `Chapter ${n}: Title ${n}`, filename: `chapter_0001.m4a?c=${n}`, start: (n - 1) * 30, end: n * 30, duration: 30 }));
const books = [{ slug: 'b', title: 'B', duration: 90, chapters }];
const transcripts = { books: [{ slug: 'b', chapters: [1, 2, 3].map((n) => ({
  n, index: n, chunks: Array.from({ length: 10 }, (_, i) => ({ index: i, text: text(n, i), start: i * 3, end: i * 3 + 3 })),
})) }] };
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${readFileSync(join(player, 'player.css'))}</style><div id="mount"></div><script>${readFileSync(join(player, 'player.js'))}</script><script>RepoStoryPlayer.init({container:document.getElementById('mount'),books:${JSON.stringify(books)},transcriptUrl:'data:application/json;base64,${Buffer.from(JSON.stringify(transcripts)).toString('base64')}',audioBaseUrl:'/audio/'});</script>`;
let audioRequests = 0;
const server = createServer((req, res) => {
  if (req.url.startsWith('/audio/')) {
    audioRequests++;
    // Ranges, or the browser cannot seek.
    const buf = readFileSync(join(fixture, req.url.split('?')[0]));
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'content-length': buf.length }); res.end(buf); return; }
    const from = +m[1], to = m[2] ? +m[2] : buf.length - 1;
    res.writeHead(206, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${from}-${to}/${buf.length}`, 'content-length': to - from + 1 });
    res.end(buf.subarray(from, to + 1)); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const settle = (page) => page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n > 8 ? setTimeout(r, 700) : requestAnimationFrame(f)); f(); }));
const where = (page) => page.evaluate(() => {
  const a = document.querySelector('audio');
  const box = document.querySelector('#transcript-chunks');
  const marks = [...box.querySelectorAll('mark.bs-hit')];
  const cur = box.querySelector('mark.bs-hit.bs-current');
  const b = box.getBoundingClientRect(), r = cur?.getBoundingClientRect();
  return {
    chapter: document.querySelector('.chapter-list li.active, .chapter-list li.playing')?.textContent ?? '',
    src: a.src, t: a.currentTime, paused: a.paused,
    marks: marks.map((m) => m.textContent),
    currentChunk: cur?.closest('.transcript-chunk')?.id ?? null,
    currentInView: !!r && r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
    pos: document.querySelector('#book-search-pos')?.textContent ?? '',
    barShown: !!document.querySelector('#book-search-nav') && !document.querySelector('#book-search-nav').hidden,
  };
});
const rows = (page) => page.$$eval('#book-search-results .bs-row', (els) => els.map((e) => ({
  title: e.querySelector('.bs-row-title')?.textContent, count: e.querySelector('.bs-row-count')?.textContent,
  snippet: e.querySelector('.bs-row-snippet')?.textContent, marked: e.querySelector('.bs-row-snippet mark')?.textContent,
})));

const browser = await engine.launch();
let pass = 0;
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 860 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#/b`);
  await page.waitForSelector('.transcript-chunk');
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  await page.evaluate(() => document.querySelector('audio').pause());

  // G + A
  const before = audioRequests;
  assert.ok(await page.isVisible('#book-search-input'), 'A: the search box is on the book page');
  await page.fill('#book-search-input', 'dr');
  await page.fill('#book-search-input', 'dragon');
  await page.waitForSelector('#book-search-results .bs-row');
  const r = await rows(page);
  assert.deepEqual(r.map((x) => x.title), ['Chapter 1: Title 1', 'Chapter 3: Title 3'], 'A: only matching chapters, in order');
  assert.deepEqual(r.map((x) => x.count), ['1 match', '2 matches'], 'A: passage counts');
  assert.equal(r[0].marked, 'DRAGON', 'A: the term is marked in the snippet');
  pass++;
  assert.equal(audioRequests, before, 'G: typing fetches no audio'); pass++;

  // B
  await page.fill('#book-search-input', 'd');
  await settle(page);
  assert.equal((await rows(page)).length, 0, 'B: one character lists nothing');
  await page.fill('#book-search-input', 'DrAgOn');
  await page.waitForSelector('#book-search-results .bs-row');
  assert.equal((await rows(page)).length, 2, 'B: matching ignores case'); pass++;

  // C: pick chapter 3 — its first match is passage 2.
  await page.click('#book-search-results .bs-row:nth-child(2)');
  await page.waitForFunction(() => /c=3/.test(document.querySelector('audio').src));
  await settle(page);
  let w = await where(page);
  assert.ok(Math.abs(w.t - 6) < 0.3, `C: playback at the passage start (${w.t})`);
  assert.equal(w.currentChunk, 'tc-3-2', 'C: the current match is chapter 3 passage 2');
  assert.ok(w.currentInView, 'C: the matched passage is on screen');
  assert.deepEqual(w.marks, ['dragon', 'Dragon', 'dragon'], 'C: every occurrence in the chapter is marked');
  assert.equal(w.pos, '2 of 3', 'C: the bar says which match');
  assert.ok(await page.isHidden('#book-search-results'), 'C: the list closes on a pick');
  pass++;
  // E
  assert.equal(w.paused, true, 'E: a paused player stays paused'); pass++;

  // D: next → chapter 3 passage 8; next → wraps to chapter 1 passage 7; prev → back to 3/8.
  await page.click('#book-search-next'); await settle(page);
  w = await where(page);
  assert.equal(w.currentChunk, 'tc-3-8'); assert.equal(w.pos, '3 of 3'); assert.ok(Math.abs(w.t - 24) < 0.3, `D: t ${w.t}`);
  await page.click('#book-search-next');
  await page.waitForFunction(() => /c=1/.test(document.querySelector('audio').src)); await settle(page);
  w = await where(page);
  assert.equal(w.currentChunk, 'tc-1-7', 'D: next wraps to the first match'); assert.equal(w.pos, '1 of 3');
  assert.ok(w.currentInView, 'D: the wrapped-to passage is on screen');
  await page.click('#book-search-prev');
  await page.waitForFunction(() => /c=3/.test(document.querySelector('audio').src)); await settle(page);
  w = await where(page);
  assert.equal(w.currentChunk, 'tc-3-8', 'D: previous wraps to the last'); assert.equal(w.pos, '3 of 3');
  pass++;

  // F
  await page.click('#book-search-close'); await settle(page);
  w = await where(page);
  assert.equal(w.barShown, false, 'F: the bar is gone');
  assert.deepEqual(w.marks, [], 'F: the marks are gone');
  assert.equal(await page.inputValue('#book-search-input'), '', 'F: the box is emptied');
  const texts = await page.$$eval('#transcript-chunks .chunk-text', (els) => els.map((e) => e.textContent));
  assert.deepEqual(texts, transcripts.books[0].chapters[2].chunks.map((c) => c.text), 'F: transcript text unchanged');
  pass++;

  // I: from chapter 3 at 0s, Enter goes to 3/2 (the first at or after the position).
  await page.evaluate(() => { document.querySelector('audio').currentTime = 0; }); await settle(page);
  await page.fill('#book-search-input', 'dragon');
  await page.press('#book-search-input', 'Enter'); await settle(page);
  w = await where(page);
  assert.equal(w.currentChunk, 'tc-3-2', 'I: Enter takes the next match from where playback is'); assert.equal(w.pos, '2 of 3');
  pass++;

  // H
  await page.click('#reading-btn');
  assert.ok(await page.isHidden('#book-search-input'), 'H: hidden in reading mode'); pass++;

  assert.deepEqual(errors, []);
  console.log(`${pass} passed, 0 failed`);
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
