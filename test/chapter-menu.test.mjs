// chapter-menu.test.mjs — the per-chapter menu, and the chapter deep link.
//
// Run: node test/chapter-menu.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// Spec: docs/spec-chapter-list.md — §6 is the change intent this file guards.
//
// The chapter row's primary gesture is already spoken for (tap plays), and so
// is the hold on its scrubber (seek). So the menu is the SECONDARY gesture:
// right-click, a hold away from the scrubber, or the keyboard's own context
// gesture on a focused row. Every one of those has to keep its neighbour
// working, which is most of what is asserted below.
//
// Contract under test:
//   A. nothing to show means no menu at all, and the browser keeps its own
//      context menu on the row (the player must not take it and give nothing).
//      "Nothing to show" is no host actions AND no Cache Storage — the player's
//      own two items are about that store, so a browser without one has none.
//   B. with chapterActions, right-click opens a menu of the host's labels, in
//      the host's order, and the browser's own menu is suppressed
//   C. opening the menu does not start playback and does not change chapter
//   D. choosing an item calls back with the book, the chapter, its 0-based
//      index and the hash that names it — '#/<slug>/<n>', 1-based
//   E. the menu closes on selection, on Escape, on an outside press, when
//      another row's menu opens, and when the list underneath it scrolls — the
//      menu is placed against the window, so a list that moves would leave it
//      pointing at a different chapter. Only ever one is open.
//   F. a right-click outside the chapter list keeps the browser's menu
//   G. a chapter row is focusable, announces itself, plays on Enter/Space, and
//      opens its menu on Shift+F10
//   H. touch: a hold on the row body opens the menu and does NOT play; a hold
//      on the scrubber still scrubs and does NOT open the menu; a quick tap
//      still plays
//   I. the deep link: '#/<slug>/3' lands on chapter 3, paused, and the chapter
//      segment is SPENT — the address goes back to naming the book, so a reload
//      does not throw a reader back to where they were sent
//   J. the player's OWN items are there whether or not a host offers any, they
//      come after the host's, and they report in place instead of closing the
//      menu — Download and Flush are the only two things here that take time
//      and can fail, and closing on them would throw the report away
//   K. Flush empties this book's audio from BOTH caches, matched by where the
//      book's audio lives rather than by the names of its files (a stale entry
//      is precisely one whose name is no longer current), leaves another book's
//      audio alone, says how many went, and stops the shelf claiming the book
//      is downloaded
//   M. the list stops dragging the reader back. It scrolls the PLAYING chapter
//      into view on every frame until the reader scrolls it themselves — and
//      "themselves" was wheel, touch-drag or the scrollbar, none of which a
//      keyboard uses. Making the rows focusable made tabbing a fourth way to
//      move the list, and the loop yanked it back inside a frame. Seen, not
//      reasoned about: a menu opened on the last row of a phone-sized pane
//      ended up open and off-screen.
//      The SIBLING of M — the loop must not scroll a menu off screen either —
//      is guarded in the code and NOT tested here. Reaching it needs the active
//      chapter to change while a menu is open, and every way to change chapter
//      from this suite closes the menu first. Recorded in
//      docs/spec-chapter-list.md §7 rather than faked with a test that would
//      pass against the guard's absence.
//   O. the menu is never clipped. It lives inside a row of a pane that scrolls
//      and clips, and on a phone that pane is about 150px tall — shorter than
//      the menu, so neither "below the row" nor "above the row" fits inside it.
//      Seen, not reasoned about: held on the last chapter of a twelve-chapter
//      book at 390x844, the menu opened below the row and was cut off by the
//      pane's bottom edge with two of its three items unreachable.
//   L. a refused Cache Storage getter — iOS Safari, "Block All Cookies" — is a
//      menu with the host's items and nothing of the player's, and never a
//      throw. Naming `caches` is the throw there, so the check that decides
//      whether to offer the items is itself the thing that has to be guarded.
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

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
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

// Four chapters, so "chapter 3" is a real answer and not the only one.
const BOOK = {
  slug: 'test-book', book_id: 'bk1', title: 'Test Book', artist: 'Fixture',
  duration: 120,
  chapters: Array.from({ length: 4 }, (_, i) => ({
    id: i, n: i + 1, title: `Chapter ${i + 1}`,
    filename: `chapter_000${(i % 2) + 1}.m4a`,
    start: i * 30, end: (i + 1) * 30, duration: 30, size: 1000,
  })),
};

