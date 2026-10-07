// transcript-header-wrap.test.mjs — the header's controls wrap as one unit.
//
// Run: node test/transcript-header-wrap.test.mjs
// A FEATURE suite: loads the Preact build from audiobook/player directly.
//
// Reported from an Android phone (~412px) on books.landry.bot: the header read
// "TRANSCRIPT · Last updated: Sep 28, 2026, 10:40 PM PDT · A− · A+ · FOLLOW ·
// READ", and it wrapped item by item — A− stayed up beside the date, A+ FOLLOW
// READ dropped to the next line, and the text-size pair was split across rows.
//
// The header was one flat flex-wrap row, so any item could be the one to wrap.
// The rule: the heading + dates are one unit, the controls another; the controls
// never split, and if the row must break it breaks between the two units.
//
// Contract under test:
//   A. A−, A+, follow and read share one row at every width, in both modes
//   B. reading mode's prev/play/next share one row too; they join A−..read on a
//      single row from 412px, and below that (seven buttons do not fit) the
//      one break allowed is between the two groups
//   C. no status element (heading, dates) shares a row with a control once the
//      header breaks — it breaks between the units
//   D. every control is fully on screen
//   E. on a wide screen the whole header is still a single row

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
// PW_ENGINE=webkit runs it in Safari's engine (point PLAYWRIGHT_BROWSERS_PATH
// at ~/.cache/iphone-webkit); the report came from a phone, and wrapping is
// layout the engines are free to disagree on.
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright'));
const engine = pw[process.env.PW_ENGINE || 'chromium'];
const fixture = join(here, 'fixture/out');
if (!existsSync(join(fixture, 'audio/chapter_0001.m4a'))) execFileSync(join(here, 'fixture/gen.sh'));

const chapters = [1, 2].map((n, id) => ({ n, id, title: `Chapter ${n}`, filename: 'chapter_0001.m4a', start: id * 30, end: (id + 1) * 30, duration: 30 }));
const books = [{ slug: 'b', title: 'B', duration: 60, chapters }];
const chunks = [{ index: 0, text: 'Full text', start: 0, end: 30 }];
// Chapter 1 as reported: an update time and no source link. Chapter 2 has both,
// the widest the status unit gets.
const transcripts = { books: [{ slug: 'b', chapters: [
  { n: 1, index: 1, chunks, last_updated: '2026-09-29T05:40:00Z' },
  { n: 2, index: 2, chunks, last_updated: '2026-09-29T05:40:00Z', source_date: '2020-10-19', source_url: 'https://example.com/original' },
] }] };
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${readFileSync(join(player, 'player.css'))}</style><div id="mount"></div><script>${readFileSync(join(player, 'player.js'))}</script><script>RepoStoryPlayer.init({container:document.getElementById('mount'),books:${JSON.stringify(books)},transcriptUrl:'data:application/json;base64,${Buffer.from(JSON.stringify(transcripts)).toString('base64')}',audioBaseUrl:'/audio/'});</script>`;
const server = createServer((req, res) => {
  if (req.url.startsWith('/audio/')) { res.writeHead(200, { 'content-type': 'audio/mp4' }); res.end(readFileSync(join(fixture, req.url.split('?')[0]))); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// Rows by vertical centre: a 2px tolerance absorbs the buttons' differing font
// sizes, and is far below a line height, so a wrap can never hide inside it.
const layout = (page) => page.evaluate(() => {
  const h = document.querySelector('.transcript-panel-header');
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const box = (el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.tagName, mid: (r.top + r.bottom) / 2, left: r.left, right: r.right }; };
  return {
    controls: [...h.querySelectorAll('button')].filter(shown).map(box),
    status: [...h.querySelectorAll('h3, #source-link, #last-updated')].filter(shown).map(box),
  };
});
const sameRow = (a, b) => Math.abs(a.mid - b.mid) <= 2;

const browser = await engine.launch();
let pass = 0;
try {
  // A sweep, not one width: where the header breaks depends on the host's
  // gutters and the date's length, so the reported 412px is only a sample.
  // Every width from 320 to 700 passes through each possible break point.
  for (const ch of [1, 2]) {
    for (const reading of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 700, height: 844 }, timezoneId: 'America/Los_Angeles' });
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/#/b/${ch}`);
      await page.waitForFunction(() => document.querySelector('#last-updated')?.textContent.includes('Last updated'));
      if (reading) await page.click('#reading-btn');
      for (let width = +(process.env.MINW||320); width <= 700; width += 4) {
        const tag = `${width}px ch${ch}${reading ? ' reading' : ''}`;
        await page.setViewportSize({ width, height: 844 });
        if (process.env.SCREENSHOT_DIR && [360, 412].includes(width)) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `header-${width}-ch${ch}${reading ? '-reading' : ''}.png`), clip: { x: 0, y: 200, width, height: 260 } });
        const { controls, status } = await layout(page);
        assert.ok(controls.length >= 4, `${tag}: found the controls (${controls.length})`);
        const view = controls.filter((c) => !c.id.startsWith('mini-'));
        const transport = controls.filter((c) => c.id.startsWith('mini-'));
        assert.equal(view.length, 4, `${tag}: A−, A+, follow, read all shown`);
        assert.equal(transport.length, reading ? 3 : 0, `${tag}: transport shown in reading mode only`);
        const split = (group) => group.filter((c) => !sameRow(c, group[0])).map((c) => c.id);
        assert.deepEqual(split(view), [], `A ${tag}: A−..read split across rows`);
        if (reading) {
          assert.deepEqual(split(transport), [], `B ${tag}: prev/play/next split across rows`);
          if (width >= 412) assert.deepEqual(split(controls), [], `B ${tag}: controls on more than one row at a phone width`);
        }
        if (status.some((s) => !sameRow(s, view[0]))) {
          const mixed = status.filter((s) => controls.some((c) => sameRow(s, c))).map((s) => s.id);
          assert.deepEqual(mixed, [], `C ${tag}: status sharing a row with the controls after a break`);
        }
        const out = controls.filter((c) => c.left < 0 || c.right > width).map((c) => c.id);
        assert.deepEqual(out, [], `D ${tag}: controls off screen`);
        pass++;
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, timezoneId: 'America/Los_Angeles' });
  await page.goto(`http://127.0.0.1:${server.address().port}/#/b/2`);
  await page.waitForFunction(() => document.querySelector('#last-updated')?.textContent.includes('Last updated'));
  const { controls, status } = await layout(page);
  const rows = new Set([...controls, ...status].map((b) => Math.round(b.mid / 5)));
  assert.ok([...controls, ...status].every((b) => sameRow(b, controls[0])), `E: wide header is one row — ${JSON.stringify([...controls, ...status])}`); pass++;
  console.log(`${pass} passed, 0 failed`);
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
