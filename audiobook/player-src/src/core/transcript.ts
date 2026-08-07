/**
 * transcript.ts — matching words to audio position.
 *
 * Two indexing systems meet here and disagree by one: chapters carry a 0-based
 * `id`, transcript chapters carry a 1-based `index`. Keeping that conversion in
 * exactly one function is the point of this module — spread across call sites
 * it becomes the transcript quietly following the wrong chapter.
 */

export interface Chunk {
  index: number;
  text: string;
  start: number;
  end: number;
}

export interface ChapterTranscript {
  index: number;
  chunks: Chunk[];
  summary_chunks?: Chunk[];
}

export interface BookTranscript {
  slug: string;
  chapters: ChapterTranscript[];
}

export interface TranscriptData {
  books: BookTranscript[];
}

/** How a book identifies itself to the transcript file. */
export interface TranscriptKey {
  slug?: string;
  filename?: string;
}

export function bookTranscript(
  data: TranscriptData | null | undefined,
  book: TranscriptKey | null | undefined,
): BookTranscript | null {
  if (!data?.books || !book) return null;
  // Some hosts identify a book by its audio filename; the transcript always
  // keys on the bare slug.
  const slug = (book.slug ?? book.filename ?? 'book').replace(/\.[^.]+$/, '');
  return data.books.find((b) => b.slug === slug) ?? null;
}

/** The 0-based chapter id to 1-based transcript index conversion, in one place. */
export function chapterTranscript(
  bt: BookTranscript | null | undefined,
  chapter: { id: number } | null | undefined,
): ChapterTranscript | null {
  if (!bt?.chapters || !chapter) return null;
  return bt.chapters.find((c) => c.index === chapter.id + 1) ?? null;
}

/**
 * The chunks for the active mode.
 *
 * A chapter with no summary chunks yields none in summary mode rather than
 * falling back to the full text: the summary track is a different recording,
 * so full chunks shown against it would scroll to positions that do not exist.
 * No text is better than confidently wrong text.
 */
export function chunksFor(ct: ChapterTranscript | null | undefined, summary: boolean): Chunk[] {
  if (!ct) return [];
  return summary ? (ct.summary_chunks ?? []) : (ct.chunks ?? []);
}

/**
 * The chunk covering a chapter-local time, or null.
 *
 * Start-inclusive, end-exclusive. Chunks do not necessarily tile the chapter —
 * silence and scene breaks leave real gaps — so a time between two chunks
 * matches nothing rather than sticking to the earlier one.
 */
export function findChunkAt(chunks: Chunk[] | null | undefined, t: number): Chunk | null {
  if (!chunks?.length) return null;
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  const c = chunks[lo];
  return t >= c.start && t < c.end ? c : null;
}
