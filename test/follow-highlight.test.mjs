// follow-highlight.test.mjs — the sentence being read is marked, and Follow keeps
// THAT sentence on screen.
//
// Run: node test/follow-highlight.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
// PW_ENGINE=webkit runs it in Safari's engine (PLAYWRIGHT_BROWSERS_PATH at
// ~/.cache/iphone-webkit, PLAYWRIGHT_LIB at a playwright that matches it).
//
// Brandon, 2026-10-10, on a phone: "I still don't see the text that's being
// read on narrow screens" — the voice app marks the phrase being spoken and he
// wanted the same here, to draw the eye and to give Follow something exact to
// keep in view. Transcripts time paragraphs, not sentences, so the sentence is
// placed by how far through the paragraph the audio is, by characters: the
// narration voice reads at an even pace.
//
// Contract under test:
//   A. exactly one sentence is marked, inside the active passage, and it is the
//      one at the same fraction of the passage's text as playback is of its time
//   B. with Follow on, the marked sentence is fully inside the transcript pane,
//      early, midway and late in a passage taller than the pane
//   C. with Follow off, the mark still moves but the pane does not
//   D. a new passage takes the mark; the previous one keeps none
//   E. the passage's text is unchanged by the marking (search and copy read it)

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

// Twelve sentences of uneven length, so a sentence index cannot be guessed from
// a time fraction without counting characters.
const sentences = Array.from({ length: 12 }, (_, i) =>
  `Sentence ${i + 1} ${'runs on and on '.repeat(3 + (i * 5) % 9)}until it stops.`);
const long = sentences.join(' ');
const chunks = [
  { index: 0, text: long, start: 0, end: 20 },
  { index: 1, text: 'The second passage begins here. It is short.', start: 20, end: 30 },
];
const books = [{ slug: 'b', title: 'B', duration: 30, chapters: [{ n: 1, id: 0, title: 'Chapter 1', filename: 'chapter_0001.m4a', start: 0, end: 30, duration: 30 }] }];
const transcripts = { books: [{ slug: 'b', chapters: [{ n: 1, index: 1, chunks }] }] };
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${readFileSync(join(player, 'player.css'))}</style><div id="mount"></div><script>${readFileSync(join(player, 'player.js'))}</script><script>RepoStoryPlayer.init({container:document.getElementById('mount'),books:${JSON.stringify(books)},transcriptUrl:'data:application/json;base64,${Buffer.from(JSON.stringify(transcripts)).toString('base64')}',audioBaseUrl:'/audio/'});</script>`;
const server = createServer((req, res) => {
  if (req.url.startsWith('/audio/')) {
    // Ranges, or the browser cannot seek: without them currentTime snaps to 0.
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

// The sentence whose middle character sits at fraction f of the passage: the
// time to seek to so that sentence k is unambiguously the one being read.
const starts = []; { let p = 0; for (const s of sentences) { starts.push(p); p += s.length + 1; } }
const timeFor = (k) => 20 * (starts[k] + sentences[k].length / 2) / long.length;

const seek = async (page, t) => {
  await page.evaluate((t) => { const a = document.querySelector('audio'); a.pause(); a.currentTime = t; }, t);
  await page.waitForFunction((t) => Math.abs(document.querySelector('audio').currentTime - t) < 0.05, t);
  // The engine follows on animation frames; give it several.
  await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n > 6 ? r() : requestAnimationFrame(f)); f(); }));
  await new Promise((r) => setTimeout(r, 700));  // outlast a smooth scroll
};
const state = (page) => page.evaluate(() => {
  const box = document.querySelector('#transcript-chunks');
  const marks = [...box.querySelectorAll('.speaking')];
  const m = marks[0];
  const b = box.getBoundingClientRect(), r = m?.getBoundingClientRect();
  return {
    count: marks.length,
    text: m?.textContent.trim(),
    inActive: !!m?.closest('.transcript-chunk.active'),
    chunk: m?.closest('.transcript-chunk')?.id,
    inPane: !!r && r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
    scrollTop: box.scrollTop,
    chunkTexts: [...box.querySelectorAll('.chunk-text')].map((e) => e.textContent),
  };
});

const browser = await engine.launch();
let pass = 0;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#/b`);
  await page.waitForSelector('.transcript-chunk');
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  await page.click('#follow-btn').catch(() => {});
  if (!(await page.evaluate(() => document.querySelector('#follow-btn').classList.contains('on')))) await page.click('#follow-btn');

  const tall = await page.evaluate(() => {
    const c = document.querySelector('.transcript-chunk'), b = document.querySelector('#transcript-chunks');
    return c.getBoundingClientRect().height > b.clientHeight;
  });
  assert.ok(tall, 'fixture: the long passage is taller than the pane at 390px'); pass++;

  for (const k of [0, 5, 11]) {
    await seek(page, timeFor(k));
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `highlight-k${k}.png`) });
    const s = await state(page);
    assert.equal(s.count, 1, `A k=${k}: one sentence marked (${s.count})`);
    assert.ok(s.inActive, `A k=${k}: the mark is inside the active passage`);
    assert.equal(s.text, sentences[k], `A k=${k}: the marked sentence is the one being read`);
    assert.ok(s.inPane, `B k=${k}: Follow keeps the marked sentence on screen`);
    pass++;
  }

  const e = await state(page);
  assert.deepEqual(e.chunkTexts, chunks.map((c) => c.text), 'E: passage text unchanged by the marking'); pass++;

  // C: Follow off, by turning the toggle off, then the mark moves and the pane stays.
  await seek(page, timeFor(0));
  await page.click('#follow-btn');
  assert.equal(await page.evaluate(() => document.querySelector('#follow-btn').classList.contains('on')), false, 'C: follow is off');
  const before = (await state(page)).scrollTop;
  await seek(page, timeFor(11));
  const off = await state(page);
  assert.equal(off.text, sentences[11], 'C: the mark still moves with Follow off');
  assert.equal(off.scrollTop, before, 'C: the pane does not move with Follow off'); pass++;

  // D: the next passage takes the mark.
  await page.click('#follow-btn');
  await seek(page, 22);
  const d = await state(page);
  assert.equal(d.count, 1, 'D: one mark after crossing into the next passage');
  assert.equal(d.chunk, 'tc-1-1', 'D: the mark is in the new passage');
  assert.equal(d.text, 'The second passage begins here.', 'D: on its first sentence'); pass++;

  assert.deepEqual(errors, []);
  console.log(`${pass} passed, 0 failed`);
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
