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

/**
 * The parameter that makes a retry a genuinely new request.
 *
 * Stripped from the service worker's cache key alongside the signature params,
 * so a chapter refetched this way is still one cached object.
 */
export const CACHE_BUST_PARAM = 'rsr';

/**
 * A URL the network stack has not seen, for the case where reloading the same
 * one does nothing.
 *
 * Measured 2026-08-09: with a chapter request left hanging, three watchdog
 * reloads of the identical URL produced exactly ONE request on the wire — the
 * reloads were coalesced onto the request that was already stuck, so recovery
 * recovered nothing. A distinct URL is what abandons the dead socket.
 *
 * `n` of 0 means no bust: the ordinary path must not carry a parameter that
 * changes the CloudFront cache key for every chapter anyone plays.
 */
export function withCacheBust(url: string, n: number): string {
  if (!n) return url;
  return url + (url.includes('?') ? '&' : '?') + `${CACHE_BUST_PARAM}=${n}`;
}

/**
 * Seconds until the media signature in `query` expires — negative once it has.
 *
 * The client is the only place that knows both when a chapter failed and how
 * old its signature was, and until this existed it recorded neither. A 15-minute
 * media TTL that nothing refreshed killed long listens for a day and presented
 * as "it stutters with the screen off", because a 403 at a chapter boundary is
 * indistinguishable from a flaky radio unless you can see the expiry.
 *
 * Null means "no answer", never zero: an unsigned host (karagame), a query with
 * no Policy, and an undecodable one all have no expiry to report, and reporting
 * 0 would read as "expired at exactly this instant" in every one of them.
 */
export function secondsUntilExpiry(query: string | null | undefined,
                                   nowMs: number): number | null {
  if (!query) return null;
  // Anchored: a parameter that merely ends in `Policy` is somebody else's value,
  // and reading it would report an expiry that was never minted.
  const m = /(?:^|[?&])Policy=([^&]+)/.exec(query);
  if (!m) return null;
  try {
    // CloudFront's base64 is not the url-safe alphabet: + → -, = → _, / → ~.
    // Decoding with the standard inverse silently yields garbage rather than
    // throwing, which is why this maps all three back explicitly.
    const std = m[1].replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
    const stmt = JSON.parse(atob(std))?.Statement?.[0];
    const at = stmt?.Condition?.DateLessThan?.['AWS:EpochTime'];
    // Type-checked, not truth-checked: a policy with no statement yields
    // undefined here, and undefined arithmetic is NaN, which would be reported
    // as a number.
    if (typeof at !== 'number') return null;
    return Math.round(at - nowMs / 1000);
  } catch {
    return null;
  }
}
