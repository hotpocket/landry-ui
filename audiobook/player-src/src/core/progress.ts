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
 *
 * The key is the BOOK'S OWN ID, never its position in the library. It was the
 * position until 2026-09-16, which made every saved record a bookmark in a
 * list rather than in a book: adding, removing or reordering one book moved
 * every position onto a different one, and "resume" reopened a stranger at a
 * stale offset. `migrateLegacyProgress` carries the index-keyed records that
 * exist on real devices across, once, on the first start that knows the
 * library.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Needed by the migration, which must be able to retire a key, not blank it. */
  removeItem(key: string): void;
}

export interface ProgressRecord {
  /**
   * The book this record belongs to, written into the record as well as into
   * the key. A record is now findable under exactly one key, so a record found
   * under some OTHER key — a stale build, a half-finished migration, a support
   * dump pasted into a bug report — can still be attributed rather than
   * guessed at from its position.
   */
  bookId?: string;
  bookTime: number;
  progress: number;
  chapterIdx?: number;
  chapterN?: number | null;
  timeInChapter?: number;
  summary?: boolean;
  /**
   * When THIS browser wrote the record, ISO, client clock.
   *
   * It exists to be compared against a record the same reader left on another
   * device: without a local operand, "is the server's copy newer than mine?"
   * has only two answers available to it, always and never, and both are
   * wrong. The clock is the client's own and is not trusted for anything but
   * this comparison — the server keeps its own `updated_at`.
   */
  savedAt?: string;
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

const KEY = (bookId: string) => `rs-progress-${bookId}`;

/** The index-keyed pair this replaces. Read once per device, then deleted. */
const LEGACY_KEY = (bookIdx: number) => `rs-progress-${bookIdx}`;
const LEGACY_LAST_BOOK = 'rs-last-book';

/**
 * A NEW key rather than the old one holding a new kind of value, deliberately.
 * A legacy `rs-last-book` holds a decimal index string, and a book id can be a
 * decimal string too, so the value alone cannot say which era it is from:
 * reusing the key would make "already migrated?" a guess about a value's shape
 * and the migration non-idempotent — a book whose id is "3" would be re-read as
 * index 3 on the next start. With a second key, "migrated" is a fact about
 * which key exists.
 */
const LAST_BOOK_ID = 'rs-last-book-id';

/**
 * How far past the end of the current library the migration looks for legacy
 * index keys. A store cannot be enumerated through `KeyValueStore` — widening
 * that interface would push `key()`/`length` onto every host — so the indices
 * are probed, and the probe has to stop somewhere. A library only ever shrinks
 * by so much between two visits; an index further out than this is left as an
 * inert orphan, which costs a few bytes and nothing else.
 */
const LEGACY_SCAN = 64;

export function readProgress(store: KeyValueStore, bookId: string): ProgressRecord {
  try {
    const raw = store.getItem(KEY(bookId));
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

/**
 * `nowIso` is injected so a test can pin the stamp; every caller in the player
 * takes the default. A stamp is written on EVERY save, not only the first —
 * the comparison it feeds asks when this browser last moved, not when it first
 * opened the book.
 */
export function writeProgress(store: KeyValueStore, bookId: string, s: ProgressSnapshot,
                              nowIso: () => string = isoNow): void {
  set(store, KEY(bookId), JSON.stringify({
    bookId,
    savedAt: nowIso(),
    bookTime: s.bookTime,
    progress: fraction(s.bookTime, s.duration),
    chapterIdx: s.chapterIdx,
    chapterN: s.chapterN,
    timeInChapter: s.timeInChapter,
    summary: s.summary,
  }));
  set(store, LAST_BOOK_ID, bookId);
}

/** The id of the book to resume, or null. Never an index. */
export function readLastBookId(store: KeyValueStore): string | null {
  const raw = get(store, LAST_BOOK_ID);
  // The empty string is how `clearLastBook` says "the reader chose the shelf".
  return raw === null || raw === '' ? null : raw;
}

/** The reader went back to the library on purpose; nothing resumes. */
export function clearLastBook(store: KeyValueStore): void {
  set(store, LAST_BOOK_ID, '');
}

/**
 * Carry index-keyed records onto their books, once, and retire the old keys.
 *
 * Called on engine start, when the library — and therefore the index→id map —
 * is finally known. Idempotent by construction rather than by a "done" flag: a
 * flag would make the second-run assertion pass whatever the body did, and the
 * body is the part that has to be right.
 *
 * Every store access is individually guarded. This runs before the first
 * render, so a store that throws from one key must cost that key and nothing
 * else — on iOS Safari with "Block All Cookies" a single unguarded access on
 * the boot path is a permanently blank page for that reader.
 */
export function migrateLegacyProgress(store: KeyValueStore, bookIds: string[]): void {
  // A book whose own id is a decimal integer produces a key indistinguishable
  // from a legacy one. It is the id key, and eating it would delete a live
  // record on every start.
  const idKeys = new Set(bookIds.map(KEY));

  for (let idx = 0; idx < bookIds.length + LEGACY_SCAN; idx++) {
    const legacy = LEGACY_KEY(idx);
    if (idKeys.has(legacy)) continue;
    const raw = get(store, legacy);
    if (raw === null) continue;

    const id = bookIds[idx];
    // An id key that already exists was written by the current player and is
    // therefore newer than anything the old one left behind. Copy only into
    // an empty slot; an index outside the library maps to no book at all and
    // is simply dropped, because grafting it onto whoever holds that position
    // now is the very defect being repaired.
    if (id !== undefined && get(store, KEY(id)) === null) set(store, KEY(id), attribute(raw, id));
    remove(store, legacy);
  }

  const last = get(store, LEGACY_LAST_BOOK);
  if (last === null) return;
  if (get(store, LAST_BOOK_ID) === null) {
    const n = Number(last);
    if (last !== '' && Number.isInteger(n) && n >= 0 && n < bookIds.length) {
      set(store, LAST_BOOK_ID, bookIds[n]);
    }
  }
  remove(store, LEGACY_LAST_BOOK);
}

/** Stamp a migrated record with the book it turned out to belong to. */
function attribute(raw: string, bookId: string): string {
  try {
    return JSON.stringify({ ...(JSON.parse(raw) as ProgressRecord), bookId });
  } catch {
    // Unparseable, so it cannot be stamped — but it still belongs to this
    // book, and readProgress already degrades it to the start of the book.
    return raw;
  }
}

/**
 * A store that cannot throw, wrapped around one that can.
 *
 * `source` is a thunk, not a value, because on iOS Safari with "Block All
 * Cookies" the throw is NAMING the identifier — `localStorage` itself, before
 * any method is called. A guard written as `safeStore(localStorage)` would
 * throw on its way to being guarded.
 *
 * When the real store is unreachable or refuses, an in-memory map stands in for
 * the life of the page: resume stops surviving a reload, which is the most a
 * browser in that mode allows anyone, and everything else keeps working.
 */
export function safeStore(source: () => KeyValueStore | null | undefined): KeyValueStore {
  const mem = new Map<string, string>();
  const raw = (): KeyValueStore | null => {
    try {
      return source() ?? null;
    } catch {
      return null;
    }
  };
  return {
    getItem(key) {
      const s = raw();
      if (s) {
        try {
          const v = s.getItem(key);
          if (v !== null) return v;
        } catch { /* fall through to memory */ }
      }
      return mem.has(key) ? mem.get(key)! : null;
    },
    setItem(key, value) {
      // Memory first and unconditionally: a real store that is full or blocked
      // drops the write silently, and the reader's position should still be
      // right for the rest of this page view.
      mem.set(key, value);
      try { raw()?.setItem(key, value); } catch { /* full, or blocked */ }
    },
    removeItem(key) {
      mem.delete(key);
      try { raw()?.removeItem(key); } catch { /* blocked */ }
    },
  };
}

/** Guarded: `new Date()` cannot throw, but `toISOString` on an invalid date can. */
function isoNow(): string {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

function get(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function set(store: KeyValueStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch { /* full, or blocked */ }
}

function remove(store: KeyValueStore, key: string): void {
  try {
    store.removeItem(key);
  } catch { /* blocked; the key stays, and copy-only-into-empty keeps it inert */ }
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