async function newPage(opts, init) {
  const p = await browser.newPage(Object.assign({ viewport: { width: 900, height: 700 } }, opts));
  p.on('pageerror', (e) => bad(`page error: ${e.message}`));
  // Before the page's own scripts: a global replaced after they run is a global
  // that was never hostile when it mattered.
  if (init) await p.addInitScript(init);
  // Whether the browser's own context menu survived. Recorded at the document,
  // in the bubble phase, so it sees what the page decided.
  await p.addInitScript(() => {
    window.__ctx = [];
    document.addEventListener('contextmenu', (e) => {
      window.__ctx.push({ prevented: e.defaultPrevented, target: e.target.className || e.target.tagName });
    });
  });
  return p;
}

async function boot(page, { withActions = true, hash = '', book = BOOK, padActions = 0 } = {}) {
  await page.goto(`${origin}/`);
  await page.evaluate(({ book, withActions, hash, padActions }) => {
    // The hash is set HERE, not in the URL goto, because the fixture page inits
    // a player of its own on load — one that would read the chapter link first,
    // find its own two-chapter book behind the same slug, and spend the segment
    // before this book ever existed. Set between that player and this one.
    //
    // replaceState, not `location.hash =`: assigning the hash is a same-document
    // navigation, and the fixture's live engine answers it — it consumed the
    // chapter and rewrote the address before this player was ever constructed.
    if (hash) history.replaceState(null, '', hash);
    document.body.innerHTML = '<div id="app"></div>';
    window.__calls = [];
    const cfg = {
      container: document.getElementById('app'),
      books: [book],
      audioBaseUrl: 'audio/',
      autoOpenLast: false,
      title: 'Lib',
    };
    if (withActions) {
      // `chapterActions` is host-supplied and unbounded, so the menu's height is
      // the host's to decide. padActions makes a tall one on purpose.
      cfg.chapterActions = [
        ...Array.from({ length: padActions }, (_, i) => ({
          id: `pad${i}`, label: `Padding ${i}`, onSelect: () => {},
        })),
        { id: 'share', label: 'Share this chapter',
          onSelect: (ctx) => window.__calls.push(['share', ctx.book.title, ctx.chapterIndex,
                                                  ctx.chapter.title, ctx.hash]) },
        { id: 'copy', label: 'Copy link',
          onSelect: (ctx) => window.__calls.push(['copy', ctx.hash]) },
      ];
    }
    window.RepoStoryPlayer.init(cfg);
  }, { book, withActions, hash, padActions });
  if (hash) {
    // The hash opens the book itself; the library is hidden by then, so
    // waiting on it would wait forever.
    await page.waitForSelector('#player-view.active');
  } else {
    await page.waitForSelector('#book-list .book-item');
    await page.click('#book-list .book-item .book-open');
    await page.waitForSelector('#player-view.active');
  }
  await page.waitForSelector('#chapter-list li');
  await page.waitForTimeout(120);
}

/** A bare `await page.waitForSelector` CRASHES the suite on timeout, which
 *  reports nothing and skips every case after it. This reports. */
const appears = (p, sel, ms = 3000) =>
  p.waitForSelector(sel, { timeout: ms }).then(() => true, () => false);

// iOS Safari with "Block All Cookies": the GETTER throws. Not .open(), not
// .keys() — naming the identifier.
const REFUSE_CACHES = () => {
  Object.defineProperty(window, 'caches', {
    configurable: true,
    get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
  });
};

/** Text of the first match, or '' — never a crash that reports nothing. */
const textOf = (p, sel) =>
  p.locator(sel).first().textContent({ timeout: 2000 }).then((t) => (t || '').trim(), () => '');

const menuCount = (p) => p.$$eval('.ch-menu-items', (n) => n.length);
const activeChapter = (p) => p.$$eval('#chapter-list li',
  (n) => n.findIndex((x) => x.classList.contains('active')));
const isPlaying = (p) => p.evaluate(() => {
  const a = document.querySelector('audio');
  return !!a && !a.paused;
});

