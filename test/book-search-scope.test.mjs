// book-search-scope.test.mjs — how far a book search reaches, and in what
// order (docs/spec-book-search.md; Brandon, 2026-10-20).
//
// Run: node test/book-search-scope.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// Contract under test:
//   S1. three scopes while a chapter is loaded — This chapter, This book, All
//       books — and This book is chosen to start with
//   S2. results put the playing chapter first, labelled "Now playing", then the
//       book's other chapters in book order
//   S3. This chapter lists only the playing chapter, and the choice holds while
//       the query changes
//   S4. All books adds other books after this one, each row naming its book;
//       their transcripts load on demand
//   S5. Enter starts in the playing chapter; next/previous follow the list's
//       order and wrap
//   S6. a row in another book opens that book at the match, the bar survives
//       the switch, and stepping crosses back
//   S7. "Now playing: <chapter>" sits above where the results drop, so it stays
//       readable while they cover the chapter list; it follows a cross-book
//       jump; it is hidden in reading mode, and where the player's own header
//       already names the chapter
//   S8. reopening the list after a pick re-orders it from where playback is,
//       and the bar's "k of N" follows the re-order
//   S9. a book whose transcript lands after a pick still joins an open list
//   S10. another book is searched in the mode it will open in: a reader in
//       summary mode lands in the summary track at the summary passage
//   S11. a transcript the library search is already fetching still reaches the
//       book search when it lands (one shared loader, two listeners)

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

// Two books of three chapters, ten three-second passages each. "dragon":
// Alpha ch1 p7, ch2 p1, ch3 p4; Beta ch2 p5.
const DRAGONS = { a: { 1: [7], 2: [1], 3: [4] }, b: { 2: [5] } };
const text = (s, c, i) => (DRAGONS[s][c] ?? []).includes(i)
  ? `A dragon in ${s} ${c}.${i}.` : `Book ${s} chapter ${c} passage ${i}, the road.`;
const NAMES = { a: 'Alpha', b: 'Beta' };
// Beta also has summaries; its chapter 2 summary mentions the dragon in its
// second passage (3-6 s on the summary clock).
const book = (s) => ({
  slug: s, title: NAMES[s], duration: 90,
  transcriptUrl: `/t/${s}.json`,
  chapters: [1, 2, 3].map((n) => ({ n, id: n - 1, title: `Chapter ${n}: ${NAMES[s]} ${n}`,
    filename: `chapter_0001.m4a?b=${s}&c=${n}`, start: (n - 1) * 30, end: n * 30, duration: 30,
    ...(s === 'b' ? { summary: { filename: `chapter_0001.summary.m4a?b=${s}&c=${n}`, duration: 6, size: 1 } } : {}) })),
});
const transcript = (s) => ({ slug: s, chapters: [1, 2, 3].map((n) => ({
  n, index: n, chunks: Array.from({ length: 10 }, (_, i) => ({ index: i, text: text(s, n, i), start: i * 3, end: i * 3 + 3 })),
  ...(s === 'b' ? { summary_chunks: [0, 1].map((i) => ({ index: i, start: i * 3, end: i * 3 + 3,
    text: n === 2 && i === 1 ? 'In short, a dragon came.' : `Summary of b ${n}.${i}.` })) } : {}),
})) });
let slowB = 0;
const page = (chrome) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${readFileSync(join(player, 'player.css'))}</style><div id="mount"></div><script>${readFileSync(join(player, 'player.js'))}</script><script>RepoStoryPlayer.init({container:document.getElementById('mount'),books:${JSON.stringify([book('a'), book('b')])},audioBaseUrl:'/audio/',chrome:${JSON.stringify(chrome)}});</script>`;
const fetched = [];
const server = createServer((req, res) => {
  if (req.url.startsWith('/t/')) {
    const s = req.url.slice(3, 4); fetched.push(s);
    if (s === 'b' && slowB) { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ books: [transcript(s)] })); }, slowB); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ books: [transcript(s)] })); return;
  }
  if (req.url.startsWith('/audio/')) {
    const buf = readFileSync(join(fixture, req.url.split('?')[0]));
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'content-length': buf.length }); res.end(buf); return; }
    const from = +m[1], to = m[2] ? +m[2] : buf.length - 1;
    res.writeHead(206, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${from}-${to}/${buf.length}`, 'content-length': to - from + 1 });
    res.end(buf.subarray(from, to + 1)); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page(req.url.startsWith('/header') ? {} : { nowPlaying: false }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const settle = (p) => p.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n > 8 ? setTimeout(r, 700) : requestAnimationFrame(f)); f(); }));
