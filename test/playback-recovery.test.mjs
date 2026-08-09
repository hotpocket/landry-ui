// playback-recovery.test.mjs — recovery obeys the listener, and leaves evidence.
//
// Run: node test/playback-recovery.test.mjs
// Uses the Playwright pinned in ~/git/gstack (override: PLAYWRIGHT_LIB).
// Fixture: test/fixture/gen.sh (run automatically if out/ is missing), served
// over HTTP here because the contracts involve real status codes and a request
// that never answers.
//
// A FEATURE suite: it loads the Preact build from audiobook/player directly.
// These behaviours do not exist in frozen vanilla, so asserting them against
// the staged copy parity.sh builds would fail by construction.
//
// The defects this guards, all from the 2026-08-09 report ("with the screen off
// it stops periodically, and it restarts after I hit pause"):
//
//   1. `playIntent` — the autoplay flag every recovery path passes to
//      loadChapter — was deliberately kept true through an error-induced pause,
//      so recovery could play through it. It was then also kept true through a
//      DELIBERATE pause taken while the element was errored, which is exactly
//      the screen-off case: the pending retry, or the retry on returning to
//      visibility, restarted a book the listener had stopped.
//   2. `pendingPlayAfterLoad` was consumed unconditionally on loadedmetadata,
//      so a pause taken while a slow chapter was loading was overridden the
//      moment the bytes arrived. No error needed.
//   3. A request that hangs fires no `error` at all: the element never reaches
//      loadedmetadata, never plays, never errors. Nothing was watching, and the
//      book simply stopped.
//
// Contract under test:
//   A. while recovery is in flight the transport MEANS stop: it shows the pause
//      glyph, and one tap holds through the whole retry window
//   B. a lock-screen pause during recovery sticks — including across the
//      hidden→visible return, which retries with a fresh cap
//   C. a chapter request that hangs (no error event) is recovered on its own
//      once the network returns
//   D. the stall watchdog never overrides an explicit pause: no reload storm
//      behind a listener who stopped the book
//   E. failures are recorded — with how long the media signature had left,
//      which is the number that explains a 403 nobody was there to see
//   F. a gesture that starts a chapter clears the pause: `userPaused` is what
//      every recovery path consults, so a book restarted from the chapter list
//      while paused must not keep playing with "wants silence" still set — the
//      next stall would refuse to recover it, silently

import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const pwLib = process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright');
const { chromium } = createRequire(import.meta.url)(pwLib);

const outDir = join(here, 'fixture/out');
if (!existsSync(join(outDir, 'index.html'))) execFileSync(join(here, 'fixture/gen.sh'), { stdio: 'inherit' });
// The BUILD, deliberately — see the header.
const player = join(here, '../audiobook/player');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

const PLAY_GLYPH = '▶';        // &#9654;
const PAUSE_GLYPH = '▮▮'; // &#9646;&#9646;
const STALL_MS = 1200;              // production is 15s; see PlayerOptions.stallTimeoutMs

// An ALREADY EXPIRED media signature, encoded exactly as the API encodes it
// (CloudFront's base64: + → -, = → _, / → ~). Injected on the fixture books so
// the diagnostics have a real policy to read an expiry out of.
function cfQuery(expiresAtS) {
  const raw = JSON.stringify({
    Statement: [{ Resource: 'https://books.landry.bot/priv/s/b/*',
                  Condition: { DateLessThan: { 'AWS:EpochTime': expiresAtS } } }],
  });
  const b64 = Buffer.from(raw).toString('base64')
    .replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
  return `Policy=${b64}&Signature=sig&Key-Pair-Id=KID`;
}
const EXPIRED_QUERY = cfQuery(Math.floor(Date.now() / 1000) - 300);

// --- test server: the fixture, with a chapter that can 403 or simply hang ---
const state = { deny2: false, hang2: false, slow2: 0, requests: [] };
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css',
               m4a: 'audio/mp4', json: 'application/json', webmanifest: 'application/json' };
const hung = [];