// --- A: absent when there is nothing to put in it -------------------------
{
  const p = await newPage({}, REFUSE_CACHES);
  await boot(p, { withActions: false });
  await p.click('#chapter-list li:nth-child(2)', { button: 'right' });
  await p.waitForTimeout(80);
  check(await menuCount(p) === 0,
    'A: no menu when there is no host action and no Cache Storage');
  const ctx = await p.evaluate(() => window.__ctx);
  check(ctx.length === 1 && ctx[0].prevented === false,
    `A: the browser keeps its own context menu on the row (${JSON.stringify(ctx)})`);
  await p.close();
}

// --- B, C: right-click opens the host's menu, and disturbs nothing ---------
const p = await newPage();
await boot(p);
check(await menuCount(p) === 0, 'B: closed until opened');
const chapterBefore = await activeChapter(p);
await p.click('#chapter-list li:nth-child(3)', { button: 'right' });
check(await appears(p, '.ch-menu-items'), 'B: right-click opens a menu on the row');
const labels = await p.$$eval('.ch-menu-item', (n) => n.map((x) => x.textContent.trim()));
check(labels.slice(0, 2).join('|') === 'Share this chapter|Copy link',
  `B: the host's labels, in the host's order, first (${labels.join('|')})`);
{
  const ctx = await p.evaluate(() => window.__ctx);
  check(ctx.length === 1 && ctx[0].prevented === true,
    `B: the browser's own menu is suppressed on a row that has one (${JSON.stringify(ctx)})`);
}
check(await activeChapter(p) === chapterBefore,
  'C: opening the menu did not change chapter');
check(await isPlaying(p) === false, 'C: opening the menu did not start playback');

// --- D: the callback carries the chapter and its address ------------------
await p.click('.ch-menu-item[data-action="share"]');
{
  const calls = await p.evaluate(() => window.__calls);
  check(JSON.stringify(calls) === JSON.stringify([['share', 'Test Book', 2, 'Chapter 3', '#/test-book/3']]),
    `D: callback got book, 0-based index, chapter and the 1-based hash (${JSON.stringify(calls)})`);
}

// --- E: closing ------------------------------------------------------------
check(await menuCount(p) === 0, 'E: choosing an item closed the menu');

await p.click('#chapter-list li:nth-child(2)', { button: 'right' });
await appears(p, '.ch-menu-items');
await p.keyboard.press('Escape');
await p.waitForTimeout(80);
check(await menuCount(p) === 0, 'E: Escape closed the menu');

await p.click('#chapter-list li:nth-child(2)', { button: 'right' });
await appears(p, '.ch-menu-items');
await p.click('.transcript-panel-header h3');
await p.waitForTimeout(80);
check(await menuCount(p) === 0, 'E: a press outside closed the menu');

// Bottom row first, then the top one: the menu spans its row and is several
// rows tall, so a menu opened at the top of a four-chapter book covers every
// row below it — and a right-click aimed at one of those lands on the menu.
// Which is correct behaviour and a real thing a reader will do; it just makes
// the OTHER order untestable by clicking.
await p.click('#chapter-list li:nth-child(4)', { button: 'right' });
await appears(p, '.ch-menu-items');
await p.click('#chapter-list li:nth-child(1)', { button: 'right' });
await p.waitForTimeout(80);
check(await menuCount(p) === 1, 'E: only one row has a menu open at a time');
{
  const on = await p.$$eval('.ch-menu-items',
    (n) => n.map((el) => el.closest('li') && el.closest('li').getAttribute('data-ch')));
  check(on.join() === '1', `E: and it is the row that was just asked (${on.join()})`);
}
await p.keyboard.press('Escape');
await p.waitForTimeout(80);

// --- F: the rest of the page keeps its browser menu -----------------------
await p.evaluate(() => { window.__ctx = []; });
await p.click('.transcript-panel-header h3', { button: 'right' });
await p.waitForTimeout(80);
{
  const ctx = await p.evaluate(() => window.__ctx);
  check(ctx.length === 1 && ctx[0].prevented === false,
    `F: a right-click that is not on a chapter row is left alone (${JSON.stringify(ctx)})`);
  check(await menuCount(p) === 0, 'F: and it opens no menu');
}

// --- G: the keyboard ------------------------------------------------------
{
  const semantics = await p.$eval('#chapter-list li:nth-child(2)', (el) => ({
    role: el.getAttribute('role'), tab: el.getAttribute('tabindex'),
    haspopup: el.getAttribute('aria-haspopup'), label: el.getAttribute('aria-label'),
  }));
  check(semantics.role === 'button' && semantics.tab === '0',
    `G: a chapter row announces itself and takes focus (${JSON.stringify(semantics)})`);
  check(!!semantics.label, 'G: and it has a name a screen reader can read');
}

