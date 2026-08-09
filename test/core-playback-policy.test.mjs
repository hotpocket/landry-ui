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
//   STALL (2026-08-09)
//   J. a wanted chapter that never arrives is recovered — the failure with no
//      `error` event, which nothing was watching
//   K. an explicit pause is never overridden
//   L. the scene-break hold is not mistaken for a stall (it looks identical:
//      playing, then silent, then not advancing)
//   M. an element that has the data is left alone — reloading would yank the
//      position backwards to fix nothing
//   N. a chapter that merely advanced slowly is not a stall
//   O. nothing is recovered that nobody asked to play

import assert from 'node:assert';
import { test } from 'node:test';
import {
  RETRY_MAX, retryDelayMs, shouldRetry,
  PREFETCH_LEAD_S, prefetchKey, shouldPrefetch,
  STALL_TIMEOUT_MS, shouldRecoverFromStall,
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

// A stalled load: playback was asked for, the element has no data, and the
// clock has not moved since the watchdog armed.
const stalled = {
  playIntent: true,
  userPaused: false,
  scenePauseHolding: false,
  ended: false,
  advanced: false,
  canPlayThrough: false,
};

test('J. a wanted chapter that never arrives is recovered', () => {
  assert.equal(shouldRecoverFromStall(stalled), true);
  // The production wait is long enough that a slow phone on a slow radio is
  // given a real chance before the position is disturbed.
  assert.ok(STALL_TIMEOUT_MS >= 10000, `stall timeout is patient (${STALL_TIMEOUT_MS}ms)`);
});

test('K. an explicit pause is never overridden', () => {
  assert.equal(shouldRecoverFromStall({ ...stalled, userPaused: true }), false);
});

test('L. a scene-break hold is not a stall', () => {
  assert.equal(shouldRecoverFromStall({ ...stalled, scenePauseHolding: true }), false);
});

test('M. an element holding data is left alone', () => {
  assert.equal(shouldRecoverFromStall({ ...stalled, canPlayThrough: true }), false);
});

test('N. slow is not stalled', () => {
  assert.equal(shouldRecoverFromStall({ ...stalled, advanced: true }), false);
});

test('O. nothing plays that nobody asked for', () => {
  assert.equal(shouldRecoverFromStall({ ...stalled, playIntent: false }), false);
  // The chapter finished: onChapterEnded owns what happens next, and a stall
  // recovery here would reload the chapter that just ended.
  assert.equal(shouldRecoverFromStall({ ...stalled, ended: true }), false);
});