function serve(req, res, path) {
  const base = path.startsWith('/audiobook/vanilla/')
    ? join(player, path.slice('/audiobook/vanilla/'.length))
    : join(outDir, path === '/' ? 'index.html' : path.slice(1));
  const file = normalize(base);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  const ext = file.split('.').pop();
  const body = readFileSync(file);
  const range = req.headers.range && req.headers.range.match(/bytes=(\d+)-(\d*)/);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = range[2] ? parseInt(range[2], 10) : body.length - 1;
    res.writeHead(206, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream',
                       'accept-ranges': 'bytes', 'content-length': body.length });
  res.end(body);
}

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  state.requests.push(path);
  // Deliberately does NOT close the hung sockets. Destroying them turns the
  // stall into an `error`, which the error path already recovers from — the
  // suite would then pass with no watchdog at all.
  if (path === '/release') { state.hang2 = false; res.end('ok'); return; }

  if (path.endsWith('chapter_0002.m4a')) {
    if (state.deny2) { res.writeHead(403, { 'content-type': 'application/xml' }); res.end('<Error/>'); return; }
    // The screen-off stall: the connection is accepted and then nothing is ever
    // said. No status, no bytes, no error — the element waits forever.
    if (state.hang2) { hung.push(res); return; }
    // Merely slow, which is the more ordinary phone: the bytes DO arrive, well
    // after the listener has given up and pressed pause.
    if (state.slow2) { const d = state.slow2; state.slow2 = 0; setTimeout(() => serve(req, res, path), d); return; }
  }
  serve(req, res, path);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

// A fresh CONTEXT per contract, not just a fresh page: the service worker
// caches chapter audio, and a chapter cached by an earlier contract would be
// served without ever reaching the failure this one needs.
async function freshPage() {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => bad(`page error: ${e.message}`));
  await page.addInitScript(({ stallMs, query }) => {
    // Capture the MediaSession handlers as they are registered, so a test can
    // press the lock-screen buttons — the only control a phone listener with the
    // screen off actually has, and the one this suite is about.
    window.__mediaActions = {};
    const ms = navigator.mediaSession;
    if (ms) {
      const real = ms.setActionHandler.bind(ms);
      ms.setActionHandler = (action, handler) => {
        window.__mediaActions[action] = handler;
        return real(action, handler);
      };
    }
    let held;
    Object.defineProperty(window, 'RepoStoryPlayer', {
      configurable: true,
      get() { return held; },
      set(v) {
        held = Object.assign({}, v, {
          init(cfg) {
            cfg.stallTimeoutMs = stallMs;
            (cfg.books || []).forEach((b) => { b.media_query = query; });
            return v.init(cfg);
          },
        });
      },
    });
  }, { stallMs: STALL_MS, query: EXPIRED_QUERY });
  await page.goto(origin);
  await page.waitForSelector('#book-list .book-item');
  return page;
}

const audioState = (page) => page.evaluate(() => {
  const a = document.querySelector('audio');
  return { paused: a.paused, t: a.currentTime, src: a.currentSrc, err: a.error && a.error.code };
});

async function playFirstChapter(page) {
  await page.click('#book-list .book-item .title');
  await page.waitForSelector('#player-view.active');
  await page.click('#play-btn');
  await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return a && !a.paused && a.currentTime > 0.2;
  }, null, { timeout: 10000 });
}

const chapter2Requests = () => state.requests.filter((p) => p.endsWith('chapter_0002.m4a')).length;