await p.$eval('#chapter-list li:nth-child(2)', (el) => el.focus());
await p.keyboard.down('Shift');
await p.keyboard.press('F10');
await p.keyboard.up('Shift');
await p.waitForTimeout(80);
check(await menuCount(p) === 1, 'G: Shift+F10 on a focused row opens its menu');
check(await isPlaying(p) === false, 'G: and it did not start playback');
await p.keyboard.press('Escape');
await p.waitForTimeout(80);

await p.$eval('#chapter-list li:nth-child(2)', (el) => el.focus());
await p.keyboard.press('Enter');
await p.waitForTimeout(200);
check(await activeChapter(p) === 1, 'G: Enter on a focused row goes to that chapter');

await p.$eval('#chapter-list li:nth-child(4)', (el) => el.focus());
await p.keyboard.press('Space');
await p.waitForTimeout(200);
check(await activeChapter(p) === 3, 'G: Space on a focused row goes to that chapter');
await p.close();

// --- H: touch --------------------------------------------------------------
/** Synthetic touch. Playwright's touchscreen only taps, and the timing between
 *  down and up is the whole point. `at` is a fraction across the element. */
async function hold(page, selector, { holdMs = 500, at = 0.5, moveAfter = 0, click = true } = {}) {
  return page.evaluate(async ({ selector, holdMs, at, moveAfter, click }) => {
    const el = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * at, y = r.top + r.height / 2;
    const touch = (t, cx, cy) => {
      const point = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy });
      el.dispatchEvent(new TouchEvent(t, {
        bubbles: true, cancelable: true,
        touches: t === 'touchend' ? [] : [point],
        changedTouches: [point], targetTouches: t === 'touchend' ? [] : [point],
      }));
    };
    const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
    touch('touchstart', x, y);
    await sleep(holdMs);
    if (moveAfter) { touch('touchmove', x + moveAfter, y); await sleep(32); }
    touch('touchend', x + moveAfter, y);
    // The click a real browser synthesises after a tap. Dispatched here because
    // synthetic touch events do not produce one, and "the hold must not also
    // play the chapter" is precisely a question about that click.
    //
    // `click: false` is the other half of that question, and it is not a
    // hypothetical: a finger that drags off after the press has already fired
    // lifts without a tap, and Android suppresses the click outright when it
    // raises its own context menu at the end of a long press. Whatever the
    // hold left behind has to survive a click that never comes.
    if (click) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(60);
  }, { selector, holdMs, at, moveAfter, click });
}

/** A real tap: down, up, and the click the engine synthesises from the pair.
 *  A bare click() would skip the touch entirely, which is the half of the
 *  sequence a reader's finger actually sends first. */
async function tap(page, selector) {
  return page.evaluate(async (selector) => {
    const el = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const touch = (t) => {
      const point = new Touch({ identifier: 2, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent(t, {
        bubbles: true, cancelable: true,
        touches: t === 'touchend' ? [] : [point],
        changedTouches: [point], targetTouches: t === 'touchend' ? [] : [point],
      }));
    };
    touch('touchstart');
    await new Promise((r2) => setTimeout(r2, 40));
    touch('touchend');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r2) => setTimeout(r2, 60));
  }, selector);
}

{
  const t = await newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  await boot(t);
  const before = await activeChapter(t);
  await hold(t, '#chapter-list li:nth-child(3)', { holdMs: 500, at: 0.5 });
  check(await menuCount(t) === 1, 'H: a hold on the row body opens the menu');
  check(await activeChapter(t) === before,
    'H: and the tap it ends with does not play the chapter');
  await t.keyboard.press('Escape');
  await t.waitForTimeout(80);

  // A quick tap is still a tap.
  await t.$eval('#chapter-list li:nth-child(2)', (el) => el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true })));
  await t.waitForTimeout(200);
  check(await activeChapter(t) === 1, 'H: a quick tap still goes to the chapter');

  // The scrubber keeps its hold. It exists only on the active row.
  await t.waitForTimeout(150);
  await hold(t, '#chapter-list li:nth-child(2) .ch-scrubber', { holdMs: 500 });
  check(await menuCount(t) === 0,
    'H: a hold that begins on the scrubber is a seek, never a menu');
  await t.close();
}