const rows = (p) => p.$$eval('#book-search-results .bs-row', (els) => els.map((e) => ({
  title: e.querySelector('.bs-row-title')?.textContent ?? '',
  book: e.querySelector('.bs-row-book')?.textContent ?? '',
  now: !!e.querySelector('.bs-row-now'),
})));
const scopes = (p) => p.$$eval('#book-search-scope input[type=radio]', (els) => els
  .filter((e) => e.offsetParent !== null).map((e) => ({ value: e.value, checked: e.checked, label: e.closest('label')?.textContent?.trim() })));
const where = (p) => p.evaluate(() => {
  const cur = document.querySelector('#transcript-chunks mark.bs-hit.bs-current');
  return {
    src: document.querySelector('audio').src, t: document.querySelector('audio').currentTime,
    pos: document.querySelector('#book-search-pos')?.textContent ?? '',
    current: cur?.closest('.transcript-chunk')?.id ?? null,
    barShown: !document.querySelector('#book-search-nav').hidden,
  };
});
const typeQuery = async (p, q) => { await p.fill('#book-search-input', q); await settle(p); };

const browser = await engine.launch();
let pass = 0;
try {
  const p = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/#/a/2`);
  await p.waitForSelector('.transcript-chunk');
  await p.waitForFunction(() => /c=2/.test(document.querySelector('audio')?.src ?? ''));
  await p.evaluate(() => { const a = document.querySelector('audio'); a.pause(); a.currentTime = 0; });
  await settle(p);

  // S1
  await typeQuery(p, 'dragon');
  await p.waitForSelector('#book-search-results .bs-row');
  assert.deepEqual((await scopes(p)).map((s) => [s.value, s.label, s.checked]),
    [['chapter', 'This chapter', false], ['book', 'This book', true], ['all', 'All books', false]],
    'S1: three scopes, This book chosen'); pass++;

  // S2
  let r = await rows(p);
  assert.deepEqual(r.map((x) => x.title), ['Chapter 2: Alpha 2', 'Chapter 1: Alpha 1', 'Chapter 3: Alpha 3'],
    'S2: the playing chapter first, then the rest in book order');
  assert.deepEqual(r.map((x) => x.now), [true, false, false], 'S2: the playing chapter is labelled'); pass++;

  // S7 (while the list covers the chapters)
  const np = await p.evaluate(() => {
    const n = document.querySelector('#book-search-now');
    const res = document.querySelector('#book-search-results').getBoundingClientRect();
    const r = n?.getBoundingClientRect();
    return { text: n?.textContent ?? '', visible: !!n && n.offsetParent !== null && r.height > 0, above: !!r && r.bottom <= res.top + 1 };
  });
  assert.equal(np.text, 'Now playing: Chapter 2: Alpha 2', 'S7: names the playing chapter');
  assert.ok(np.visible && np.above, `S7: readable above the open results (${JSON.stringify(np)})`); pass++;

  // S3
  await p.check('#book-search-scope input[value=chapter]'); await settle(p);
  assert.deepEqual((await rows(p)).map((x) => x.title), ['Chapter 2: Alpha 2'], 'S3: only the playing chapter');
  await typeQuery(p, 'drago');
  assert.equal((await scopes(p)).find((s) => s.checked)?.value, 'chapter', 'S3: the scope holds while typing');
  assert.deepEqual((await rows(p)).map((x) => x.title), ['Chapter 2: Alpha 2']); pass++;

  // S4
  assert.ok(!fetched.includes('b'), 'S4: no other book is fetched before All books');
  await p.check('#book-search-scope input[value=all]');
  await p.waitForFunction(() => document.querySelectorAll('#book-search-results .bs-row').length === 4);
  r = await rows(p);
  assert.deepEqual(r.map((x) => x.title), ['Chapter 2: Alpha 2', 'Chapter 1: Alpha 1', 'Chapter 3: Alpha 3', 'Chapter 2: Beta 2'],
    'S4: other books after this one');
  assert.deepEqual(r.map((x) => x.book), ['', '', '', 'Beta'], 'S4: an other-book row names its book');
  assert.ok(fetched.includes('b'), 'S4: Beta loaded on demand'); pass++;

  // S5 (This book)
  await p.check('#book-search-scope input[value=book]'); await settle(p);
  await p.press('#book-search-input', 'Enter'); await settle(p);
  let w = await where(p);
  assert.equal(w.current, 'tc-2-1', 'S5: Enter starts in the playing chapter'); assert.equal(w.pos, '1 of 3');
  await p.click('#book-search-next'); await p.waitForFunction(() => /c=1/.test(document.querySelector('audio').src)); await settle(p);
  w = await where(p); assert.equal(w.current, 'tc-1-7', 'S5: next follows the list order'); assert.equal(w.pos, '2 of 3');
  await p.click('#book-search-next'); await p.waitForFunction(() => /c=3/.test(document.querySelector('audio').src)); await settle(p);
  w = await where(p); assert.equal(w.current, 'tc-3-4'); assert.equal(w.pos, '3 of 3');
  await p.click('#book-search-next'); await p.waitForFunction(() => /c=2/.test(document.querySelector('audio').src)); await settle(p);
  w = await where(p); assert.equal(w.current, 'tc-2-1', 'S5: wraps to the first'); pass++;

  // S6 (All books): pick the Beta row.
  await p.focus('#book-search-input'); await settle(p);
  await p.check('#book-search-scope input[value=all]');
  await p.waitForFunction(() => document.querySelectorAll('#book-search-results:not([hidden]) .bs-row').length === 4);
  await p.click('#book-search-results .bs-row:nth-child(4)');
  await p.waitForFunction(() => /b=b&c=2/.test(document.querySelector('audio').src)); await settle(p);
  w = await where(p);
  assert.ok(Math.abs(w.t - 15) < 0.3, `S6: Beta at the passage start (${w.t})`);
  assert.equal(w.current, 'tc-2-5', 'S6: the match is marked in Beta');
  assert.ok(w.barShown, 'S6: the bar survives opening another book'); assert.equal(w.pos, '4 of 4');
  assert.equal(await p.textContent('#book-search-now'), 'Now playing: Chapter 2: Beta 2', 'S7: follows a cross-book jump');
  pass++;

  // S8: reopen the list in Beta — Beta is now playing and lists first.
  await p.focus('#book-search-input'); await settle(p);
  assert.equal((await rows(p))[0].title, 'Chapter 2: Beta 2', 'S8: re-ordered from where playback is');
  assert.equal((await where(p)).pos, '1 of 4', 'S8: the counter follows the re-order');
  await p.mouse.click(5, 880); await settle(p);
  await p.click('#book-search-next');
  await p.waitForFunction(() => /b=a&c=1/.test(document.querySelector('audio').src)); await settle(p);
  w = await where(p); assert.equal(w.pos, '2 of 4', 'S8: next steps into Alpha'); assert.equal(w.current, 'tc-1-7');
  pass++;

  // S7: reading mode, and a header that already names the chapter.
  await p.click('#reading-btn');
  assert.ok(await p.isHidden('#book-search-now'), 'S7: hidden in reading mode');
  const h = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await h.goto(`${base}/header#/a/2`); await h.waitForSelector('.transcript-chunk'); await settle(h);
  assert.ok(await h.isHidden('#book-search-now'), 'S7: hidden where the header names the chapter');
  pass++;

  // S9: Beta's transcript is slow; a match is picked before it lands, and the
  // list is reopened — Beta must still join it.
  slowB = 1500;
  const q = await browser.newPage({ viewport: { width: 900, height: 900 } });
  q.on('pageerror', (e) => errors.push(e.message));
  await q.goto(`${base}/#/a/2`); await q.waitForSelector('.transcript-chunk');
  await q.waitForFunction(() => /c=2/.test(document.querySelector('audio')?.src ?? ''));
  await q.evaluate(() => { const a = document.querySelector('audio'); a.pause(); a.currentTime = 0; });
  await typeQuery(q, 'dragon');
  await q.check('#book-search-scope input[value=all]');
  await q.press('#book-search-input', 'Enter');
  await q.evaluate(() => document.activeElement?.blur());
  await q.focus('#book-search-input');
  await q.waitForFunction(() => document.querySelectorAll('#book-search-results:not([hidden]) .bs-row').length === 4, null, { timeout: 5000 });
  assert.equal((await rows(q))[3].book, 'Beta', 'S9: the late book joins the open list');
  assert.equal((await where(q)).pos, '1 of 4', 'S9: the picked match keeps its place');
  slowB = 0; pass++;

  // S11: the library search starts Beta's (slow) fetch; Alpha is opened and
  // All books chosen while it is still in flight.
  slowB = 1500;
  const lib = await browser.newPage({ viewport: { width: 900, height: 900 } });
  lib.on('pageerror', (e) => errors.push(e.message));
  await lib.goto(`${base}/`); await lib.waitForSelector('#search-input');
  await lib.fill('#search-input', 'dragon');
  await lib.waitForFunction(() => document.querySelectorAll('.book-item').length >= 1);
  await lib.evaluate(() => { location.hash = '#/a/2'; });
  await lib.waitForSelector('.transcript-chunk');
  await lib.evaluate(() => document.querySelector('audio')?.pause());
  await typeQuery(lib, 'dragon');
  await lib.check('#book-search-scope input[value=all]');
  await lib.waitForFunction(() => document.querySelectorAll('#book-search-results:not([hidden]) .bs-row').length === 4, null, { timeout: 5000 });
  slowB = 0; pass++;

  // S10: a reader in summary mode; Alpha has no summaries, Beta opens in summary.
  const sm = await browser.newPage({ viewport: { width: 900, height: 900 } });
  sm.on('pageerror', (e) => errors.push(e.message));
  await sm.addInitScript(() => { try { localStorage.setItem('rs-summary', '1'); } catch { /* */ } });
  await sm.goto(`${base}/#/a/2`); await sm.waitForSelector('.transcript-chunk');
  await sm.waitForFunction(() => /c=2/.test(document.querySelector('audio')?.src ?? ''));
  await sm.evaluate(() => { const a = document.querySelector('audio'); a.pause(); a.currentTime = 0; });
  await typeQuery(sm, 'dragon');
  await sm.check('#book-search-scope input[value=all]');
  await sm.waitForFunction(() => [...document.querySelectorAll('#book-search-results .bs-row-book')].length === 1);
  const beta = (await rows(sm)).find((x) => x.book === 'Beta');
  assert.equal(beta.title, 'Chapter 2: Beta 2', 'S10: Beta is listed');
  assert.equal(await sm.textContent('#book-search-results .bs-row:last-child .bs-row-snippet'), 'In short, a dragon came.',
    'S10: from the summary, which is what Beta opens in');
  await sm.click('#book-search-results .bs-row:last-child');
  await sm.waitForFunction(() => /summary\.m4a\?b=b&c=2/.test(document.querySelector('audio').src)); await settle(sm);
  w = await where(sm);
  assert.ok(Math.abs(w.t - 3) < 0.3, `S10: at the summary passage (${w.t})`);
  assert.equal(w.current, 'tc-2-1', 'S10: the summary passage is marked');
  pass++;

  assert.deepEqual(errors, []);
  console.log(`${pass} passed, 0 failed`);
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
