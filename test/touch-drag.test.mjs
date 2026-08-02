// touch-drag.test.mjs — long-press to drag, on touch devices.
//
// Run: node test/touch-drag.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
//
// Two controls were mouse-only. The panel divider had touch handlers but only
// ever resized horizontally, and it is hidden when the panes stack; the
// per-chapter scrubber had no touch handling at all, so on a phone you could
// not scrub a chapter or rebalance the panes.
//
// Both are drags that live inside scrollable areas, so an immediate drag would
// fight the scroll. A long press disambiguates: hold, feel it engage, then
// drag. Moving before it engages is a scroll and cancels the press.
//
// Contract under test:
//   A. a quick drag scrolls — it does not resize or scrub
//   B. a long press then a drag resizes the panes, on the stacked axis
//   C. a long press then a drag scrubs a chapter
//   D. engaging is visible (a class lands on the element)
//   E. releasing ends the drag
//   F. mouse behaviour is unchanged — no long press required
//   G. the panes always fill the container exactly, at any split
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
  slug: 'b', book_id: 'b', title: 'Test Book', artist: '', duration: 800,
  chapters: Array.from({ length: 10 }, (_, i) => ({
    id: i, n: i + 1, title: `Chapter ${i + 1}`, filename: `c${i}.m4a`,
    start: i * 80, end: (i + 1) * 80, duration: 80, size: 1000,
  })),
}];

const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0}${playerCss}</style></head><body>
<div id="app"></div>
<script>${feedbackJs}</script>
<script>${playerJs}</script>
<script>RepoStoryPlayer.init({ container: document.getElementById('app'),
  books: ${JSON.stringify(BOOKS)}, audioBaseUrl: 'audio/' });</script>
