// scene-pause.test.mjs — the scene-break hold pauses the right clock and
// yields to the user.
//
// Run: node test/scene-pause.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
// Fixture: test/fixture/gen.sh (run automatically if out/ is missing).
// The fixture's test-book chapter 1 has a "* * *" divider in its FULL chunks
// (around 1.4–2.1s) and none in its summary chunks.
//
// Contract under test:
//   A. full mode: playback crossing the divider pauses briefly, then resumes
//      on its own
//   B. summary mode: the full track's divider positions mean nothing on the
//      summary clock — playback crosses 1.4–2.1s without a spurious pause
//   C. a user pause taken during the scene hold sticks — the hold's resume
//      timer must not override an explicit pause
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
execFileSync(join(here, 'fixture/gen.sh'), { stdio: 'inherit' });

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

// The hold is lengthened via the config hook so test C's two user clicks have
// a comfortable window to land inside, instead of racing the production 2s.
const HOLD_MS = 3000;

async function freshPage(hash) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', (e) => bad(`page error: ${e.message}`));
  await page.addInitScript((holdMs) => {
    let real;
    Object.defineProperty(window, 'RepoStoryPlayer', {
      configurable: true,
      get() { return real; },
      set(v) {
        real = Object.assign({}, v, {
          init(cfg) { cfg.scenePauseMs = holdMs; return v.init(cfg); },
        });
      },
    });
  }, HOLD_MS);
  await page.goto('file://' + fixture + hash);
  await page.waitForSelector('.transcript-chunk', { timeout: 5000 });
  return page;
}

const audioState = (page) => page.evaluate(() => {
  const a = document.querySelector('audio');
  return { t: a.currentTime, paused: a.paused };
});

// --- A: full mode — crossing the divider pauses, then auto-resumes ---
{
  const page = await freshPage('#/test-book');
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = 0.8;               // just before the divider at ~1.4s
    return a.play();
  });
  // Wait for the hold to engage (pause while playback is mid-chapter).
  const pausedMid = await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return a.paused && a.currentTime > 1.0 && a.currentTime < 4;
  }, { timeout: 6000 }).then(() => true, () => false);
  check(pausedMid, 'A: crossing a scene divider pauses playback');

  const resumed = await page.waitForFunction(() => !document.querySelector('audio').paused,
    { timeout: 5000 }).then(() => true, () => false);
  check(resumed, 'A: the hold releases on its own');
  await page.close();
}

// --- B: summary mode — no spurious pause from full-clock divider times ---
{
  const page = await freshPage('#/test-book');
  await page.click('#mode-summary');
  await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return /summary/.test(a.currentSrc || a.src);
  }, { timeout: 5000 });
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = 0.5;
    return a.play();
  });
  // Cross the 1.4–2.1s window on the summary clock; playback must not pause.
  let spurious = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const s = await audioState(page);
    if (s.paused && s.t < 5.5) { spurious = true; break; }  // < track end
    if (s.t > 3.0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(!spurious, 'B: summary mode crosses full-clock divider times without pausing');
  await page.close();
}

// --- C: user pause during the hold sticks ---
{
  const page = await freshPage('#/test-book');
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = 0.8;
    return a.play();
  });
  const held = await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return a.paused && a.currentTime > 1.0 && a.currentTime < 4;
  }, { timeout: 6000 }).then(() => true, () => false);
  if (!held) {
    bad('C: scene hold never engaged — cannot test user pause');
  } else {
    // Resume by hand, then pause by hand, all inside the 2s hold window.
    await page.click('#play-btn');   // user play
    await page.click('#play-btn');   // user pause — must stick
    await new Promise((r) => setTimeout(r, HOLD_MS + 800));  // outlast the hold timer
    const s = await audioState(page);
    check(s.paused, 'C: an explicit pause during the hold is not overridden');
  }
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
