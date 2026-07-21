// summary.test.mjs — browser tests for the Full/Summary transcript+audio toggle.
//
// Run: node test/summary.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
// Fixture: test/fixture/gen.sh (run automatically if out/ is missing).
//
// Contract under test:
//   A. a book with per-chapter summaries shows Full/Summary buttons in the
//      transcript header; Full is active by default
//   B. clicking Summary switches the audio source to the chapter's summary
//      M4A, the transcript pane to summary chunks, and the total-time display
//      to the summary timeline
//   C. clicking a summary chunk seeks the summary audio (chunk times are on
//      the summary clock)
//   D. clicking Full restores the full audio + transcript
//   E. summary mode persists across a reload
//   F. chapter navigation in summary mode stays in summary mode
//   G. a book without summaries hides the toggle and always plays full audio
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

const waitTicks = () => page.evaluate(() => new Promise((r) =>
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
const audioSrc = () => page.evaluate(() => document.querySelector('audio').src);
const firstChunkText = () => page.evaluate(() =>
  document.querySelector('.transcript-chunk .chunk-text')?.textContent || '');

await page.goto('file://' + fixture + '#/test-book');
await page.waitForSelector('.transcript-chunk', { timeout: 5000 });
await page.waitForFunction(() => {
  const a = document.querySelector('audio');
  return a && a.readyState >= 1;
}, { timeout: 5000 });

// A: buttons present, Full active by default
const btns = await page.evaluate(() => ({
  full: !!document.querySelector('#mode-full'),
  summary: !!document.querySelector('#mode-summary'),
  fullOn: document.querySelector('#mode-full')?.classList.contains('on'),
  summaryOn: document.querySelector('#mode-summary')?.classList.contains('on'),
  visible: (document.querySelector('#mode-toggle')?.getBoundingClientRect().width || 0) > 0,
}));
check(btns.full && btns.summary && btns.visible, 'A1: Full/Summary buttons render in transcript header');
check(btns.fullOn && !btns.summaryOn, 'A2: Full is active by default');
// Placement: toggle follows the TRANSCRIPT label (left side), not the
// right-aligned control cluster.
const pos = await page.evaluate(() => {
  const h3 = document.querySelector('.transcript-panel-header h3');
  const range = document.createRange();
  range.selectNodeContents(h3);
  const textRight = range.getBoundingClientRect().right;  // end of the label TEXT, not the flexed box
  const tg = document.querySelector('#mode-toggle').getBoundingClientRect();
  const dec = document.querySelector('#ts-dec').getBoundingClientRect();
  return { gap: tg.left - textRight, beforeDec: tg.right <= dec.left };
});
check(pos.gap >= 0 && pos.gap < 40 && pos.beforeDec,
  `A4: toggle sits just after the TRANSCRIPT label (gap ${pos.gap.toFixed(0)}px)`);
check((await audioSrc()).endsWith('chapter_0001.m4a'), 'A3: full audio loaded by default');

// B: switch to Summary
await page.click('#mode-summary');
await waitTicks();
check((await audioSrc()).endsWith('chapter_0001.summary.m4a'), 'B1: summary audio source loads');
check((await firstChunkText()).startsWith('Summary one'), 'B2: transcript pane shows summary chunks');
const stateB = await page.evaluate(() => ({
  summaryOn: document.querySelector('#mode-summary').classList.contains('on'),
  fullOn: document.querySelector('#mode-full').classList.contains('on'),
  total: document.querySelector('#total-time').textContent,
}));
check(stateB.summaryOn && !stateB.fullOn, 'B3: Summary button reflects state');
check(stateB.total === '0:12', `B4: total time is summary timeline (0:12, got ${stateB.total})`);

// C: summary chunk click seeks summary audio
await page.click('#tc-1-2');
await waitTicks();
const tC = await page.evaluate(() => document.querySelector('audio').currentTime);
check(Math.abs(tC - 3.0) < 0.5, `C: summary chunk click seeks summary clock (~3.0s, got ${tC.toFixed(2)})`);

// D: back to Full
await page.click('#mode-full');
await waitTicks();
check((await audioSrc()).endsWith('chapter_0001.m4a'), 'D1: full audio restored');
check((await firstChunkText()).startsWith('Chunk 0'), 'D2: full transcript restored');

// E: persistence across reload
await page.click('#mode-summary');
await waitTicks();
await page.reload();
await page.waitForSelector('.transcript-chunk', { timeout: 5000 });
await waitTicks();
check((await audioSrc()).endsWith('.summary.m4a'), 'E1: summary mode survives reload');
check(await page.evaluate(() => document.querySelector('#mode-summary').classList.contains('on')),
  'E2: Summary button state survives reload');

// F: chapter navigation stays in summary mode
await page.click('#btn-next');
await waitTicks();
check((await audioSrc()).endsWith('chapter_0002.summary.m4a'), 'F1: next chapter loads its summary audio');
check((await firstChunkText()).startsWith('Summary two'), 'F2: next chapter shows its summary transcript');

// G: book without summaries — toggle hidden, full audio, even with pref set
await page.goto('file://' + fixture + '#/plain-book');
await page.waitForSelector('.transcript-chunk', { timeout: 5000 });
await waitTicks();
const stateG = await page.evaluate(() => ({
  toggleW: document.querySelector('#mode-toggle')?.getBoundingClientRect().width || 0,
}));
check(stateG.toggleW === 0, 'G1: toggle hidden for a book without summaries');
check((await audioSrc()).endsWith('chapter_0001.m4a') && !(await audioSrc()).includes('summary'),
  'G2: plain book plays full audio despite summary pref');

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
