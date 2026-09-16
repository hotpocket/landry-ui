// core-progress.test.mjs — where you left off survives a reload, AND a library
// that changed shape underneath it.
//
// Run: node --test test/core-progress.test.mjs
//
// Progress is the one piece of player state a user notices being wrong. It is
// written from a rAF loop on a phone that can be killed mid-write, and it has
// already changed format once, so both halves of that matter: a corrupt or
// legacy record must degrade to "start of book" rather than throwing inside
// the render loop.
//
// It was also keyed by LIBRARY INDEX until 2026-09-16, which meant every
// saved position was really a bookmark in a list — add, remove or reorder a
// book and every position moved to a different book. The key is now the book's
// own id, and the index-keyed records that exist on real devices are migrated
// on the first start that knows the library.
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
//   F. writing progress also records which book was last open, as an ID
//   G. progress fraction is bookTime/duration, clamped to 0..1 — a duration of
//      0 must not produce NaN or Infinity in the stored record
//   H. records are per book ID; writing one does not disturb another
//   I. the summary flag rides with the record, because positions do not map
//      between clocks and restoring the wrong one lands in the wrong place
//   J. a record is found under its own id and under no other
//   K. reordering the library moves nobody's position — the assertion the
//      index-keyed version could not pass
//   L. the record names its own book, so one found under any key can be
//      attributed
//   M. a book with no saved progress opens at chapter 0 (preserved behaviour)
//   N. migration: legacy index keys become id keys and the legacy keys go
//   O. migration is idempotent — a second run changes nothing
//   P. a legacy index with no book in the current library is deleted, not
//      migrated onto some other book
//   Q. migration never overwrites a record already stored under an id key
//   R. a book whose id is a decimal integer produces a key that LOOKS legacy;
//      migration must not eat it
//   S. a store whose every accessor throws takes nothing down with it, and
//      progress reads as none — iOS Safari with "Block All Cookies" throws
//   T. safeStore survives a storage GETTER that throws, which is the shape
//      that blanked books.landry.bot on iOS: naming the identifier is the throw

import assert from 'node:assert';
import { test } from 'node:test';
import {
  readProgress, writeProgress, readLastBookId, clearLastBook,
  migrateLegacyProgress, safeStore, ZERO,
} from '../audiobook/player-src/src/core/progress.ts';
import { bookId } from '../audiobook/player-src/src/core/routing.ts';
import { findChapterIdxAt } from '../audiobook/player-src/src/core/clock.ts';

