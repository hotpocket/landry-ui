/**
 * clock.ts — the book clock, as pure functions.
 *
 * The vanilla player kept four entangled module-level vars for this
 * (`summaryMode`, `summaryStarts`, `summaryTotal`, `currentBook`) and read them
 * from a dozen places. Here the mode is an argument, so every reader is
 * explicit about which clock it means and nothing can drift.
 *
 * Two clocks exist because a chapter's summary track is not a slice of its full
 * track — it is a different recording of the same chapter. Positions therefore
 * do not map between them, which is why switching modes restarts the chapter
 * rather than trying to convert a time.
 */

export interface SummaryTrack {
  filename?: string;
  duration: number;
  size?: number;
}

export interface Chapter {
  id: number;
  n?: number;
  title?: string;
  filename?: string;
  start: number;
  end: number;
  duration?: number;
  size?: number;
  summary?: SummaryTrack;
}

export interface Book {
  slug?: string;
  title?: string;
  chapters: Chapter[];
  duration: number;
}

/** A chapter's own length on the active clock. */
export function chapterDuration(ch: Chapter, summary: boolean): number {
  // An unsummarized chapter keeps its full length on the summary clock. Without
  // this the clock would go backwards across a gap in summary coverage.
  if (summary && ch.summary) return ch.summary.duration;
  return ch.duration ?? ch.end - ch.start;
}

/** Book-relative start of every chapter on the summary clock. */
export function summaryStarts(book: Book): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const ch of book.chapters) {
    starts.push(acc);
    acc += chapterDuration(ch, true);
  }
  return starts;
}

/**
 * Position of the first chapter whose `id` is not its index, or -1.
 *
 * `chapterStart` below reads `ch.id` as a position into `summaryStarts`, and so
 * does the engine — chapter rows, per-chapter progress bars and scrubs, the
 * active-chapter highlight, and the `tc-<id+1>-<n>` transcript element ids. That
 * makes `id === position` load-bearing across the whole player while `Chapter.id`
 * is typed as any number, and nothing enforced it.
 *
 * Detected rather than corrected. Renumbering would mean mutating book objects
 * the host still owns — books.landry.bot re-signs the very same objects in
 * place — and a silent repair of a manifest that is wrong somewhere else is
 * worse than a manifest that is wrong loudly.
 */
export function nonPositionalChapterId(book: Book | null | undefined): number {
  const chapters = book?.chapters;
  if (!chapters) return -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].id !== i) return i;
  }
  return -1;
}

/**
 * Book-relative start of one chapter on the active clock. Full starts are
 * precomputed upstream and carried on the chapter; summary starts are derived
 * here because only the client knows which chapters have summary tracks.
 */
export function chapterStart(book: Book, ch: Chapter, summary: boolean): number {
  if (!summary) return ch.start;
  return summaryStarts(book)[ch.id] ?? 0;
}

/** Total length of the book on the active clock. */
export function bookDuration(book: Book, summary: boolean): number {
  if (!summary) return book.duration;
  return book.chapters.reduce((t, ch) => t + chapterDuration(ch, true), 0);
}

/**
 * Index of the chapter containing a book-relative time.
 *
 * Boundary-inclusive: a time exactly on a chapter's start belongs to that
 * chapter. Out-of-range times clamp instead of throwing — a seek past the end
 * is a real thing a drag can produce, and the last chapter is the honest answer.
 */
export function findChapterIdxAt(book: Book, bookTime: number, summary: boolean): number {
  const starts = summary ? summaryStarts(book) : book.chapters.map((c) => c.start);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= bookTime) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Whether the summary toggle should be offered at all. Any single summarized
 * chapter is enough — a partially-summarized book is still usable in summary
 * mode, because unsummarized chapters fall back to their full track.
 */
export function bookHasSummaries(book: Book | null | undefined): boolean {
  return !!book?.chapters?.some((c) => c.summary);
}
