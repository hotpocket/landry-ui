// library-tree.test.mjs — nested library rendering, and the flat fallback.
//
// Run: node test/library-tree.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// Contract under test:
//   A. given config.tree, the library renders nested category groups
//   B. given NO tree, the flat config.books array renders exactly as before —
//      karagame and brandonlandry.com consume this player and send no tree,
//      so the fallback is a hard compatibility requirement, not a nicety
//   C. books at the tree root render outside any group
//   D. clicking a book inside a group opens that book, not the one at the
//      same position in the flat array
//   E. a per-book transcriptUrl is fetched when the book opens, so a
//      multi-book site does not need one merged transcripts.json
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
const check = (cond, m) => (cond ? ok(m) : bad(m));

const playerJs = readFileSync(join(vanilla, 'player.js'), 'utf8');
const playerCss = readFileSync(join(vanilla, 'player.css'), 'utf8');
const feedbackJs = readFileSync(join(vanilla, 'feedback.js'), 'utf8');

function chapters(n, prefix) {
  return Array.from({ length: n }, (_, i) => ({
    id: i, n: i + 1, title: `Chapter ${i + 1}`,
    filename: `${prefix}/chapter_${String(i + 1).padStart(4, '0')}.m4a`,
    start: i * 10, end: (i + 1) * 10, duration: 10, size: 1000,
  }));
}

const flatBooks = [
  { slug: 'alpha', book_id: 'alpha', title: 'Alpha', artist: '', duration: 30, chapters: chapters(3, 'alpha') },
  { slug: 'beta', book_id: 'beta', title: 'Beta', artist: '', duration: 20, chapters: chapters(2, 'beta') },
  { slug: 'root-book', book_id: 'root-book', title: 'Root Book', artist: '', duration: 10, chapters: chapters(1, 'root') },
];

// alpha under tech/virt, beta under tech, root-book at the root.
const tree = {
  name: '', path: '', books: [flatBooks[2]],
  children: [{
    name: 'tech', path: 'tech', books: [flatBooks[1]],
    children: [{ name: 'virt', path: 'tech/virt', books: [flatBooks[0]], children: [] }],
  }],
};

function page(config) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${playerCss}</style></head><body><div id="app"></div>
<script>${feedbackJs}</script>
<script>${playerJs}</script>
<script>RepoStoryPlayer.init(Object.assign(
  { container: document.getElementById('app'), audioBaseUrl: 'audio/' },
  ${JSON.stringify(config)}));</script>
</body></html>`;
}

// Served over http rather than setContent/file://: the player uses
// localStorage for reading progress, and a document with an opaque origin is
// denied access to it — every test would fail on an unrelated error.
let pending = null;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(pending);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

async function open(config) {
  pending = page(config);
  const p = await browser.newPage({ viewport: { width: 900, height: 700 } });
  p.on('pageerror', (e) => bad(`page error: ${e.message}`));
  await p.goto(origin + '/index.html');
  await p.waitForSelector('#book-list', { timeout: 5000 });
  return p;
}

// --- A + C: nested rendering ---
{
  const p = await open({ books: flatBooks, tree });

  const groups = await p.$$eval('.lib-group', (els) =>
    els.map((e) => e.getAttribute('data-path')));
  check(groups.includes('tech'), 'A: renders a group for tech');
  check(groups.includes('tech/virt'), 'A: renders a nested group for tech/virt');

  const nested = await p.$eval('.lib-group[data-path="tech/virt"]',
    (el) => el.querySelectorAll('.book-item').length);
  check(nested === 1, 'A: tech/virt holds exactly its one book');

  const deep = await p.$eval('.lib-group[data-path="tech"]',
    (el) => !!el.querySelector('.lib-group[data-path="tech/virt"]'));
  check(deep, 'A: virt is rendered inside tech, not as a sibling');

  const rootBooks = await p.$$eval('#book-list > .book-item', (els) => els.length);
  check(rootBooks === 1, 'C: the root book renders outside any group');

  const total = await p.$$eval('.book-item', (els) => els.length);
  check(total === 3, 'A: every book appears exactly once');

  // --- D: the right book opens ---
  await p.click('.lib-group[data-path="tech/virt"] .book-item .title');
  await p.waitForSelector('#player-view.active', { timeout: 5000 });
  const title = await p.$eval('#book-title', (el) => el.textContent.trim());
  check(title === 'Alpha', `D: opening the nested book opens Alpha (got ${title})`);
  await p.close();
}

// --- B: flat fallback, no tree at all ---
{
  const p = await open({ books: flatBooks });
  const groups = await p.$$eval('.lib-group', (els) => els.length);
  check(groups === 0, 'B: no tree means no groups');
  const items = await p.$$eval('#book-list > .book-item', (els) => els.length);
  check(items === 3, 'B: all three books render flat, as before');
  const titles = await p.$$eval('.book-item .title', (els) => els.map((e) => e.textContent.trim()));
  check(titles.join(',') === 'Alpha,Beta,Root Book', 'B: flat order is the array order');
  await p.close();
}

// --- B2: an empty tree must not swallow the flat array ---
{
  const p = await open({ books: flatBooks, tree: { name: '', path: '', books: [], children: [] } });
  const items = await p.$$eval('.book-item', (els) => els.length);
  check(items === 3, 'B2: an empty tree falls back to the flat array');
  await p.close();
}

// --- E: per-book transcript URL ---
{
  const withTranscript = flatBooks.map((b) =>
    Object.assign({}, b, { transcriptUrl: `t-${b.slug}.json` }));
  pending = page({ books: withTranscript });
  const p = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const asked = [];
  await p.route('**/t-*.json', (route) => {
    asked.push(route.request().url().split('/').pop());
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ books: [] }) });
  });
  p.on('pageerror', (e) => bad(`page error: ${e.message}`));
  await p.goto(origin + '/index.html');
  await p.waitForSelector('#book-list', { timeout: 5000 });
  await p.click('.book-item .title');
  await p.waitForSelector('#player-view.active', { timeout: 5000 });
  await p.waitForTimeout(300);
  check(asked.includes('t-alpha.json'),
    `E: opening Alpha fetches its own transcript (asked: ${asked.join(',') || 'nothing'})`);
  await p.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