// --- H2: the hold whose click never arrives --------------------------------
// The suppression the hold sets up is spent by the click that follows it. When
// no click follows — the finger drags off after the press fired, or Android
// swallows the tap under its own context menu — a suppression that is only ever
// cleared by being consumed outlives its gesture, and the NEXT tap on any
// chapter is eaten in silence. The reader taps a chapter, nothing happens, they
// tap again and it works.
{
  const t = await newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  await boot(t);
  await hold(t, '#chapter-list li:nth-child(3)', { holdMs: 500, moveAfter: 60, click: false });
  check(await menuCount(t) === 1, 'H2: the hold still opens the menu with no click after it');
  // Escape rather than a press outside: a press would be a second gesture, and
  // this has to be about the first one alone.
  await t.keyboard.press('Escape');
  await t.waitForTimeout(120);
  check(await menuCount(t) === 0, 'H2: the premise — the menu is closed before the tap');

  const before = await activeChapter(t);
  await tap(t, '#chapter-list li:nth-child(2)');
  await t.waitForTimeout(250);
  check(await activeChapter(t) === 1,
    `H2: and the next tap plays its chapter, first time (was ${before}, now ${await activeChapter(t)})`);
  await t.close();
}

// --- I: the deep link ------------------------------------------------------
{
  const d = await newPage();
  await boot(d, { hash: '#/test-book/3' });
  await d.waitForTimeout(300);
  check(await d.$('#player-view.active') !== null, 'I: a chapter link opens the book');
  check(await activeChapter(d) === 2, `I: on the named chapter (${await activeChapter(d)})`);
  check(await isPlaying(d) === false, 'I: paused — arriving is not being played at');
  const hash = await d.evaluate(() => location.hash);
  check(hash === '#/test-book', `I: the chapter segment is spent on arrival (${hash})`);
  await d.close();
}

// --- J: the player's own items --------------------------------------------
{
  const j = await newPage();
  await boot(j, { withActions: false });   // a normal browser: Cache Storage is there
  await j.click('#chapter-list li:nth-child(2)', { button: 'right' });
  check(await appears(j, '.ch-menu-items'),
    "J: the player's own items give the row a menu with no host at all");
  const own = await j.$$eval('.ch-menu-item', (n) => n.map((x) => x.dataset.action));
  check(own.join('|') === 'download|flush', `J: and they are download and flush (${own.join('|')})`);
  await j.close();
}

const k = await newPage();
await boot(k);
await k.click('#chapter-list li:nth-child(2)', { button: 'right' });
await appears(k, '.ch-menu-items');
{
  const order = await k.$$eval('.ch-menu-item', (n) => n.map((x) => x.dataset.action));
  check(order.join('|') === 'share|copy|download|flush',
    `J: the host's items come first, the player's after (${order.join('|')})`);
}

// Download reports in place. The fixture's audio is real, so this one succeeds.
await k.click('.ch-menu-item[data-action="download"]');
await k.waitForTimeout(80);
check(await menuCount(k) === 1, 'J: choosing Download left the menu open to report');
{
  const settled = await k.waitForFunction(
    () => /Downloaded|Failed/.test(document.querySelector('.ch-menu-item[data-action="download"]')?.textContent || ''),
    null, { timeout: 8000 }).then(() => true, () => false);
  const label = await textOf(k, '.ch-menu-item[data-action="download"]');
  check(settled && /Downloaded/.test(label), `J: and it reported the outcome there (${label})`);
}

// --- K: flush --------------------------------------------------------------
// Two caches, three entries: two of this book's (one per cache) and one that
// belongs to somewhere else entirely. A flush that took the third would be
// taking another book's offline copy away.
const FOREIGN = '/somewhere-else/audio/other.m4a';
await k.evaluate(async (foreign) => {
  const audio = await caches.open('audiobook-audio');
  const stream = await caches.open('audiobook-stream');
  await stream.put(new Request(new URL('audio/chapter_0002.m4a', location.href).href),
                   new Response('x'));
  await audio.put(new Request(new URL(foreign, location.href).href), new Response('x'));
}, FOREIGN);
const cachedNow = () => k.evaluate(async () => {
  const names = ['audiobook-audio', 'audiobook-stream'];
  const out = [];
  for (const n of names) {
    const c = await caches.open(n);
    for (const req of await c.keys()) out.push(new URL(req.url).pathname);
  }
  return out.sort();
});
const before = await cachedNow();
// Matched with the SAME predicate the flush assertion below uses. `/audio/`
// was the wrong one: FOREIGN contains it too, so the premise counted the entry
// the flush is required to leave alone and could be satisfied with a single
// chapter of this book's in the caches — which would let the "it is gone"
// assertion pass against a cache that barely held it in the first place.
check(before.filter((u) => /chapter_000\d\.m4a$/.test(u)).length >= 2,
  `K: the premise — this book's audio is cached, in both caches (${JSON.stringify(before)})`);

