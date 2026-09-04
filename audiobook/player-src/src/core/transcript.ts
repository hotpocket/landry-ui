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
  /**
   * The source chapter number, when the builder published one.
   *
   * `index` is a POSITION in this list, and this list's membership rule is not
   * the manifest's: a chapter is here when it has a WAV, an N.txt and a title,
   * and it is in the manifest when it has an M4A and a title. A chapter
   * rendered but not yet encoded is therefore in one and not the other, which
   * is the ordinary state of a tree whose renderer encodes after transcribing.
   * Optional because most published transcripts predate it.
   */
  n?: number;
  chunks: Chunk[];
  summary_chunks?: Chunk[];
  /** Where this chapter's text came from, when it came from something public.
   *  Optional and usually absent: a book of original prose has no original to
   *  link to, and the panel must show no link rather than a dead one. */
  source_url?: string;
  /** When the original was published, ISO `YYYY-MM-DD`. Optional again inside
   *  source_url: a link whose date nobody recorded is still worth having. */
  source_date?: string;
  /** True when source_date was inferred rather than read from the source.
   *  The player prefixes those with '~' — a guessed date shown as a fact is
   *  worse than no date, and the reader cannot tell them apart otherwise. */
  source_date_estimated?: boolean;
}

/**
 * ISO `YYYY-MM-DD` as `yyyy/mm/dd`, or '' for anything that is not that.
 *
 * Formatting lives here rather than in the published data: a display format
 * baked into every book's transcript cannot be changed without republishing
 * all of them. Returning '' rather than the raw string for an unrecognised
 * value is deliberate — a date field showing "unknown" or a half-parsed
 * fragment is worse than showing nothing beside the link.
 */
export function shortDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').trim());
  return m ? `${m[1]}/${m[2]}/${m[3]}` : '';
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

/**
 * The transcript for one chapter.
 *
 * By the chapter's NUMBER where both sides publish one, and by position
 * otherwise — the 0-based chapter id to 1-based transcript index conversion,
 * kept in this one place.
 *
 * Position was the only rule until 2026-08-26, and it is wrong whenever the two
 * lists have different lengths. They are built from different membership rules
 * (see ChapterTranscript.n), so a chapter whose audio has rendered but not yet
 * encoded is in the transcript and not in the manifest, and every chapter after
 * it is shown the PREVIOUS chapter's text — silently, with no error anywhere,
 * for as long as the gap lasts. The renderer for The Diary of a CEO encodes
 * after it transcribes, so that gap is a normal state of that tree.
 *
 * A number that matches nothing returns null rather than falling back to the
 * position: showing no text is a chapter that has not been transcribed yet,
 * which is true, and showing the wrong chapter's text is the defect.
 *
 * The fallback is not deprecation-in-waiting. karagame and brandonlandry.com
 * publish transcripts built before `n` existed, and every one of them must keep
 * pairing exactly as it always has.
 */
export function chapterTranscript(
  bt: BookTranscript | null | undefined,
  chapter: { id: number; n?: number } | null | undefined,
): ChapterTranscript | null {
  if (!bt?.chapters || !chapter) return null;
  if (chapter.n !== undefined && bt.chapters.some((c) => c.n !== undefined)) {
    return bt.chapters.find((c) => c.n === chapter.n) ?? null;
  }
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
