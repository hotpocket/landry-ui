/**
 * search-ui.ts — the loading half of search.
 *
 * Searching is 10 ms (see ../core/search.ts). Everything here exists because
 * the other books' transcripts are not on the client when the reader starts
 * typing.
 *
 * Two rules shape it:
 *
 *  - Results appear as each transcript lands, never after all of them. The book
 *    already open is searched on the first keystroke, because its transcript is
 *    already in memory.
 *  - Audio is NEVER fetched. A chapter is megabytes; a search that warmed audio
 *    would spend the reader's bandwidth on results they have not looked at yet.
 *    Audio loads when a result is chosen, and not before.
 */

import { searchBooks, type SearchGroup } from '../core/search.ts';
import type { BookTranscript, TranscriptData } from '../core/transcript.ts';

export interface TranscriptSource {
  /** slug → URL, for books that keep their transcript beside their audio. */
  urlFor(slug: string): string | undefined;
  /** Already-parsed transcripts, shared with the player. */
  loaded: Record<string, BookTranscript | undefined>;
}

export class TranscriptLoader {
  private src: TranscriptSource;
  private inFlight = new Map<string, Promise<void>>();
  /** Everyone waiting on a fetch: the library search and the book search share
   *  this loader, and whichever asked second must hear when it lands too. */
  private waiters = new Map<string, Set<() => void>>();
  private failed = new Set<string>();
  private onProgress: (loading: string[]) => void;

  constructor(src: TranscriptSource, onProgress: (loading: string[]) => void) {
    this.src = src;
    this.onProgress = onProgress;
  }

  /** Titles currently being fetched, for the spinner's tooltip. */
  loading(): string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Fetch every named book's transcript that is not already present, calling
   * back as each one lands. A book whose fetch fails is not retried on every
   * keystroke — a private book the reader cannot see would otherwise produce a
   * 403 per character typed.
   */
  ensure(slugs: string[], onEach: () => void): void {
    for (const slug of slugs) {
      if (this.src.loaded[slug] || this.failed.has(slug)) continue;
      if (this.inFlight.has(slug)) { this.waiters.get(slug)?.add(onEach); continue; }
      this.waiters.set(slug, new Set([onEach]));
      const url = this.src.urlFor(slug);
      if (!url) { this.failed.add(slug); continue; }

      const p = fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: TranscriptData | BookTranscript) => {
          // Two shapes in the wild: a whole-library file with `books`, and a
          // per-book file. Both are normalised to slug → transcript here so the
          // search core only ever sees one.
          const books = (data as TranscriptData).books;
          if (Array.isArray(books)) {
            for (const b of books) this.src.loaded[b.slug] = b;
            // A library-wide file need not mention the book that was asked for
            // — an unpublished book behind a shared transcripts.json produces
            // exactly that. Without this the slug is left neither loaded nor
            // failed, and `ensure` refetches the same URL on every keystroke
            // for the rest of the session: the 403-per-character defect the
            // `failed` set exists to stop, arriving through a 200 instead.
            if (!this.src.loaded[slug]) this.failed.add(slug);
          } else {
            this.src.loaded[slug] = data as BookTranscript;
          }
        })
        .catch(() => { this.failed.add(slug); })
        .finally(() => {
          this.inFlight.delete(slug);
          const waiting = this.waiters.get(slug) ?? new Set();
          this.waiters.delete(slug);
          this.onProgress(this.loading());
          for (const f of waiting) f();
        });

      this.inFlight.set(slug, p);
    }
    this.onProgress(this.loading());
  }
}

export interface SearchViewDeps {
  input: HTMLInputElement;
  results: HTMLElement;
  spinner: HTMLElement;
  bookList: HTMLElement;
  books: { slug?: string; title?: string }[];
  loaded: Record<string, BookTranscript | undefined>;
  summaryFor: () => Record<string, boolean>;
  loader: TranscriptLoader;
  /** Open a book at a chapter and chapter-local time. */
  goTo(bookSlug: string, chapterIndex: number, start: number): void;
  formatTime(s: number): string;
}

const DEBOUNCE_MS = 120;

/**
 * Wire the library search. Returns its disposer: a host that re-renders builds
 * a new engine into the same DOM, and without this the old one's listeners and
 * transcript callbacks kept painting rows that led to a dead engine.
 */