await k.click('.ch-menu-item[data-action="flush"]');
{
  const settled = await k.waitForFunction(
    () => /Cleared|Nothing|Could not/.test(document.querySelector('.ch-menu-item[data-action="flush"]')?.textContent || ''),
    null, { timeout: 8000 }).then(() => true, () => false);
  const label = await textOf(k, '.ch-menu-item[data-action="flush"]');
  check(settled && /Cleared \d+/.test(label), `K: it says how many entries went (${label})`);
  check(await menuCount(k) === 1, 'K: and the menu stayed open to say it');
}
{
  const after = await cachedNow();
  check(!after.some((u) => /chapter_000\d\.m4a$/.test(u)),
    `K: this book's audio is gone from both caches (${JSON.stringify(after)})`);
  check(after.includes(FOREIGN), `K: and nothing else was touched (${JSON.stringify(after)})`);
}

// The shelf must stop claiming the book is downloaded.
await k.keyboard.press('Escape');
await k.click('#back-btn');
await k.waitForSelector('#book-list .dl-btn');
await k.waitForTimeout(400);
{
  const cls = await k.$eval('#book-list .dl-btn', (e) => e.className).catch(() => 'MISSING');
  check(!/downloaded/.test(cls), `K: the shelf stops saying Downloaded ✓ (${cls})`);
}

// --- J: the shelf's control is an icon, not a pill -------------------------
{
  const size = await k.$eval('#book-list .dl-btn', (e) => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             name: e.getAttribute('title') || e.getAttribute('aria-label') || '' };
  });
  check(size.w <= 48,
    `J: the shelf's download control is an icon, not a 128px pill (${size.w}px)`);
  check(/download/i.test(size.name),
    `J: and it still has a name a screen reader can read (${size.name})`);
}
await k.close();

// --- M: the list does not drag a focused row away -------------------------
{
  const LONG = {
    slug: 'long-book', book_id: 'bk2', title: 'Long Book', duration: 360,
    chapters: Array.from({ length: 12 }, (_, i) => ({
      id: i, n: i + 1, title: `Chapter ${i + 1}`,
      filename: `chapter_000${(i % 2) + 1}.m4a`,
      start: i * 30, end: (i + 1) * 30, duration: 30, size: 1000,
    })),
  };
  const m = await newPage({ viewport: { width: 390, height: 700 } });
  await boot(m, { book: LONG });
  const inView = () => m.$eval('#chapter-list li:nth-child(12)', (el) => {
    const r = el.getBoundingClientRect();
    const lr = el.parentElement.getBoundingClientRect();
    return r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1;
  });
  // focus() scrolls the row into view, which is the whole point: a keyboard
  // moving through the list moves the list.
  await m.$eval('#chapter-list li:nth-child(12)', (el) => el.focus());
  check(await inView(), 'M: the premise — focusing the last row brings it into view');
  await m.waitForTimeout(600);
  check(await inView(), 'M: and it is still there half a second later');
  await m.close();
}

