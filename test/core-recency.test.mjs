// core-recency.test.mjs — which chapters are new.
//
// Run: node test/core-recency.test.mjs
//
// wbt lands chapters a couple at a time on an hourly sync, so "what arrived
// since I last looked" is the most useful thing the chapter list can say. The
// date is recorded by chatterbook's manifest writer at first sight and carried
// forward forever, so it is stable — a re-encode does not make a chapter new
// again.
//
// Contract under test:
//   A. a chapter added within the window is new
//   B. a chapter older than the window is not
//   C. the boundary is exclusive at the far edge, so "new for 7 days" does not
//      quietly mean 8
//   D. a chapter with NO date is not new — books published before the field
//      existed must not all light up at once
//   E. an unparseable date is not new, and does not throw inside a render loop
//   F. a future date (clock skew on a build machine) is still new rather than
//      negative-aged into nothing

import assert from 'node:assert';
import { test } from 'node:test';
import { isRecent, NEW_WINDOW_DAYS } from '../audiobook/player-src/src/core/recency.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-08-07T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

test('A. inside the window is new', () => {
  assert.equal(isRecent(iso(now - DAY), now), true);
});

test('B. outside the window is not', () => {
  assert.equal(isRecent(iso(now - (NEW_WINDOW_DAYS + 1) * DAY), now), false);
});

test('C. the far edge is exclusive', () => {
  assert.equal(isRecent(iso(now - (NEW_WINDOW_DAYS * DAY - 1000)), now), true);
  assert.equal(isRecent(iso(now - NEW_WINDOW_DAYS * DAY - 1000), now), false);
  // Exactly on the boundary. Without this, < and <= were indistinguishable and
  // "new for 7 days" could quietly have meant 8.
  assert.equal(isRecent(iso(now - NEW_WINDOW_DAYS * DAY), now), false);
});

test('D. no date is not new', () => {
  assert.equal(isRecent(undefined, now), false);
  assert.equal(isRecent(null, now), false);
  assert.equal(isRecent('', now), false);
});

test('E. an unparseable date is not new, and does not throw', () => {
  assert.equal(isRecent('not a date', now), false);
  assert.equal(isRecent('2026-13-45T99:99:99Z', now), false);
});

test('F. a future date is new, not negative-aged', () => {
  assert.equal(isRecent(iso(now + DAY), now), true);
});
