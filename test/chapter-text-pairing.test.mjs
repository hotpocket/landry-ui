// chapter-text-pairing.test.mjs — the words shown are this chapter's words.
//
// Run: node test/chapter-text-pairing.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// A FEATURE suite: it loads the Preact build from audiobook/player directly.
//
// THE DEFECT. A book's chapter list and its transcript are two lists built by
// two programs from two different membership rules:
//
//   chatterbook/manifest.py        in when it has an M4A and a title
//   site/build_transcripts.py      in when it has a WAV, an N.txt and a title
//
// The renderer for The Diary of a CEO transcribes and then encodes, so a
// chapter with a WAV and no M4A yet is an ordinary state of that tree — and it
// is in the transcript and not in the manifest. Pair the two by POSITION and
// every chapter after the gap is shown the previous chapter's text. No error,
// no warning; it simply reads as a book whose words have come unstuck from its
// voice, and it lasts exactly as long as the gap does.
//
// Same class as the stale audio this suite's sibling covers: an artifact
// addressed by something that is not its identity. There the address was a
// filename that did not move when the bytes did; here it is a position that
// does not move when the chapter does.
//
// Contract under test:
//   A. with a gap in the manifest, each chapter shows ITS OWN text
//   A2. the instrument: pairing by position would have shown the wrong text
//       here, so A is distinguishing the two rules rather than passing on a
//       list where both agree
//   B. a transcript published before chapter numbers existed still pairs by
//      position — karagame and brandonlandry.com serve exactly those

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pwLib = process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright');
const { chromium } = createRequire(import.meta.url)(pwLib);

const player = process.env.PLAYER_DIR || join(here, '../audiobook/player');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };

// The transcript has chapters 1, 2 and 3. The MANIFEST has 1 and 3: chapter 2
// has rendered to WAV and has not been encoded yet. Chapter 3 therefore sits at
// position 1, where a positional pairing finds chapter 2's text.
const transcripts = {
  books: [
    { slug: 'gapped', chapters: [
      { index: 1, n: 1, title: 'Ch 1: One',
        chunks: [{ index: 0, text: 'WORDS-OF-CHAPTER-ONE', start: 0, end: 5 }] },
      { index: 2, n: 2, title: 'Ch 2: Two',
        chunks: [{ index: 0, text: 'WORDS-OF-CHAPTER-TWO', start: 0, end: 5 }] },
      { index: 3, n: 3, title: 'Ch 3: Three',
        chunks: [{ index: 0, text: 'WORDS-OF-CHAPTER-THREE', start: 0, end: 5 }] },
    ] },
    // The same book with the numbers stripped: a transcript published before
    // `n` existed. Its chapter list has no gap, so position is correct there.
    { slug: 'legacy', chapters: [
      { index: 1, title: 'Ch 1: One',
        chunks: [{ index: 0, text: 'LEGACY-CHAPTER-ONE', start: 0, end: 5 }] },
      { index: 2, title: 'Ch 2: Two',
        chunks: [{ index: 0, text: 'LEGACY-CHAPTER-TWO', start: 0, end: 5 }] },
    ] },
  ],
};

const books = [
  { slug: 'gapped', title: 'Gapped Book', artist: 'Fixture', duration: 60.0, chapters: [
    { id: 0, n: 1, title: 'Chapter 1: One', filename: 'audio/chapter_0001.m4a',
      start: 0.0, end: 30.0, duration: 30.0, size: 1 },
    { id: 1, n: 3, title: 'Chapter 3: Three', filename: 'audio/chapter_0003.m4a',
      start: 30.0, end: 60.0, duration: 30.0, size: 1 },
  ] },
  { slug: 'legacy', title: 'Legacy Book', artist: 'Fixture', duration: 60.0, chapters: [
    { id: 0, n: 1, title: 'Chapter 1: One', filename: 'audio/chapter_0001.m4a',
      start: 0.0, end: 30.0, duration: 30.0, size: 1 },
    { id: 1, n: 2, title: 'Chapter 2: Two', filename: 'audio/chapter_0002.m4a',
      start: 30.0, end: 60.0, duration: 30.0, size: 1 },
  ] },
];

const uri = 'data:application/json;base64,'
  + Buffer.from(JSON.stringify(transcripts)).toString('base64');

const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>chapter-text-pairing</title><link rel="stylesheet" href="/player.css"></head>
<body><div id="app"></div>
<script>var RepoStoryFeedback = { init: function () {}, send: function () {} };</script>
<script src="/player.js"></script>
<script>
RepoStoryPlayer.init({
  container: document.getElementById('app'),
  books: ${JSON.stringify(books)},
  audioBaseUrl: '',
  transcriptUrl: ${JSON.stringify(uri)},
  autoOpenLast: false
});
</script></body></html>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html',
                         'content-length': Buffer.byteLength(html) });
    res.end(html);
    return;
  }
  if (/\/audio\/chapter_\d+\.m4a$/.test(path)) {
    const body = 'x';
    res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': body.length });
    res.end(body);
    return;
  }
  const file = join(player, path.slice(1));
  if (!file.startsWith(player) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[file.split('.').pop()] || 'application/octet-stream',
                       'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

const transcriptText = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('.transcript-chunk')).map((n) => n.textContent).join(' '));

// A COLD load per chapter, forced by a distinct query so the browser builds a
// new document rather than treating a fragment change as same-page navigation.
//
// The first version of this waited for `.transcript-chunk` to exist after a
// fragment-only navigation. Chunks from the PREVIOUS chapter were already in
// the DOM, so the settle condition was true before the work started and the
// assertion read the old chapter's text — a green that measured nothing, which
// is the exact failure mode this suite is about at a different layer.
let load = 0;
async function openChapter(slug, idx) {
  await page.goto(`${origin}/?load=${++load}#/${slug}/${idx + 1}`);
  await page.waitForFunction(
    () => document.querySelectorAll('.transcript-chunk').length > 0,
    null, { timeout: 10000 });
}

// --- A: each chapter shows its own text, across the gap --------------------
{
  await openChapter('gapped', 0);
  const first = await transcriptText();
  check(first.includes('WORDS-OF-CHAPTER-ONE'),
        `A: chapter 1 shows chapter 1's text ("${first.trim()}")`);

  await openChapter('gapped', 1);
  const second = await transcriptText();
  check(second.includes('WORDS-OF-CHAPTER-THREE'),
        `A: the chapter after the gap shows chapter 3's text ("${second.trim()}")`);
  check(!second.includes('WORDS-OF-CHAPTER-TWO'),
        'A: and not the text of the chapter the manifest never got');
}

// --- A2: prove the two rules actually disagree on this fixture -------------
{
  // Read the same book the OLD way, in the page, from the same data. If this
  // ever stops finding chapter two's text, the fixture no longer distinguishes
  // identity from position and the assertions above prove nothing.
  const byPosition = await page.evaluate((u) => fetch(u).then((r) => r.json())
    .then((d) => d.books.find((b) => b.slug === 'gapped')
      .chapters.find((c) => c.index === 1 + 1).chunks[0].text), uri);
  check(byPosition === 'WORDS-OF-CHAPTER-TWO',
        `A2: pairing by position on this fixture lands on chapter 2 ("${byPosition}")`);
}

// --- B: a transcript with no numbers keeps the positional rule -------------
{
  await openChapter('legacy', 1);
  const text = await transcriptText();
  check(text.includes('LEGACY-CHAPTER-TWO'),
        `B: a numberless transcript still pairs by position ("${text.trim()}")`);
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