// --- A: while recovering, the transport means stop -------------------------
{
  state.deny2 = true;
  const page = await freshPage();
  await playFirstChapter(page);
  await page.click('#btn-next');
  const errored = await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return !!(a && a.error);
  }, null, { timeout: 8000 }).then(() => true, () => false);
  check(errored, 'A: the denied chapter errors the element');

  // The element is paused because it broke, not because anyone asked. The
  // button must not offer to "play" what is already trying to play.
  const glyph = (await page.textContent('#play-btn')).trim();
  check(glyph === PAUSE_GLYPH,
        `A: the transport shows stop while recovery is in flight (shows "${glyph}")`);

  await page.click('#play-btn');
  // The glyph is painted by the rAF loop, so it changes on the next frame, not
  // on the click. Read it after the frame rather than racing it.
  await page.waitForFunction((glyph) => document.querySelector('#play-btn').textContent.trim() === glyph,
                             PLAY_GLYPH, { timeout: 2000 }).catch(() => {});
  const afterTap = (await page.textContent('#play-btn')).trim();
  check(afterTap === PLAY_GLYPH,
        `A: the tap cancelled the recovery (shows "${afterTap}")`);

  // The denial lifts, which is what a real recovery looks like: the entitlement
  // came back, the radio woke up. A pending retry that survived the tap would
  // now SUCCEED and start playing — that is the reported bug, and it is why
  // this assertion can fail rather than passing on a chapter that stays broken.
  state.deny2 = false;
  const before = chapter2Requests();
  await page.evaluate(() => new Promise((r) => setTimeout(r, 4000)));  // outlast 800+2500+8000
  const s = await audioState(page);
  check(s.paused, 'A: and the book stays stopped when the chapter becomes fetchable again');
  // Nor does it keep working the radio on behalf of someone who stopped it. A
  // paused book prefetches nothing, so any request here is recovery machinery
  // that was left running.
  check(chapter2Requests() === before,
        `A: no fetches are issued behind a stopped book (${chapter2Requests() - before})`);

  // --- E: the failure was recorded, with the signature's remaining life -----
  const diag = await page.evaluate(() => JSON.parse(localStorage.getItem('rs-diag') || '[]'));
  check(diag.length > 0, 'E: the failure was recorded');
  const err = diag.find((d) => d.ev === 'error');
  check(!!err, `E: an error entry exists (${diag.map((d) => d.ev).join(',')})`);
  check(err && err.ch === 2, `E: the entry names the chapter (${err && err.ch})`);
  check(err && typeof err.sigExpiresIn === 'number' && err.sigExpiresIn < 0,
        `E: the entry carries the expired signature's age (${err && err.sigExpiresIn})`);
  check(!JSON.stringify(diag).includes('Signature=') && !JSON.stringify(diag).includes('Policy='),
        'E: the signature itself is never recorded');
  await page.context().close();
}

// --- B: a lock-screen pause outlives recovery, and the return to visibility -
{
  state.deny2 = true;
  const page = await freshPage();
  await playFirstChapter(page);
  await page.click('#btn-next');
  await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return !!(a && a.error);
  }, null, { timeout: 8000 }).catch(() => {});

  const wired = await page.evaluate(() => typeof window.__mediaActions.pause === 'function');
  check(wired, 'B: the lock-screen pause handler is installed');
  await page.evaluate(() => window.__mediaActions.pause());
  // As in A: the chapter becomes fetchable again, so a retry that ignored the
  // pause plays rather than failing quietly.
  state.deny2 = false;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 3500)));
  check((await audioState(page)).paused, 'B: the lock-screen pause survives the retries');

  // Returning to a visible page retries immediately with a FRESH cap — the one
  // path that ignored intent hardest, because it deliberately resets state.
  const before = chapter2Requests();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return new Promise((r) => setTimeout(r, 1500));
  });
  const s = await audioState(page);
  check(s.paused, 'B: coming back to a visible page does not restart a stopped book');
  check(chapter2Requests() === before,
        `B: and does not even refetch it (${chapter2Requests() - before})`);
  await page.context().close();
}

