// library-search-reinit.test.mjs — a re-init during a LIBRARY search
// (release review, 2026-10-20; the same class as book search's dispose fix).
//
// Run: node test/library-search-reinit.test.mjs
// Each init gets its own transcript URL (?g=): the browser holds a second
// request for a URL already in flight, which would make the two instances'
// fetches land together and hide the race.
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// A host that re-renders constructs another engine into the same container,
// and Preact reuses the DOM nodes. The old engine's library search kept its
// listeners and its transcript callback, so a fetch landing after the re-init
// painted the OLD search's results into the new list — rows whose clicks went
// to the disposed engine: the hash changed and no book opened.
//
// Contract under test:
//   L1. a transcript landing after a re-init does not paint the old search's
//       results into the new instance's list
//   L2. no row the old instance rendered survives into the new one
//   L3. in the new instance, a search result opens its book
//   L4. listeners on the search box do not pile up across re-inits

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

const NAMES = { a: 'Alpha', b: 'Beta' };
const book = (s) => ({
  slug: s, title: NAMES[s], duration: 30, transcriptUrl: `/t/${s}.json`,
  chapters: [{ n: 1, id: 0, title: `Chapter 1: ${NAMES[s]}`, filename: `chapter_0001.m4a?b=${s}`, start: 0, end: 30, duration: 30 }],
});
const transcript = (s) => ({ books: [{ slug: s, chapters: [{ n: 1, index: 1,
  chunks: Array.from({ length: 10 }, (_, i) => ({ index: i, start: i * 3, end: i * 3 + 3,
    text: i === 4 ? `A dragon in ${s}.` : `Book ${s} passage ${i}.` })) }] }] });
const page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${readFileSync(join(player, 'player.css'))}</style><div id="mount"></div><script>${readFileSync(join(player, 'player.js'))}</script><script>window.__opts=(g=1)=>({container:document.getElementById('mount'),books:${JSON.stringify([book('a'), book('b')])}.map((b)=>({...b,transcriptUrl:b.transcriptUrl+'?g='+g})),audioBaseUrl:'/audio/',autoOpenLast:false});RepoStoryPlayer.init(window.__opts());</script>`;
let slowB = 0;   // delays the NEXT Beta fetch only: the old instance's
const server = createServer((req, res) => {
  if (req.url.startsWith('/t/')) {
    const s = req.url.slice(3, 4);
    const send = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(transcript(s))); };
    if (s === 'b' && slowB) { const d = slowB; slowB = 0; setTimeout(send, d); } else send();
    return;
  }
  if (req.url.startsWith('/audio/')) {
    const buf = readFileSync(join(fixture, req.url.split('?')[0]));
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'content-length': buf.length }); res.end(buf); return; }
    const from = +m[1], to = m[2] ? +m[2] : buf.length - 1;
    res.writeHead(206, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${from}-${to}/${buf.length}`, 'content-length': to - from + 1 });
    res.end(buf.subarray(from, to + 1)); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await engine.launch();
let pass = 0;
try {
  const p = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  // Count live input listeners on the search box, honouring abort.
  await p.addInitScript(() => {
    window.__inp = 0;
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opt) {
      if (this.id === 'search-input' && type === 'input') {
        window.__inp++;
        opt?.signal?.addEventListener('abort', () => { window.__inp--; });
      }
      return add.call(this, type, fn, opt);
    };
  });
  await p.goto(`${base}/`);
  await p.waitForSelector('#search-input');

  slowB = 1500;
  await p.fill('#search-input', 'dragon');
  await p.waitForSelector('.search-hit');                 // Alpha's answer; Beta in flight
  const before = await p.evaluate(() => window.__inp);
  await p.evaluate(() => { window.__oldHit = document.querySelector('.search-hit'); RepoStoryPlayer.init(window.__opts(2)); });
  await p.waitForSelector('#search-input');
  // The new instance searches too, and its own Beta fetch is fast; the old
  // instance's slow one lands afterwards.
  await p.fill('#search-input', 'dragon');
  await p.waitForFunction(() => document.querySelectorAll('.search-group[data-book="b"] .search-hit').length === 1);
  await p.evaluate(() => { window.__newHit = document.querySelector('.search-group[data-book="b"] .search-hit'); });
  await new Promise((r) => setTimeout(r, 2200));          // the old instance's Beta lands
  // Re-painting replaces every row, so the new instance's own row is still
  // there only if the old instance painted nothing.
  assert.ok(await p.evaluate(() => document.contains(window.__newHit)), 'L1: the old instance painted nothing over the new list');
  assert.ok(!(await p.evaluate(() => document.contains(window.__oldHit))), 'L2: no row of the old instance survives'); pass++;
  await p.click('.search-group[data-book="b"] .search-hit');
  await p.waitForFunction(() => /b=b/.test(document.querySelector('audio')?.src ?? ''), null, { timeout: 5000 });
  await p.waitForSelector('.player-view.active .transcript-chunk');
  pass++;                                                  // L1 + L3: the row on screen is the live one

  assert.ok(await p.evaluate(() => window.__inp) <= before, 'L4: search box listeners do not pile up'); pass++;

  assert.deepEqual(errors, []);
  console.log(`${pass} passed, 0 failed`);
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
