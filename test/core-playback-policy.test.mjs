// core-playback-policy.test.mjs — the two policies that keep a book playing
// with the screen off.
//
// Run: node test/core-playback-policy.test.mjs
//
// Both encode fixes from 2026-08-03. Every chapter boundary is a fresh network
// fetch, usually while the page is inaudible and easiest for a phone to
// suspend, sometimes with lapsed entitlement cookies. Retry keeps a failed
// fetch from silently ending the book; prefetch means the boundary needs no
// network at the exact moment the phone is least willing to do any.
//
// Contract under test:
//   RETRY
//   A. attempts are capped — an offline phone must not spin forever
//   B. delays back off rather than hammering
//   C. an attempt past the table reuses the last delay instead of undefined
//   PREFETCH
//   D. no prefetch while paused — a paused book is not approaching a boundary
//   E. no prefetch on the last chapter
//   F. no prefetch until within the lead window
//   G. prefetch once inside the lead window
//   H. the key distinguishes book, chapter AND mode, so switching to summary
//      re-prefetches rather than reusing the full track's entry
//   I. an unchanged key does not prefetch twice

import assert from 'node:assert';
import { test } from 'node:test';
import {
  RETRY_MAX, retryDelayMs, shouldRetry,
  PREFETCH_LEAD_S, prefetchKey, shouldPrefetch,
} from '../audiobook/player-src/src/core/playback-policy.ts';

test('A. retries are capped', () => {
  assert.equal(shouldRetry(0), true);
  assert.equal(shouldRetry(RETRY_MAX - 1), true);
  assert.equal(shouldRetry(RETRY_MAX), false);
  assert.equal(shouldRetry(RETRY_MAX + 5), false);
});

test('B. delays back off', () => {
  const d = [0, 1, 2].map(retryDelayMs);
  assert.ok(d[0] < d[1] && d[1] < d[2], `not increasing: ${d}`);
  assert.ok(d[0] > 0);
});

test('C. an attempt past the table reuses the last delay', () => {
  assert.equal(retryDelayMs(99), retryDelayMs(2));
  assert.ok(Number.isFinite(retryDelayMs(99)));
});

const base = {
  paused: false,
  chapterIdx: 0,
  chapterCount: 5,
  chapterDuration: 600,
  currentTime: 600 - PREFETCH_LEAD_S,
  key: 'k',
  lastKey: null,
};

test('D. a paused book does not prefetch', () => {
  assert.equal(shouldPrefetch({ ...base, paused: true }), false);
});

test('E. the last chapter does not prefetch', () => {
  assert.equal(shouldPrefetch({ ...base, chapterIdx: 4, chapterCount: 5 }), false);
});

test('F. no prefetch before the lead window', () => {
  assert.equal(shouldPrefetch({ ...base, currentTime: 600 - PREFETCH_LEAD_S - 1 }), false);
});

test('G. prefetch inside the lead window', () => {
  assert.equal(shouldPrefetch(base), true);
  assert.equal(shouldPrefetch({ ...base, currentTime: 599 }), true);
});

test('H. the key distinguishes book, chapter and mode', () => {
  assert.notEqual(prefetchKey(0, 1, false), prefetchKey(0, 1, true));
  assert.notEqual(prefetchKey(0, 1, false), prefetchKey(1, 1, false));
  assert.notEqual(prefetchKey(0, 1, false), prefetchKey(0, 2, false));
  assert.equal(prefetchKey(0, 1, false), prefetchKey(0, 1, false));
});

test('I. an unchanged key does not prefetch twice', () => {
  assert.equal(shouldPrefetch({ ...base, lastKey: 'k' }), false);
  assert.equal(shouldPrefetch({ ...base, lastKey: 'other' }), true);
});
