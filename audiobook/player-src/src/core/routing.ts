/**
 * routing.ts — the hash names the open book.
 *
 * Refresh-keeps-your-place rests on this: the URL is the source of truth for
 * which book is open, so slug stability is a correctness property. A slug whose
 * shape changes orphans every existing link and every restored session.
 *
 * Hash format: '#/<slug>'. The library is the empty hash.
 */

export interface BookIdentity {
  slug?: string;
  title?: string;
}

const MAX_SLUG = 60;

/** URL-safe, stable, bounded. */
export function slugify(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG);
}

/**
 * A book's slug.
 *
 * 'book' is the placeholder single-book sites ship as a default, so it loses to
 * a real title — otherwise a library assembled from several of them would have
 * every entry collide on one URL. It survives only as the last resort.
 */
export function bookSlug(book: BookIdentity): string {
  if (book.slug && book.slug !== 'book') return book.slug;
  return slugify(book.title) || book.slug || 'book';
}

/** Index of a book by slug, or -1. Never a falsy-looking 0 for "not found". */
export function bookIdxFromSlug(books: BookIdentity[], slug: string | null | undefined): number {
  // No guard for an empty slug: bookSlug never returns one (it falls back to
  // 'book'), so the loop already answers -1. Mutation testing found the guard
  // could be deleted with nothing going red — it was unreachable, not untested.
  for (let i = 0; i < books.length; i++) {
    if (bookSlug(books[i]) === slug) return i;
  }
  return -1;
}

/**
 * Slugs that more than one book in this library resolves to, each named once.
 *
 * Two paths reach it: an explicit duplicate slug in the manifest, and — the one
 * that is invisible from the titles — two titles that differ only after
 * MAX_SLUG characters, which `slugify` truncates into the same string.
 * `bookIdxFromSlug` returns the first match, so every hash for the pair opens
 * the first book and the second is unreachable by URL.
 *
 * Reported, deliberately not repaired. Appending a content digest would make
 * the slug unique and change it for every long-titled book that already exists,
 * orphaning live links and stored positions — trading a rare failure for a
 * certain one, against the stability this module is built around. A library
 * that hits this wants a hand-picked `slug` in the manifest, which is a
 * decision, not a fallback.
 */
export function collidingSlugs(books: BookIdentity[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const b of books) {
    const s = bookSlug(b);
    if (seen.has(s)) dupes.add(s);
    seen.add(s);
  }
  return [...dupes];
}

/** The hash for a book index; the empty string means the library. */
export function hashForBook(books: BookIdentity[], idx: number | null): string {
  if (idx == null) return '';
  return '#/' + encodeURIComponent(bookSlug(books[idx]));
}

/** What a hash names: a book, and optionally one chapter of it. */
export interface HashRoute {
  slug: string | null;
  /** 1-based, the ordinal the chapter list shows. null when unnamed. */
  chapter: number | null;
}

/**
 * Read '#/<slug>' or '#/<slug>/<n>'.
 *
 * Split BEFORE decoding. `slug` is host-supplied and may contain a '/', which
 * hashForBook percent-encodes on the way out — splitting the decoded string
 * would eat the slug and open the wrong book, or none.
 *
 * A tail that is not a plain 1-based ordinal degrades to "no chapter" and keeps
 * the BOOK. Every one of these runs on the boot path, where the cost of being
 * strict is a reader who was sent a link and got a library.
 */
export function routeFromHash(hash: string): HashRoute {
  const m = /^#\/([^/]*)(?:\/(.*))?$/.exec(hash || '');
  if (!m || !m[1]) return { slug: null, chapter: null };
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    // A hand-edited or truncated hash ('#/%') makes decodeURIComponent throw.
    // An escaping URIError here is a blank player rather than a bad route.
    return { slug: null, chapter: null };
  }
  const n = m[2] !== undefined && /^\d+$/.test(m[2]) ? Number(m[2]) : 0;
  return { slug, chapter: n >= 1 ? n : null };
}

/** The slug a hash names, or null for the library. */
export function slugFromHash(hash: string): string | null {
  return routeFromHash(hash).slug;
}

/**
 * The hash for one chapter of one book, 1-based.
 *
 * The chapter is an ENTRY parameter, not a bookmark: the player spends it on
 * arrival and rewrites the address to hashForBook. See docs/spec-chapter-list.md
 * §6 — keeping it would make a reload throw away position within a chapter,
 * which is the promise the hash exists to keep.
 */
export function hashForChapter(books: BookIdentity[], idx: number | null, chapter: number | null): string {
  const base = hashForBook(books, idx);
  if (!base || chapter == null || !(chapter >= 1)) return base;
  return base + '/' + Math.floor(chapter);
}