// --- O: the menu escapes the pane -----------------------------------------
{
  const LONG3 = {
    slug: 'long-three', book_id: 'bk4', title: 'Long Book', duration: 360,
    chapters: Array.from({ length: 12 }, (_, i) => ({
      id: i, n: i + 1, title: `Chapter ${i + 1}`,
      filename: `chapter_000${(i % 2) + 1}.m4a`,
      start: i * 30, end: (i + 1) * 30, duration: 30, size: 1000,
    })),
  };
  const o = await newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await boot(o, { book: LONG3 });
  const pane = await o.$eval('#chapter-list', (e) => Math.round(e.getBoundingClientRect().height));
  await o.click('#chapter-list li:nth-child(1)', { button: 'right' });
  check(await appears(o, '.ch-menu-items'), 'O: the premise — a menu opens on a phone');
  const box = await o.$eval('.ch-menu-items', (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
             left: Math.round(r.left), right: Math.round(r.right),
             h: Math.round(r.height) };
  }).catch(() => null);
  check(box && box.h > pane,
    `O: the premise — the menu is taller than the pane that would clip it (menu ${box && box.h}px, pane ${pane}px)`);
  // Every item has to be reachable, so every pixel of the menu has to be on
  // screen. The pane is not the constraint; the window is.
  check(box && box.top >= 0 && box.bottom <= 844,
    `O: the whole menu is inside the window (${JSON.stringify(box)})`);
  const hit = await o.evaluate(() => {
    const items = [...document.querySelectorAll('.ch-menu-item')];
    return items.map((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(at && at.closest('.ch-menu-items'));
    });
  });
  check(hit.length === 4 && hit.every(Boolean),
    `O: and every item can actually be pressed (${JSON.stringify(hit)})`);

  // E, tested here because this is the first page whose chapter list can
  // actually scroll: a fixed menu does not travel with its row, so rather than
  // let it point at a different chapter, the list moving ends it.
  await o.$eval('#chapter-list', (el) => { el.scrollTop = el.scrollTop + 60; });
  await o.waitForTimeout(150);
  check(await menuCount(o) === 0, 'E: scrolling the list closed the menu');
  await o.close();

  // The other direction. A row near the BOTTOM OF THE WINDOW has no room below
  // it, so the menu opens upwards — the branch a phone never takes, because
  // there the pane sits at the top of a tall window.
  // Six extra host actions, so the menu is taller than the gap the transport
  // leaves below the chapter pane. Not contrived: chapterActions is the host's
  // list and nothing bounds it, so the menu's height is not the player's to
  // assume — which is the whole reason this branch exists.
  const w = await newPage({ viewport: { width: 1100, height: 620 } });
  await boot(w, { book: LONG3, padActions: 6 });
  // focus() both scrolls the row into view and tells the list the reader owns
  // the scroll, which is the only reason it stays there.
  await w.$eval('#chapter-list li:nth-child(12)', (el) => el.focus());
  await w.waitForTimeout(200);
  await w.click('#chapter-list li:nth-child(12)', { button: 'right' });
  check(await appears(w, '.ch-menu-items'), 'O: the premise — the last row has a menu');
  const cls = await w.$eval('.ch-menu-items', (e) => e.className).catch(() => '');
  const below = await w.$eval('#chapter-list li:nth-child(12)', (el) => {
    const r = el.getBoundingClientRect();
    return Math.round(window.innerHeight - r.bottom);
  });
  check(/above/.test(cls),
    `O: with no room below it (${below}px), the menu opens upwards (${cls})`);
  const box2 = await w.$eval('.ch-menu-items', (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
  }).catch(() => null);
  check(box2 && box2.top >= 0 && box2.bottom <= 620,
    `O: and it is still whole (${JSON.stringify(box2)})`);
  const hit2 = await w.evaluate(() => [...document.querySelectorAll('.ch-menu-item')].map((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(at && at.closest('.ch-menu-items'));
  }));
  check(hit2.length === 10 && hit2.every(Boolean),
    `O: and every item can be pressed there too (${JSON.stringify(hit2)})`);
  await w.close();
}

// --- L: Cache Storage that refuses ----------------------------------------
{
  const l = await newPage({}, REFUSE_CACHES);
  await boot(l);
  await l.click('#chapter-list li:nth-child(2)', { button: 'right' });
  check(await appears(l, '.ch-menu-items'),
    "L: a refused Cache Storage still leaves the host's menu");
  const items = await l.$$eval('.ch-menu-item', (n) => n.map((x) => x.dataset.action))
    .catch(() => []);
  check(items.join('|') === 'share|copy',
    `L: and offers nothing that needs the store it cannot reach (${items.join('|')})`);
  // The page error handler on this page is the real assertion: naming `caches`
  // to decide whether to offer the items is itself a throw on that device, and
  // an unguarded one would arrive here as a page error, not as a missing item.
  check(await l.$eval('#chapter-list li', (e) => e.getAttribute('aria-haspopup'))
    .catch(() => null) === 'menu',
    'L: and the row still announces the menu it does have');
  await l.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
