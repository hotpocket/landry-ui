/**
 * progress.ts — where you left off, and getting it back.
 *
 * Written from the rAF loop on a phone that can be killed mid-write, and the
 * format has already changed once. Both facts push the same way: a record that
 * is missing, half-written or legacy must degrade to the start of the book
 * rather than throw, because a throw here happens inside the render loop.
 *
 * Storage is injected, not reached for, so this is testable in node and a host
 * could substitute something other than localStorage.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ProgressRecord {
  bookTime: number;
  progress: number;
  chapterIdx?: number;
  chapterN?: number | null;
  timeInChapter?: number;
  summary?: boolean;
}

export interface ProgressSnapshot {
  bookTime: number;
  duration: number;
  chapterIdx: number;
  chapterN: number | null;
  timeInChapter: number;
  summary: boolean;
}

export const ZERO: ProgressRecord = { bookTime: 0, progress: 0 };

const KEY = (idx: number) => `rs-progress-${idx}`;
const LAST_BOOK = 'rs-last-book';

export function readProgress(store: KeyValueStore, bookIdx: number): ProgressRecord {
  try {
    const raw = store.getItem(KEY(bookIdx));
    // Mutation cannot tell this guard from the catch below — deleting it still
    // yields ZERO, via a throw. It stays because "no record yet" is normal
    // operation on every first open, and normal operation should not be routed
    // through an exception handler.
    if (!raw) return { ...ZERO };
    const p = JSON.parse(raw) as ProgressRecord & { time?: number };
    // The format once stored book-relative time as `time`. Records written
    // before that change are still on real devices.
    if (p.time !== undefined && p.bookTime === undefined) p.bookTime = p.time;
    return p;
  } catch {
    return { ...ZERO };
  }
}

export function writeProgress(store: KeyValueStore, bookIdx: number, s: ProgressSnapshot): void {
  store.setItem(KEY(bookIdx), JSON.stringify({
    bookTime: s.bookTime,
    progress: fraction(s.bookTime, s.duration),
    chapterIdx: s.chapterIdx,
    chapterN: s.chapterN,
    timeInChapter: s.timeInChapter,
    summary: s.summary,
  }));
  store.setItem(LAST_BOOK, String(bookIdx));
}

export function readLastBook(store: KeyValueStore): number | null {
  const raw = store.getItem(LAST_BOOK);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Clamped to 0..1 and always finite. A zero duration is reachable — a book
 * whose manifest has not loaded yet — and an Infinity or NaN here would be
 * stored, read back, and used to size a progress bar.
 */
function fraction(bookTime: number, duration: number): number {
  // One check, not two: a zero duration yields Infinity and a NaN input yields
  // NaN, and !isFinite catches both. A separate `duration > 0` guard ahead of
  // this was redundant — mutation removed it with nothing going red.
  const f = bookTime / duration;
  if (!Number.isFinite(f)) return 0;
  return Math.max(0, Math.min(1, f));
}