</body></html>`;

const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

/** Synthetic touch sequence. Playwright's touchscreen only taps, and what is
 *  under test is precisely the timing between down, move and up. */
async function touchDrag(page, selector, opts) {
  return page.evaluate(async ({ selector, holdMs, steps, dx, dy, moveBeforeHold }) => {
    const el = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
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
    if (moveBeforeHold) {          // a scroll gesture: move immediately
      await sleep(30);
      touch('touchmove', x, y + 40);
      await sleep(holdMs);
    } else {
      await sleep(holdMs);         // hold still, let the press register
    }
    for (let i = 1; i <= steps; i++) {
      touch('touchmove', x + (dx * i) / steps, y + (dy * i) / steps);
      await sleep(16);
    }
    const engaged = { divider: document.querySelector('.panel-divider.dragging') !== null,
                      scrub: document.querySelector('.chapter-list li.scrubbing') !== null };
    touch('touchend', x + dx, y + dy);
    return engaged;
  }, Object.assign({ selector, holdMs: 450, steps: 6, dx: 0, dy: 0,
                     moveBeforeHold: false }, opts));
}

async function open(viewport) {
  const p = await browser.newPage({ viewport, hasTouch: true, isMobile: viewport.width < 600 });
  p.on('pageerror', (e) => bad(`page error: ${e.message}`));
  await p.goto(origin + '/index.html');
  await p.waitForSelector('.book-item', { timeout: 5000 });
  await p.click('.book-item .title');
  await p.waitForSelector('#player-view.active', { timeout: 5000 });
  await p.waitForTimeout(300);
  return p;
}

const PHONE = { width: 390, height: 844 };

// --- divider: visible and vertical when stacked ---
{
  const p = await open(PHONE);
  const vis = await p.$eval('.panel-divider', (e) => e.offsetParent !== null);
  check(vis, 'divider is available on a phone at all');
  const axis = await p.$eval('.content-area', (e) => getComputedStyle(e).flexDirection);
  check(axis === 'column', `panes are stacked, so the divider resizes vertically (${axis})`);
  await p.close();
}

// --- A: a quick drag must not resize ---
{
  const p = await open(PHONE);
  const before = await p.$eval('.chapter-panel', (e) => Math.round(e.getBoundingClientRect().height));
  await touchDrag(p, '.panel-divider', { holdMs: 60, dy: 120, moveBeforeHold: true });
  await p.waitForTimeout(100);
  const after = await p.$eval('.chapter-panel', (e) => Math.round(e.getBoundingClientRect().height));
  check(Math.abs(after - before) <= 4,
    `A: a quick drag leaves the panes alone (${before} -> ${after})`);
  await p.close();
}

// --- B + D + E: long press then drag resizes ---
{
  const p = await open(PHONE);
  const before = await p.$eval('.chapter-panel', (e) => Math.round(e.getBoundingClientRect().height));
  const engaged = await touchDrag(p, '.panel-divider', { holdMs: 450, dy: 140 });
  await p.waitForTimeout(100);
  const after = await p.$eval('.chapter-panel', (e) => Math.round(e.getBoundingClientRect().height));
  check(after > before + 40, `B: long press then drag grows the chapter pane (${before} -> ${after})`);
  check(engaged.divider, 'D: the divider shows it engaged while dragging');
  const stillDragging = await p.$eval('.panel-divider', (e) => e.classList.contains('dragging'));
  check(!stillDragging, 'E: releasing ends the drag');
  await p.close();
}

// --- C: long press then drag scrubs a chapter ---
{
  const p = await open(PHONE);
  const engaged = await touchDrag(p, '.chapter-list li.active .ch-scrubber',
    { holdMs: 450, dx: 90 });
  check(engaged.scrub, 'C: long press on a chapter engages its scrubber');
  const cleared = await p.$$eval('.chapter-list li.scrubbing', (e) => e.length);
  check(cleared === 0, 'C: releasing ends the scrub');
  await p.close();
}

// --- F: mouse is unchanged ---
{
  const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await p.goto(origin + '/index.html');
  await p.waitForSelector('.book-item');
  await p.click('.book-item .title');
  await p.waitForSelector('#player-view.active');
  await p.waitForTimeout(200);
  const before = await p.$eval('.chapter-panel', (e) => Math.round(e.getBoundingClientRect().width));
  const box = await p.$eval('.panel-divider', (e) => {
    const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await p.mouse.move(box.x, box.y);
  await p.mouse.down();
  await p.mouse.move(box.x + 150, box.y, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(100);
  const after = await p.$eval('.chapter-panel', (e) => Math.round(e.getBoundingClientRect().width));
  check(after > before + 60, `F: mouse drag still resizes immediately (${before} -> ${after})`);
  await p.close();
}

// --- G: no gap, no overflow, at any split ---
//
// Sizing both panes by percentage looked right and was not: the pair stopped
// summing to the container once the divider's own height and the 5/95 clamp
// were in play, leaving a dead band under the transcript that grew as you
// dragged. Only the chapter pane is sized now; the transcript takes the rest.
async function panelGeometry(p) {
  return p.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const area = r('.content-area'), ch = r('.chapter-panel');
    const dv = r('.panel-divider'), tr = r('.transcript-panel');
    const vertical = getComputedStyle(document.querySelector('.content-area'))
      .flexDirection === 'column';
    const size = (b) => (vertical ? b.height : b.width);
    return {
      area: Math.round(size(area)),
      sum: Math.round(size(ch) + size(dv) + size(tr)),
      gap: Math.round(size(area) - (size(ch) + size(dv) + size(tr))),
    };
  });
}

{
  const p = await open(PHONE);
  for (const dy of [140, 140, -220, 90]) {
    await touchDrag(p, '.panel-divider', { holdMs: 450, dy });
    await p.waitForTimeout(80);
    const g = await panelGeometry(p);
    check(Math.abs(g.gap) <= 1,
      `G: panes fill the container after dragging ${dy > 0 ? '+' : ''}${dy} (gap ${g.gap}px of ${g.area})`);
  }
  await p.close();
}

{
  // Same invariant on the horizontal axis, via the mouse.
  const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await p.goto(origin + '/index.html');
  await p.waitForSelector('.book-item');
  await p.click('.book-item .title');
  await p.waitForSelector('#player-view.active');
  await p.waitForTimeout(200);
  for (const dx of [200, -350]) {
    const box = await p.$eval('.panel-divider', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await p.mouse.move(box.x, box.y);
    await p.mouse.down();
    await p.mouse.move(box.x + dx, box.y, { steps: 8 });
    await p.mouse.up();
    await p.waitForTimeout(80);
    const g = await panelGeometry(p);
    check(Math.abs(g.gap) <= 1,
      `G: panes fill the container after a ${dx > 0 ? '+' : ''}${dx} mouse drag (gap ${g.gap}px)`);
  }
  await p.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
