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

/** The hash for a book index; the empty string means the library. */
export function hashForBook(books: BookIdentity[], idx: number | null): string {
  if (idx == null) return '';
  return '#/' + encodeURIComponent(bookSlug(books[idx]));
}

/** The slug a hash names, or null for the library. */
export function slugFromHash(hash: string): string | null {
  const m = /^#\/(.+)$/.exec(hash || '');
  if (!m) return null;
  // A hand-edited or truncated hash ('#/%') makes decodeURIComponent throw.
  // start() calls this before the first book opens, so an escaping URIError is
  // a blank player rather than a bad route — the library is the honest answer.
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
