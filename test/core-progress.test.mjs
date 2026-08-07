// core-progress.test.mjs — where you left off survives a reload.
//
// Run: node test/core-progress.test.mjs
//
// Progress is the one piece of player state a user notices being wrong. It is
// written from a rAF loop on a phone that can be killed mid-write, and it has
// already changed format once, so both halves of that matter: a corrupt or
// legacy record must degrade to "start of book" rather than throwing inside
// the render loop.
//
// Storage is injected rather than reached for, so this runs in node.
//
// Contract under test:
//   A. an absent record reads as the start of the book, not undefined
//   B. corrupt JSON reads as the start of the book — a throw here would take
//      the render loop down with it
//   C. the legacy `time` field is read as bookTime (format changed once)
//   D. an explicit bookTime wins over a legacy `time` if both are present
//   E. a written record round-trips through the reader
//   F. writing progress also records which book was last open
//   G. progress fraction is bookTime/duration, clamped to 0..1 — a duration of
//      0 must not produce NaN or Infinity in the stored record
//   H. records are per book index; writing one does not disturb another
//   I. the summary flag rides with the record, because positions do not map
//      between clocks and restoring the wrong one lands in the wrong place

import assert from 'node:assert';
import { test } from 'node:test';
import {
  readProgress, writeProgress, readLastBook, ZERO,
} from '../audiobook/player-src/src/core/progress.ts';

function fakeStore(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    dump: () => Object.fromEntries(m),
  };
}

test('A. an absent record reads as the start of the book', () => {
  assert.deepEqual(readProgress(fakeStore(), 0), ZERO);
});

test('B. corrupt JSON reads as the start of the book', () => {
  const s = fakeStore({ 'rs-progress-0': '{not json' });
  assert.deepEqual(readProgress(s, 0), ZERO);
});

test('C. the legacy `time` field is read as bookTime', () => {
  const s = fakeStore({ 'rs-progress-2': JSON.stringify({ time: 123, progress: 0.5 }) });
  assert.equal(readProgress(s, 2).bookTime, 123);
});

test('D. an explicit bookTime wins over a legacy `time`', () => {
  const s = fakeStore({ 'rs-progress-2': JSON.stringify({ time: 123, bookTime: 456 }) });
  assert.equal(readProgress(s, 2).bookTime, 456);
});

test('E. a written record round-trips', () => {
  const s = fakeStore();
  writeProgress(s, 1, { bookTime: 90, duration: 300, chapterIdx: 2, chapterN: 3, timeInChapter: 30, summary: false });
  const p = readProgress(s, 1);
  assert.equal(p.bookTime, 90);
  assert.equal(p.chapterIdx, 2);
  assert.equal(p.chapterN, 3);
  assert.equal(p.timeInChapter, 30);
});

test('F. writing progress records the last open book', () => {
  const s = fakeStore();
  writeProgress(s, 4, { bookTime: 1, duration: 10, chapterIdx: 0, chapterN: 1, timeInChapter: 1, summary: false });
  assert.equal(readLastBook(s), 4);
});

test('F2. last book is null when nothing has been opened', () => {
  assert.equal(readLastBook(fakeStore()), null);
});

test('G. progress is a clamped fraction and never NaN', () => {
  const s = fakeStore();
  writeProgress(s, 0, { bookTime: 150, duration: 300, chapterIdx: 0, chapterN: 1, timeInChapter: 0, summary: false });
  assert.equal(readProgress(s, 0).progress, 0.5);

  // A book whose manifest has not loaded yet has duration 0. Clamping alone
  // turns that into Infinity → 1, i.e. "finished" — so this asserts the exact
  // value, not merely that it is finite and in range. Mutation caught the weak
  // version passing while an unloaded book displayed as 100% complete.
  writeProgress(s, 1, { bookTime: 5, duration: 0, chapterIdx: 0, chapterN: 1, timeInChapter: 0, summary: false });
  assert.equal(readProgress(s, 1).progress, 0);

  // NaN survives Math.max/Math.min unchanged, so it needs its own assertion.
  writeProgress(s, 3, { bookTime: NaN, duration: 300, chapterIdx: 0, chapterN: 1, timeInChapter: 0, summary: false });
  assert.equal(readProgress(s, 3).progress, 0);

  writeProgress(s, 2, { bookTime: 400, duration: 300, chapterIdx: 0, chapterN: 1, timeInChapter: 0, summary: false });
  assert.equal(readProgress(s, 2).progress, 1);
});

test('H. records are per book index', () => {
  const s = fakeStore();
  writeProgress(s, 0, { bookTime: 10, duration: 100, chapterIdx: 0, chapterN: 1, timeInChapter: 10, summary: false });
  writeProgress(s, 1, { bookTime: 20, duration: 100, chapterIdx: 1, chapterN: 2, timeInChapter: 20, summary: false });
  assert.equal(readProgress(s, 0).bookTime, 10);
  assert.equal(readProgress(s, 1).bookTime, 20);
});

test('I. the summary flag rides with the record', () => {
  const s = fakeStore();
  writeProgress(s, 0, { bookTime: 10, duration: 100, chapterIdx: 0, chapterN: 1, timeInChapter: 10, summary: true });
  assert.equal(readProgress(s, 0).summary, true);
});
