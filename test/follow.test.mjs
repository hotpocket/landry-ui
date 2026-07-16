// follow.test.mjs — browser tests for transcript follow behaviour.
//
// Run: node test/follow.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
// Fixture: test/fixture/gen.sh (run automatically if out/ is missing).
//
// Contract under test:
//   A. follow is on by default — playback position change scrolls the active
//      chunk into view
//   B. a manual scroll gesture turns follow off — position changes stop
//      auto-scrolling
//   C. explicit navigation (clicking a chunk) re-arms follow
//   D. #follow-btn reflects state and toggling it back on snaps to the
//      active chunk
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pwLib = process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright');
const { chromium } = createRequire(import.meta.url)(pwLib);

const fixture = join(here, 'fixture/out/index.html');
if (!existsSync(fixture)) execFileSync(join(here, 'fixture/gen.sh'), { stdio: 'inherit' });

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => bad(`page error: ${e.message}`));

await page.goto('file://' + fixture + '#/test-book');
await page.waitForSelector('.transcript-chunk', { timeout: 5000 });

const setTime = (t) => page.evaluate((t) => { document.querySelector('audio').currentTime = t; }, t);

// Active chunk fully inside the transcript pane's visible box?
// (scroll-behavior: smooth animates over ~300ms, so poll rather than sample.)
const visibleExpr = `(() => {
  const el = document.querySelector('.transcript-chunk.active');
  const box = document.querySelector('#transcript-chunks');
  if (!el) return false;
  const er = el.getBoundingClientRect(), br = box.getBoundingClientRect();
  return er.top >= br.top - 1 && er.bottom <= br.bottom + 1;
})()`;
const activeVisible = () =>
  page.waitForFunction(visibleExpr, { timeout: 2000 }).then(() => true, () => false);
const activeStaysHidden = async () => {
  await new Promise((r) => setTimeout(r, 700));  // outlast any smooth scroll
  return !(await page.evaluate(visibleExpr));
};
const waitTicks = () => page.evaluate(() => new Promise((r) =>
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));

// A: default follow — jump late in chapter 1, active chunk must come into view
await page.waitForFunction(() => {
  const a = document.querySelector('audio');
  return a && a.readyState >= 1;
}, { timeout: 5000 });
await setTime(24.5);  // chunk 35 of 40 — far below the fold
await waitTicks();
check(await activeVisible(), 'A: follow-by-default scrolls active chunk into view');

// B: manual wheel gesture disables follow
await page.hover('#transcript-chunks');
await page.mouse.wheel(0, -5000);  // scroll all the way back up
await waitTicks();
await setTime(10.5);  // chunk 15 — mid-list, below the fold from the top
check(await activeStaysHidden(), 'B: manual scroll disables following');

// C: clicking a chunk (explicit navigation) re-arms follow
await page.click('#tc-1-30');
await waitTicks();
await setTime(2.5);  // chunk 3 — near top; follow must scroll there
await waitTicks();
check(await activeVisible(), 'C: chunk click re-arms follow (jump then auto-scroll works)');

// D: follow button exists, reflects state, and re-enables on click
const btn = await page.$('#follow-btn');
if (!btn) {
  bad('D: #follow-btn missing');
} else {
  await page.hover('#transcript-chunks');
  await page.mouse.wheel(0, -600);
  await waitTicks();
  const offState = await page.evaluate(() => !document.querySelector('#follow-btn').classList.contains('on'));
  check(offState, 'D1: manual scroll turns button off');
  await page.click('#follow-btn');
  await waitTicks();
  const onState = await page.evaluate(() => document.querySelector('#follow-btn').classList.contains('on'));
  check(onState && (await activeVisible()), 'D2: button click re-enables + snaps to active chunk');
}

// E: reading mode — transcript-only view, toggle on/off
const rbtn = await page.$('#reading-btn');
if (!rbtn) {
  bad('E: #reading-btn missing');
} else {
  const trWidthBefore = await page.evaluate(() => document.querySelector('.transcript-panel').getBoundingClientRect().width);
  await page.click('#reading-btn');
  await waitTicks();
  const state = await page.evaluate(() => ({
    mode: document.querySelector('#player-view').classList.contains('reading-mode'),
    chapterW: document.querySelector('.chapter-panel').getBoundingClientRect().width,
    nowPlayingW: document.querySelector('.now-playing').getBoundingClientRect().width,
    trW: document.querySelector('.transcript-panel').getBoundingClientRect().width,
  }));
  check(state.mode && state.chapterW === 0 && state.nowPlayingW === 0, 'E1: reading mode hides chapters + header chrome');
  check(state.trW > trWidthBefore * 1.5, 'E2: transcript goes full-width');
  await page.click('#reading-btn');
  await waitTicks();
  const restored = await page.evaluate(() =>
    !document.querySelector('#player-view').classList.contains('reading-mode') &&
    document.querySelector('.chapter-panel').getBoundingClientRect().width > 0);
  check(restored, 'E3: toggling back restores the normal layout');
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
