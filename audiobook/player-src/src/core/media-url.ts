/**
 * media-url.ts — attaching the media signature.
 *
 * Media is authorized by a signature the API mints per book. The player builds
 * URLs by concatenation (base + filename), so the query has to be appended
 * after the whole path is assembled — a query on the base would produce
 * `/audio/?Policy=…chapter_0001.m4a`, a different object and a 403.
 *
 * An empty query is the normal case for hosts with no API at all (karagame,
 * brandonlandry.com), which is why it returns the URL untouched rather than
 * treating "unsigned" as an error.
 */
export function withMediaQuery(url: string, query: string | null | undefined): string {
  if (!query) return url;
  // Tolerate a caller that already prefixed its separator, rather than
  // producing '??' and a 403 that looks like an auth failure.
  const q = query.replace(/^[?&]+/, '');
  if (!q) return url;
  return url + (url.includes('?') ? '&' : '?') + q;
}
