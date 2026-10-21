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
 * The message the page sends the service worker to say which renders a book is
 * currently made of.
 *
 * The worker sees URLs and has no idea which ones are current, so versioned
 * URLs alone stop a dead render being SERVED without ever removing the copy
 * already in Cache Storage. The page knows, and tells it.
 *
 * sw.js is a classic script that cannot import this module, so the literal
 * appears there too — `test/audio-versioning.test.mjs` reads both files and
 * fails if they drift, which is the only way to have one source of truth
 * across a module boundary the platform will not let us cross.
 */
export const AUDIO_MANIFEST_MESSAGE = 'audiobook-manifest';

/**
 * The parameter that content-addresses a media URL.
 *
 * `v`, deliberately the same name transcripts.json is already published under
 * — one spelling, because sw.js keeps this parameter in its cache key while
 * stripping the signature parameters around it, and a second name would be a
 * second thing to keep in step with the worker.
 */
export const CONTENT_VERSION_PARAM = 'v';

/**
 * A chapter's URL, addressed by the bytes it names.
 *
 * THE CLASS this closes: every artifact derived from `source/N.txt` that is
 * addressed by a name which does not move when the text does. Chapter audio is
 * published to a stable S3 key with `public, max-age=31536000, immutable`, so a
 * re-render replaces the bytes under a name every cache in the path has already
 * been told it may keep for a year. Measured 2026-08-25: a reader in a fresh
 * incognito profile was served a 46-hour-old chapter (`Age: 165651`,
 * `X-Cache: Hit from cloudfront`) whose bytes had been replaced twenty hours
 * before, and readers with the site installed as a PWA held copies older still.
 *
 * The manifest already carries a per-chapter `content_hash`, so the cure costs
 * nothing at the origin: the object keeps its key, no re-upload happens, and
 * the URL simply stops being the same URL when the audio stops being the same
 * audio. The alternative — a hashed filename, `chapter_NNNN.<hash>.m4a` —
 * would put the hash where the listing can see it, but re-uploads every
 * chapter under a new key on every re-render and leaves the old objects
 * orphaned in the bucket forever.
 *
 * An absent hash returns the URL untouched. Hosts whose manifests have none
 * (karagame, brandonlandry.com) must not gain a parameter that changes when
 * nothing changed — that busts every reader's cache on every deploy, which is
 * the opposite failure.
 */
export function withContentVersion(url: string, hash: string | null | undefined): string {
  if (!hash) return url;
  return url + (url.includes('?') ? '&' : '?') + `${CONTENT_VERSION_PARAM}=${hash}`;
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