function fakeStore(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

/** Every accessor throws, the way a privacy-locked browser's storage does. */
function hostileStore() {
  const boom = () => { throw new Error('The operation is insecure.'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

const snap = (bookTime, over = {}) => ({
  bookTime, duration: 1000, chapterIdx: 0, chapterN: 1, timeInChapter: 0, summary: false, ...over,
});

test('A. an absent record reads as the start of the book', () => {
  assert.deepEqual(readProgress(fakeStore(), 'alpha'), ZERO);
});

test('B. corrupt JSON reads as the start of the book', () => {
  const s = fakeStore({ 'rs-progress-alpha': '{not json' });
  assert.deepEqual(readProgress(s, 'alpha'), ZERO);
});

test('C. the legacy `time` field is read as bookTime', () => {
  const s = fakeStore({ 'rs-progress-alpha': JSON.stringify({ time: 123, progress: 0.5 }) });
  assert.equal(readProgress(s, 'alpha').bookTime, 123);
});

test('D. an explicit bookTime wins over a legacy `time`', () => {
  const s = fakeStore({ 'rs-progress-alpha': JSON.stringify({ time: 123, bookTime: 456 }) });
  assert.equal(readProgress(s, 'alpha').bookTime, 456);
});

test('E. a written record round-trips', () => {
  const s = fakeStore();
  writeProgress(s, 'alpha', snap(90, { duration: 300, chapterIdx: 2, chapterN: 3, timeInChapter: 30 }));
  const p = readProgress(s, 'alpha');
  assert.equal(p.bookTime, 90);
  assert.equal(p.chapterIdx, 2);
  assert.equal(p.chapterN, 3);
  assert.equal(p.timeInChapter, 30);
});

test('F. writing progress records the last open book by id', () => {
  const s = fakeStore();
  writeProgress(s, 'beta', snap(1, { duration: 10 }));
  assert.equal(readLastBookId(s), 'beta');
  assert.equal(s.dump()['rs-last-book-id'], 'beta');
});

test('F2. last book is null when nothing has been opened', () => {
  assert.equal(readLastBookId(fakeStore()), null);
});

test('F3. clearing the last book reads back as none', () => {
  const s = fakeStore();
  writeProgress(s, 'beta', snap(1, { duration: 10 }));
  clearLastBook(s);
  assert.equal(readLastBookId(s), null);
});

test('G. progress is a clamped fraction and never NaN', () => {
  const s = fakeStore();
  writeProgress(s, 'a', snap(150, { duration: 300 }));
  assert.equal(readProgress(s, 'a').progress, 0.5);

  // A book whose manifest has not loaded yet has duration 0. Clamping alone
  // turns that into Infinity → 1, i.e. "finished" — so this asserts the exact
  // value, not merely that it is finite and in range. Mutation caught the weak
  // version passing while an unloaded book displayed as 100% complete.
  writeProgress(s, 'b', snap(5, { duration: 0 }));
  assert.equal(readProgress(s, 'b').progress, 0);

  // NaN survives Math.max/Math.min unchanged, so it needs its own assertion.
  writeProgress(s, 'c', snap(NaN, { duration: 300 }));
  assert.equal(readProgress(s, 'c').progress, 0);

  writeProgress(s, 'd', snap(400, { duration: 300 }));
  assert.equal(readProgress(s, 'd').progress, 1);
});

test('H. records are per book id', () => {
  const s = fakeStore();
  writeProgress(s, 'alpha', snap(10, { duration: 100, timeInChapter: 10 }));
  writeProgress(s, 'beta', snap(20, { duration: 100, chapterIdx: 1, chapterN: 2, timeInChapter: 20 }));
  assert.equal(readProgress(s, 'alpha').bookTime, 10);
  assert.equal(readProgress(s, 'beta').bookTime, 20);
});

test('I. the summary flag rides with the record', () => {
  const s = fakeStore();
  writeProgress(s, 'alpha', snap(10, { duration: 100, timeInChapter: 10, summary: true }));
  assert.equal(readProgress(s, 'alpha').summary, true);
});

test('J. a record is found under its own id and under no other', () => {
  const s = fakeStore();
  writeProgress(s, 'alpha', snap(42));
  assert.equal(readProgress(s, 'alpha').bookTime, 42);
  assert.deepEqual(readProgress(s, 'beta'), ZERO);
  assert.equal(s.dump()['rs-progress-alpha'] !== undefined, true, 'stored under rs-progress-<id>');
});

test('K. reordering the library moves nobody\'s position', () => {
  // This is the whole defect in five lines. The player persists for the book
  // it has open and resumes the book the reader picks; between those two the
  // library was rebuilt in a different order, which is what the API does
  // whenever a book is added, removed, renamed or re-sorted.
  const s = fakeStore();
  const before = [{ slug: 'alpha' }, { slug: 'beta' }, { slug: 'gamma' }];
  for (const [i, b] of before.entries()) writeProgress(s, bookId(b), snap((i + 1) * 100));

  const after = [{ slug: 'gamma' }, { slug: 'alpha' }, { slug: 'beta' }];
  assert.equal(readProgress(s, bookId(after[0])).bookTime, 300, 'gamma keeps 300');
  assert.equal(readProgress(s, bookId(after[1])).bookTime, 100, 'alpha keeps 100');
  assert.equal(readProgress(s, bookId(after[2])).bookTime, 200, 'beta keeps 200');
});

test('K2. a book id is the immutable book_id when the host supplies one', () => {
  // books.landry.bot's /api/library hands the player `book_id` and mirrors it
  // into `slug`; a host with no book_id falls back to the URL slug, which is
  // the only stable name such a library has.
  assert.equal(bookId({ book_id: '01J8XYZ', slug: 'renamed-later', title: 'T' }), '01J8XYZ');
  assert.equal(bookId({ slug: 'plain-book', title: 'Plain Book' }), 'plain-book');
  assert.equal(bookId({ title: 'No Slug At All' }), 'no-slug-at-all');
});

test('L. the record names its own book', () => {
  const s = fakeStore();
  writeProgress(s, 'alpha', snap(10));
  assert.equal(readProgress(s, 'alpha').bookId, 'alpha');
  assert.equal(JSON.parse(s.dump()['rs-progress-alpha']).bookId, 'alpha');
});

test('M. no saved progress opens at chapter 0', () => {
  // Preserved behaviour, stated so it cannot be traded away: this is the
  // computation openBook() runs, with the reader's real ZERO record.
  const book = {
    duration: 90,
    chapters: [
      { id: 0, start: 0, end: 30, duration: 30 },
      { id: 1, start: 30, end: 60, duration: 30 },
      { id: 2, start: 60, end: 90, duration: 30 },
    ],
  };
  const p = readProgress(fakeStore(), 'never-opened');
  assert.equal(findChapterIdxAt(book, p.bookTime || 0, false), 0);
});

test('N. migration: index keys become id keys and the legacy keys go', () => {
  const s = fakeStore({
    'rs-progress-0': JSON.stringify({ bookTime: 100, progress: 0.1 }),
    'rs-progress-1': JSON.stringify({ bookTime: 200, progress: 0.2 }),
    'rs-last-book': '1',
  });
  migrateLegacyProgress(s, ['A', 'B']);

  assert.equal(readProgress(s, 'A').bookTime, 100);
  assert.equal(readProgress(s, 'B').bookTime, 200);
  assert.equal(readLastBookId(s), 'B');
  const keys = Object.keys(s.dump());
  assert.equal(keys.includes('rs-progress-0'), false, 'rs-progress-0 is gone');
  assert.equal(keys.includes('rs-progress-1'), false, 'rs-progress-1 is gone');
  assert.equal(keys.includes('rs-last-book'), false, 'rs-last-book is gone');
  // A migrated record can be attributed like a written one.
  assert.equal(readProgress(s, 'A').bookId, 'A');
});

test('O. migration is idempotent, and does not re-fire on a later reorder', () => {
  const s = fakeStore({
    'rs-progress-0': JSON.stringify({ bookTime: 100, progress: 0.1 }),
    'rs-last-book': '0',
  });
  migrateLegacyProgress(s, ['A', 'B']);
  const once = JSON.stringify(s.dump());
  migrateLegacyProgress(s, ['A', 'B']);
  migrateLegacyProgress(s, ['A', 'B']);
  assert.equal(JSON.stringify(s.dump()), once, 'a second start changes nothing');

  // The assertion with teeth. "Changes nothing" is trivially true while the
  // library holds still — every run reads the same store and converges. What
  // has to hold is that the index→id map is spent: a migration that left the
  // legacy keys in place would map them AGAIN, months later, against whatever
  // order the library is in by then, which is the original defect wearing a
  // migration's clothes.
  migrateLegacyProgress(s, ['B', 'A']);
  assert.equal(readProgress(s, 'B').bookTime, 0, 'B never inherits A\'s position');
  assert.equal(readProgress(s, 'A').bookTime, 100, 'and A keeps it');
  assert.equal(readLastBookId(s), 'A');
});

test('P. a legacy index with no book in the library is deleted', () => {
  const s = fakeStore({
    'rs-progress-0': JSON.stringify({ bookTime: 100, progress: 0.1 }),
    'rs-progress-7': JSON.stringify({ bookTime: 999, progress: 0.9 }),
    'rs-last-book': '7',
  });
  migrateLegacyProgress(s, ['A', 'B']);
  const keys = Object.keys(s.dump());
  assert.equal(keys.includes('rs-progress-7'), false, 'the orphan index is removed');
  assert.equal(keys.some((k) => JSON.parse(s.dump()[k] || '{}').bookTime === 999), false,
    'and its position was not grafted onto some other book');
  assert.equal(readLastBookId(s), null, 'a last book outside the library resumes nothing');
});

test('Q. migration never overwrites a record already under an id key', () => {
  const s = fakeStore({
    'rs-progress-A': JSON.stringify({ bookTime: 500, progress: 0.5 }),
    'rs-progress-0': JSON.stringify({ bookTime: 100, progress: 0.1 }),
    'rs-last-book-id': 'B',
    'rs-last-book': '0',
  });
  migrateLegacyProgress(s, ['A', 'B']);
  assert.equal(readProgress(s, 'A').bookTime, 500, 'the id-keyed record wins');
  assert.equal(readLastBookId(s), 'B', 'the id-keyed last book wins');
  assert.equal(Object.keys(s.dump()).includes('rs-progress-0'), false, 'the legacy key still goes');
});

test('R. a numeric book id is not mistaken for a legacy index', () => {
  // `rs-progress-0` is ambiguous when a book's own id is "0". It is the id
  // key, and eating it would delete a live record on every start.
  const s = fakeStore({ 'rs-progress-0': JSON.stringify({ bookTime: 77, progress: 0.7 }) });
  migrateLegacyProgress(s, ['0', 'B']);
  assert.equal(readProgress(s, '0').bookTime, 77);
});

test('S. a store that throws from every accessor takes nothing down', () => {
  const s = hostileStore();
  assert.doesNotThrow(() => migrateLegacyProgress(s, ['A', 'B']));
  assert.doesNotThrow(() => writeProgress(s, 'A', snap(10)));
  assert.doesNotThrow(() => clearLastBook(s));
  assert.deepEqual(readProgress(s, 'A'), ZERO, 'progress reads as none');
  assert.equal(readLastBookId(s), null, 'and nothing resumes');
});

test('T. safeStore survives a storage getter that throws', () => {
  // The iOS "Block All Cookies" shape: the THROW is naming the identifier, so
  // the source is a thunk and calling it is what must be guarded.
  let calls = 0;
  const s = safeStore(() => { calls++; throw new Error('The operation is insecure.'); });
  assert.doesNotThrow(() => writeProgress(s, 'A', snap(10)));
  assert.doesNotThrow(() => migrateLegacyProgress(s, ['A', 'B']));
  assert.equal(calls > 0, true, 'the thunk really was called — the guard is not skipping it');
  // In-memory for this page view, which is the most an evicted browser allows.
  assert.equal(readProgress(s, 'A').bookTime, 10);
  assert.equal(readProgress(s, 'never-opened').bookTime, 0);
});

test('T2. safeStore passes through to a working store', () => {
  const real = fakeStore();
  const s = safeStore(() => real);
  writeProgress(s, 'A', snap(10));
  assert.equal(JSON.parse(real.dump()['rs-progress-A']).bookTime, 10,
    'the real store really is written, not shadowed by the memory fallback');
  assert.equal(readProgress(s, 'A').bookTime, 10);
});

test('U. a written record is stamped with when this browser wrote it', () => {
  // savedAt exists so a record from ANOTHER device can be compared against
  // this one. Without it "is the server's copy newer?" has no local operand,
  // and the only answers available are "always prompt" and "never prompt".
  const s = fakeStore();
  writeProgress(s, 'alpha', snap(90), () => '2026-09-16T12:00:00.000Z');
  assert.equal(readProgress(s, 'alpha').savedAt, '2026-09-16T12:00:00.000Z');
});

test('U2. savedAt moves forward on every save, not only the first', () => {
  const s = fakeStore();
  writeProgress(s, 'alpha', snap(10), () => '2026-09-16T12:00:00.000Z');
  writeProgress(s, 'alpha', snap(20), () => '2026-09-16T12:05:00.000Z');
  assert.equal(readProgress(s, 'alpha').savedAt, '2026-09-16T12:05:00.000Z');
});

test('U3. the default clock is the real one, in ISO — the host passes none', () => {
  const s = fakeStore();
  const before = Date.now();
  writeProgress(s, 'alpha', snap(10));
  const at = Date.parse(readProgress(s, 'alpha').savedAt);
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000,
    'a stamp nobody can parse is a stamp no comparison can use');
});
