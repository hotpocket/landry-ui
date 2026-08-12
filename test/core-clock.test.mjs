// core-clock.test.mjs — the book clock, in isolation.
//
// Run: node test/core-clock.test.mjs
// No browser, no build: node strips the .ts types natively.
//
// The vanilla player computes book-relative time from four entangled
// module-level vars (summaryMode, summaryStarts, summaryTotal, currentBook).
// That entanglement is exactly what the port removes, so the clock has to be
// correct as a pure function of (book, mode) before any view exists.
//
// Contract under test:
//   A. a chapter's start on the full clock is its own `start`
//   B. a chapter's duration falls back to end - start when `duration` is absent
//   C. in summary mode a chapter's duration is its summary track's duration
//   D. summary starts are the running sum of summary durations, NOT the full
//      ones — this is the whole reason positions do not map between clocks
//   E. a chapter with no summary track keeps its full duration on the summary
//      clock, so a partially-summarized book still has a monotonic clock
//   F. book duration is the sum of the active clock's durations
//   G. findChapterIdxAt is a boundary-inclusive binary search: a time exactly
//      on a chapter start belongs to that chapter, not the one before it
//   H. findChapterIdxAt clamps rather than throwing outside the book
//   I. bookHasSummaries is true when ANY chapter carries one — the toggle is
//      offered for partially-summarized books
//   J. nonPositionalChapterId names the first chapter whose `id` is not its
//      position. The whole player indexes by `ch.id` — summary starts here, and
//      the chapter rows, progress bars and transcript ids in the engine — so
//      `id === position` is a load-bearing invariant that nothing enforced. A
//      manifest that breaks it seeks to the wrong place and says nothing.

import assert from 'node:assert';
import { test } from 'node:test';
import {
  chapterStart, chapterDuration, summaryStarts, bookDuration,
  findChapterIdxAt, bookHasSummaries, nonPositionalChapterId,
} from '../audiobook/player-src/src/core/clock.ts';

// Three chapters, 10/20/30s full. Chapter 2 has no summary track.
const book = {
  chapters: [
    { id: 0, start: 0,  end: 10, duration: 10, summary: { duration: 4 } },
    { id: 1, start: 10, end: 30, duration: 20 },
    { id: 2, start: 30, end: 60, duration: 30, summary: { duration: 6 } },
  ],
  duration: 60,
};

// A book whose chapters carry no explicit duration, only start/end.
const spans = {
  chapters: [
    { id: 0, start: 0, end: 10 },
    { id: 1, start: 10, end: 25 },
  ],
  duration: 25,
};

test('A. full-clock chapter start is the chapter start', () => {
  assert.equal(chapterStart(book, book.chapters[1], false), 10);
  assert.equal(chapterStart(book, book.chapters[2], false), 30);
});

test('A2. summary-clock chapter start is the summary start, not the full one', () => {
  // Caught by mutation: dropping chapterStart's summary branch left every other
  // assertion green, because D and G2 reach the summary starts by other paths.
  assert.equal(chapterStart(book, book.chapters[1], true), 4);
  assert.equal(chapterStart(book, book.chapters[2], true), 24);
});

test('B. duration falls back to end - start', () => {
  assert.equal(chapterDuration(spans.chapters[1], false), 15);
});

test('C. summary mode uses the summary track duration', () => {
  assert.equal(chapterDuration(book.chapters[0], true), 4);
  assert.equal(chapterDuration(book.chapters[0], false), 10);
});

test('D. summary starts accumulate summary durations, not full ones', () => {
  // 4 (ch0 summary) then 20 (ch1 has no summary) → ch2 starts at 24.
  assert.deepEqual(summaryStarts(book), [0, 4, 24]);
});

test('E. an unsummarized chapter keeps its full duration on the summary clock', () => {
  assert.equal(chapterDuration(book.chapters[1], true), 20);
});

test('F. book duration is the active clock total', () => {
  assert.equal(bookDuration(book, false), 60);
  assert.equal(bookDuration(book, true), 4 + 20 + 6);
});

test('G. a time exactly on a boundary belongs to the later chapter', () => {
  assert.equal(findChapterIdxAt(book, 10, false), 1);
  assert.equal(findChapterIdxAt(book, 9.999, false), 0);
  assert.equal(findChapterIdxAt(book, 30, false), 2);
});

test('G2. boundaries follow the summary clock in summary mode', () => {
  // On the summary clock ch1 starts at 4, ch2 at 24.
  assert.equal(findChapterIdxAt(book, 4, true), 1);
  assert.equal(findChapterIdxAt(book, 23.9, true), 1);
  assert.equal(findChapterIdxAt(book, 24, true), 2);
});

test('H. out-of-range times clamp to the first/last chapter', () => {
  assert.equal(findChapterIdxAt(book, -50, false), 0);
  assert.equal(findChapterIdxAt(book, 1e9, false), 2);
});

test('I. a partially-summarized book still offers the toggle', () => {
  assert.equal(bookHasSummaries(book), true);
  assert.equal(bookHasSummaries(spans), false);
  assert.equal(bookHasSummaries(null), false);
});

test('J. a non-positional chapter id is named, and a correct book is not', () => {
  assert.equal(nonPositionalChapterId(book), -1);
  assert.equal(nonPositionalChapterId(spans), -1);

  // One-based ids, the likeliest way a manifest producer gets this wrong.
  const oneBased = { ...book, chapters: book.chapters.map((c, i) => ({ ...c, id: i + 1 })) };
  assert.equal(nonPositionalChapterId(oneBased), 0, 'a 1-based manifest is not flagged');

  // And a book that is right until it is not: only the first offender is named,
  // because one warning per book is the point, not one per chapter.
  const late = { ...book, chapters: book.chapters.map((c, i) => ({ ...c, id: i === 2 ? 9 : i })) };
  assert.equal(nonPositionalChapterId(late), 2);

  assert.equal(nonPositionalChapterId(null), -1, 'no book is not a broken book');
  assert.equal(nonPositionalChapterId({ chapters: [] }), -1);
});

test('J2. the invariant J guards is the one chapterStart actually relies on', () => {
  // Without this, J is a test of a predicate nobody needs. A 1-based manifest
  // must really seek to the wrong place on the summary clock.
  const oneBased = { ...book, chapters: book.chapters.map((c, i) => ({ ...c, id: i + 1 })) };
  const ch0 = oneBased.chapters[0];
  assert.equal(chapterStart(book, book.chapters[0], true), 0);
  assert.notEqual(chapterStart(oneBased, ch0, true), 0,
                  'a 1-based id read as a position would have to be harmless for J to be pointless');
});
