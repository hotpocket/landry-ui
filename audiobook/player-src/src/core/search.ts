/**
 * search.ts — finding a passage across the library.
 *
 * Deliberately a linear scan, not an index. Measured against the real karagame
 * transcripts (4 books, 62,033 chunks, 8.4 MB of text): 42 ms to parse the JSON
 * and 10 ms for a full scan. An index would add build-time machinery, a second
 * artifact to keep in sync, and a class of staleness bug, to save 10 ms.
 *
 * The real constraint is elsewhere: the other books' transcripts are not on the
 * client yet. That is a loading problem, handled by the caller streaming
 * results in as each transcript lands — never by fetching audio, which is
 * megabytes per chapter and pointless until a reader picks a result.
 */

import type { BookTranscript, Chunk } from './transcript.ts';

/** One letter matches forty thousand rows and answers no question. */
export const MIN_QUERY = 2;

const SNIPPET_MAX = 160;

export interface SearchMatch {
  bookSlug: string;
  chapterIndex: number;
  chunkIndex: number;
  /** Chapter-local seconds — what a click seeks to. */
  start: number;
  text: string;
  snippet: string;
}

export interface SearchGroup {
  bookSlug: string;
  title: string;
  count: number;
  matches: SearchMatch[];
}

export interface SearchQuery {
  books: { slug?: string; title?: string }[];
  /** slug → transcript, for the books whose transcript has arrived. */
  transcripts: Record<string, BookTranscript | undefined>;
  query: string | null | undefined;
  /** slug → true when that book is being read in summary mode. */
  summaryFor?: Record<string, boolean>;
}

/**
 * A snippet centred on the hit.
 *
 * Chunks are usually a sentence or two, so this is mostly the chunk itself;
 * the trim exists for the occasional very long paragraph, where showing the
 * whole thing would push every other result off the screen.
 */
export function snippetAround(text: string, at: number, queryLen: number): string {
  if (text.length <= SNIPPET_MAX) return text;
  const pad = Math.floor((SNIPPET_MAX - queryLen) / 2);
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, start + SNIPPET_MAX);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

export function searchBooks({ books, transcripts, query, summaryFor }: SearchQuery): SearchGroup[] {
  const q = (query ?? '').trim().toLowerCase();
  if (q.length < MIN_QUERY) return [];

  const groups: SearchGroup[] = [];

  for (const book of books) {
    const slug = book.slug;
    if (!slug) continue;
    // A book whose transcript has not arrived contributes nothing yet, and must
    // not stop the books that have. The caller re-runs as each one lands.
    const bt = transcripts[slug];
    if (!bt?.chapters) continue;

    const summary = !!summaryFor?.[slug];
    const matches: SearchMatch[] = [];

    for (const ch of bt.chapters) {
      // The text actually on screen. In summary mode a hit in the full text
      // would seek to a position the reader cannot see.
      const chunks: Chunk[] = (summary ? ch.summary_chunks : ch.chunks) ?? [];
      for (const chunk of chunks) {
        const text = chunk.text ?? '';
        // indexOf, not a regex: the query is user text, and `*` or `(` would
        // otherwise throw or match everything.
        const at = text.toLowerCase().indexOf(q);
        if (at === -1) continue;
        // One result per chunk, however many times it matches — a chunk is the
        // smallest thing that can be navigated to, so a second hit inside it
        // would be a duplicate row seeking to the same place.
        matches.push({
          bookSlug: slug,
          chapterIndex: ch.index,
          chunkIndex: chunk.index,
          start: chunk.start,
          text,
          snippet: snippetAround(text, at, q.length),
        });
      }
    }

    if (matches.length) {
      groups.push({
        bookSlug: slug,
        title: book.title ?? slug,
        count: matches.length,
        matches,
      });
    }
  }

  return groups;
}