// --- C: a hanging request is recovered once the network returns -------------
{
  state.deny2 = false;
  state.hang2 = true;
  const page = await freshPage();
  await playFirstChapter(page);
  await page.click('#btn-next');

  // Nothing answers, so nothing errors: the old player sat here forever.
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), STALL_MS + 400);
  const stalled = await audioState(page);
  check(!stalled.err, `C: a hanging request produces no error event (code ${stalled.err})`);
  // Request COUNT is no signal here: the player prefetches the next chapter the
  // whole time (a 30s fixture chapter is inside the 45s lead window from its
  // first second), so a hung chapter accumulates requests with nothing watching
  // it. Recovery has to be judged by the outcome below.

  await fetch(`${origin}/release`);
  const recovered = await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return a && /chapter_0002/.test(a.currentSrc) && !a.paused && a.currentTime > 0.1;
  }, null, { timeout: 15000 }).then(() => true, () => false);
  check(recovered, 'C: playback reaches the chapter unattended once the network returns');
  const diag = await page.evaluate(() => JSON.parse(localStorage.getItem('rs-diag') || '[]'));
  check(diag.some((d) => d.ev === 'stall'),
        `C: the stall is recorded as a stall, not an error (${diag.map((d) => d.ev).join(',')})`);

  // …and the watchdog armed by that successful load has to disarm itself on
  // progress. Left armed, it reloads a chapter that is playing perfectly well
  // and yanks the position back every few seconds.
  const stalls = diag.filter((d) => d.ev === 'stall').length;
  const t1 = (await audioState(page)).t;
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), STALL_MS * 2);
  const after = await audioState(page);
  const diag2 = await page.evaluate(() => JSON.parse(localStorage.getItem('rs-diag') || '[]'));
  check(after.t > t1 && !after.paused, `C: playback keeps advancing (${t1} → ${after.t})`);
  check(diag2.filter((d) => d.ev === 'stall').length === stalls,
        'C: advancing playback is never mistaken for a stall');
  await page.context().close();
}

// --- D: an explicit pause outranks the watchdog ----------------------------
{
  state.deny2 = false;
  state.hang2 = true;
  const page = await freshPage();
  await playFirstChapter(page);
  await page.click('#btn-next');
  await page.evaluate(() => window.__mediaActions.pause());
  const before = chapter2Requests();
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), STALL_MS * 3);
  const s = await audioState(page);
  check(s.paused, 'D: the watchdog leaves a stopped book stopped');
  check(chapter2Requests() === before,
        `D: and reloads nothing behind it (${chapter2Requests() - before} reloads)`);

  await page.context().close();
}

// --- D2: bytes that arrive after the pause do not play themselves -----------
// The other restart-after-pause path, and the one that needs no error at all:
// the pause lands while a chapter is still loading, so an autoplay is pending on
// it. A merely SLOW chapter (not a hung one) is what makes the load complete
// behind the listener's back.
{
  state.deny2 = false;
  state.hang2 = false;
  const page = await freshPage();
  await playFirstChapter(page);
  state.slow2 = 2500;
  await page.click('#btn-next');
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const midLoad = await audioState(page);
  check(midLoad.paused, 'D2: the slow chapter has not started yet');
  await page.evaluate(() => window.__mediaActions.pause());
  // Outlast the response and the metadata that follows it.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 4000)));
  const s2 = await audioState(page);
  check(s2.paused, 'D2: a chapter that arrives after the pause does not play itself');
  await page.context().close();
}

// --- F: starting a chapter by hand re-arms recovery -------------------------
{
  state.deny2 = false;
  state.hang2 = false;
  const page = await freshPage();
  await playFirstChapter(page);
  await page.evaluate(() => window.__mediaActions.pause());
  check((await audioState(page)).paused, 'F: the book is stopped to begin with');

  // Tapping a chapter in the list is a request for sound, wherever the transport
  // was left.
  await page.click('#chapter-list li');
  const resumed = await page.waitForFunction(() => {
    const a = document.querySelector('audio');
    return a && !a.paused && a.currentTime > 0.1;
  }, null, { timeout: 8000 }).then(() => true, () => false);
  check(resumed, 'F: the tapped chapter plays');

  // …and recovery works again afterwards. With the pause still set internally,
  // the watchdog would decline and nothing would be recorded.
  state.hang2 = true;
  await page.click('#btn-next');
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), STALL_MS * 2);
  const diag = await page.evaluate(() => JSON.parse(localStorage.getItem('rs-diag') || '[]'));
  check(diag.some((d) => d.ev === 'stall'),
        `F: a stall after a hand-started chapter is still recovered (${diag.map((d) => d.ev).join(',') || 'nothing recorded'})`);
  await page.context().close();
}

await fetch(`${origin}/release`).catch(() => {});
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