export function wireSearch(d: SearchViewDeps): { dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ac = new AbortController();
  const signal = ac.signal;

  const setSpinner = (loading: string[]) => {
    if (signal.aborted) return;       // the spinner is shared with the successor
    if (!loading.length) {
      d.spinner.hidden = true;
      d.spinner.title = '';
      return;
    }
    d.spinner.hidden = false;
    const titles = loading.map((slug) =>
      d.books.find((b) => b.slug === slug)?.title ?? slug);
    d.spinner.title = `Loading transcript${titles.length > 1 ? 's' : ''}: ${titles.join(', ')}`;
  };

  const render = () => {
    if (signal.aborted) return;
    const q = d.input.value;
    if (!q.trim()) {
      d.results.hidden = true;
      d.results.innerHTML = '';
      d.bookList.hidden = false;
      return;
    }

    const groups = searchBooks({
      books: d.books,
      transcripts: d.loaded,
      query: q,
      summaryFor: d.summaryFor(),
    });

    // Title matches are free — the library payload is already in memory — and
    // are the answer to "which book was that", which is most of what a reader
    // asks a library search.
    const titleHits = d.books.filter(
      (b) => (b.title ?? '').toLowerCase().includes(q.trim().toLowerCase()));

    d.bookList.hidden = true;
    d.results.hidden = false;
    paint(d, groups, titleHits, q, signal);
  };

  const onInput = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // Render what is already in memory FIRST, then pull the rest in. The open
      // book answers immediately; everything else streams in behind it.
      render();
      if (d.input.value.trim()) {
        d.loader.ensure(
          d.books.map((b) => b.slug!).filter(Boolean),
          render,
        );
      }
    }, DEBOUNCE_MS);
  };

  d.input.addEventListener('input', onInput, { signal });
  d.input.addEventListener('search', onInput, { signal });
  setSpinner([]);
  (d.loader as unknown as { onProgress: (l: string[]) => void }).onProgress = setSpinner;
  // The DOM may be a predecessor's, rows and all: none of them may survive.
  // A query left in the box is searched again by this instance.
  d.results.innerHTML = '';
  d.results.hidden = true;
  d.bookList.hidden = false;
  if (d.input.value.trim()) onInput();

  return {
    dispose() {
      ac.abort();
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

function paint(
  d: SearchViewDeps,
  groups: SearchGroup[],
  titleHits: { slug?: string; title?: string }[],
  query: string,
  signal: AbortSignal,
): void {
  d.results.innerHTML = '';

  if (titleHits.length) {
    const sec = document.createElement('div');
    sec.className = 'search-group';
    const head = document.createElement('div');
    head.className = 'search-group-head';
    head.textContent = `Books (${titleHits.length})`;
    sec.appendChild(head);
    for (const b of titleHits) {
      const row = document.createElement('button');
      row.className = 'search-hit search-hit-book';
      row.textContent = b.title ?? b.slug ?? '';
      row.addEventListener('click', () => d.goTo(b.slug!, 1, 0), { signal });
      sec.appendChild(row);
    }
    d.results.appendChild(sec);
  }

  for (const g of groups) {
    const sec = document.createElement('div');
    sec.className = 'search-group';
    sec.setAttribute('data-book', g.bookSlug);
    const head = document.createElement('div');
    head.className = 'search-group-head';
    // The count is the whole count; the list below is capped. Saying 412 and
    // showing 50 without saying so would read as "that is all there is".
    head.textContent = `${g.title} (${g.count})`;
    sec.appendChild(head);

    const CAP = 50;
    for (const m of g.matches.slice(0, CAP)) {
      const row = document.createElement('button');
      row.className = 'search-hit';
      const where = document.createElement('span');
      where.className = 'search-hit-where';
      where.textContent = `Ch ${m.chapterIndex} · ${d.formatTime(m.start)}`;
      const text = document.createElement('span');
      text.className = 'search-hit-text';
      text.appendChild(highlight(m.snippet, query.trim()));
      row.append(where, text);
      row.addEventListener('click', () => d.goTo(m.bookSlug, m.chapterIndex, m.start), { signal });
      sec.appendChild(row);
    }
    if (g.count > CAP) {
      const more = document.createElement('div');
      more.className = 'search-more';
      more.textContent = `+${g.count - CAP} more — refine the search`;
      sec.appendChild(more);
    }
    d.results.appendChild(sec);
  }

  if (!groups.length && !titleHits.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    // Distinguishes "nothing matches" from "not everything has been searched
    // yet" — otherwise a reader concludes the word is absent while three
    // transcripts are still in flight.
    empty.textContent = d.loader.loading().length
      ? 'No matches yet — still loading transcripts…'
      : 'No matches.';
    d.results.appendChild(empty);
  }
}

/** Case-insensitive highlight, built as nodes so the text is never parsed as HTML. */
function highlight(text: string, query: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!query) { frag.appendChild(document.createTextNode(text)); return frag; }
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) break;
    if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    frag.appendChild(mark);
    i = at + needle.length;
  }
  frag.appendChild(document.createTextNode(text.slice(i)));
  return frag;
}
