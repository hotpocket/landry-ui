// core-media-url.test.mjs — appending the signature to a media URL.
//
// Run: node test/core-media-url.test.mjs
//
// Media is authorized by a signature in the query string, minted per book by
// the API. The player builds URLs by concatenation (base + filename), so the
// query has to be appended AFTER the filename — putting it on the base would
// produce `/audio/?Policy=…chapter_0001.m4a`, which is a different object and
// a 403.
//
// Contract under test:
//   A. no query configured leaves the URL untouched — karagame and
//      brandonlandry.com serve unsigned files and must keep working
//   B. a query is appended after the filename
//   C. an existing query on the URL is preserved, joined with &
//   D. a leading '?' or '&' in the configured query is tolerated, so callers
//      cannot produce '??' by being helpful
//   E. the filename is never modified — a signature must not change which
//      object is fetched
//   F. the signature's expiry is readable from the query, so a failure can
//      record whether the signature was already dead. The whole 15-minute
//      screen-off failure was invisible because nothing on the client knew
//      when its own signature ran out.
//   G. a recovery can force a genuinely new request. Reloading the SAME url
//      while a request for it hangs is coalesced onto the hung one — measured
//      2026-08-09: three watchdog reloads produced ONE request on the wire and
//      recovered nothing — so the stall path needs a URL the network stack has
//      not seen.
//   H. a chapter's audio URL carries the content hash of the audio it names,
//      so a re-rendered chapter is a DIFFERENT URL to every cache in the path.
//
//      THE CLASS: every artifact derived from source/N.txt that is addressed
//      by a name which does not move when the text does. Audio is published to
//      a stable S3 key under `public, max-age=31536000, immutable`; a
//      re-render lands on that same key, and nothing — CloudFront, the service
//      worker, the browser cache, an installed PWA — has any reason to ask for
//      it again. Measured 2026-08-25: a reader in a FRESH incognito profile was
//      served a 46-hour-old chapter (Age 165651, X-Cache Hit) whose bytes had
//      been replaced in S3 twenty hours earlier.
//
//      transcripts.json has carried `?v=<hash>` since the same defect bit the
//      text tier. This is the audio half of the same trick, and it is
//      deliberately the parameter that already exists rather than a new one.

import assert from 'node:assert';
import { test } from 'node:test';
import { withMediaQuery, secondsUntilExpiry, withCacheBust, withContentVersion, CONTENT_VERSION_PARAM }
  from '../audiobook/player-src/src/core/media-url.ts';

const Q = 'Policy=abc&Signature=def&Key-Pair-Id=KID';

test('A. no query leaves the URL alone', () => {
  assert.equal(withMediaQuery('/priv/s/b/audio/chapter_0001.m4a', ''), '/priv/s/b/audio/chapter_0001.m4a');
  assert.equal(withMediaQuery('/audio/x.m4a', undefined), '/audio/x.m4a');
  assert.equal(withMediaQuery('/audio/x.m4a', null), '/audio/x.m4a');
});

test('B. the query goes after the filename', () => {
  const u = withMediaQuery('/priv/s/b/audio/chapter_0001.m4a', Q);
  assert.equal(u, `/priv/s/b/audio/chapter_0001.m4a?${Q}`);
  assert.ok(u.indexOf('chapter_0001.m4a') < u.indexOf('Policy='),
            'the signature landed before the filename');
});

test('C. an existing query is preserved', () => {
  const u = withMediaQuery('/priv/s/b/transcripts.json?v=abc', Q);
  assert.equal(u, `/priv/s/b/transcripts.json?v=abc&${Q}`);
  assert.equal(u.split('?').length - 1, 1);
});

test('D. a leading ? or & is tolerated', () => {
  assert.equal(withMediaQuery('/a/x.m4a', `?${Q}`), `/a/x.m4a?${Q}`);
  assert.equal(withMediaQuery('/a/x.m4a', `&${Q}`), `/a/x.m4a?${Q}`);
  assert.equal(withMediaQuery('/a/x.m4a?v=1', `&${Q}`), `/a/x.m4a?v=1&${Q}`);
});

test('E. the path is never modified', () => {
  const u = withMediaQuery('/priv/s/b/audio/chapter_0042.m4a', Q);
  assert.equal(u.split('?')[0], '/priv/s/b/audio/chapter_0042.m4a');
});

// CloudFront's base64 is NOT the url-safe alphabet: + becomes -, = becomes _,
// / becomes ~. Encoded here the same way the API does it, so a decoder that
// only handles standard base64 fails this rather than passing on easy input.
function cfPolicy(expiresAt) {
  const raw = JSON.stringify({
    Statement: [{ Resource: 'https://books.landry.bot/priv/s/b/*',
                  Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt } } }],
  });
  const b64 = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
  return `Policy=${b64}&Signature=abc&Key-Pair-Id=KID`;
}

test('F. the signature expiry is readable from the query', () => {
  const now = 1_770_000_000_000;                       // fixed: no clock in a unit test
  const q = cfPolicy(now / 1000 + 600);
  assert.equal(secondsUntilExpiry(q, now), 600);
  // Already dead: negative, not clamped. "How long ago did it die" is the
  // number that explains a 403, and clamping to 0 throws it away.
  assert.equal(secondsUntilExpiry(cfPolicy(now / 1000 - 90), now), -90);
});

test('F. an unsigned or unreadable query has no expiry', () => {
  const now = 1_770_000_000_000;
  assert.equal(secondsUntilExpiry('', now), null);
  assert.equal(secondsUntilExpiry(undefined, now), null);
  assert.equal(secondsUntilExpiry('v=abc', now), null);            // no Policy at all
  // A parameter that merely ENDS in Policy is not the policy. Unanchored, this
  // reads someone else's value and reports an expiry that was never minted.
  assert.equal(secondsUntilExpiry(`Not${cfPolicy(now / 1000 + 60)}`, now), null);
  assert.equal(secondsUntilExpiry('Policy=not-base64!!', now), null);
  // Valid base64, wrong shape: an empty statement list must not read as expiry 0
  // (which would report every signature as long dead).
  const empty = Buffer.from(JSON.stringify({ Statement: [] })).toString('base64')
    .replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
  assert.equal(secondsUntilExpiry(`Policy=${empty}`, now), null);
});

test('F. the expiry is found alongside other parameters', () => {
  const now = 1_770_000_000_000;
  const q = 'v=7&' + cfPolicy(now / 1000 + 42);
  assert.equal(secondsUntilExpiry(q, now), 42);
  assert.equal(secondsUntilExpiry(`?${q}`, now), 42);
});

test('G. a cache bust makes a distinct URL, and only when asked', () => {
  // 0 is "no bust": the ordinary path must not carry a parameter that changes
  // the CloudFront cache key for every chapter anyone ever plays.
  assert.equal(withCacheBust('/a/x.m4a', 0), '/a/x.m4a');
  assert.equal(withCacheBust('/a/x.m4a', 1), '/a/x.m4a?rsr=1');
  assert.equal(withCacheBust(`/a/x.m4a?${Q}`, 2), `/a/x.m4a?${Q}&rsr=2`);
  assert.notEqual(withCacheBust('/a/x.m4a', 1), withCacheBust('/a/x.m4a', 2));
  // The object fetched is still the same object.
  assert.equal(withCacheBust('/a/chapter_0002.m4a', 3).split('?')[0], '/a/chapter_0002.m4a');
});

test('H. the content version addresses the URL by what it holds', () => {
  const HASH = '9f2c1ab4c0de5567';
  assert.equal(withContentVersion('/priv/s/b/audio/chapter_0003.m4a', HASH),
               `/priv/s/b/audio/chapter_0003.m4a?${CONTENT_VERSION_PARAM}=${HASH}`);
  // A different render is a different URL. This is the whole fix in one line:
  // no cache anywhere can answer the new URL with the old bytes.
  assert.notEqual(withContentVersion('/a/chapter_0003.m4a', 'aaaaaaaaaaaaaaaa'),
                  withContentVersion('/a/chapter_0003.m4a', 'bbbbbbbbbbbbbbbb'));
});

test('H. a host with no hashes is left exactly as it was', () => {
  // karagame and brandonlandry.com publish manifests with no content_hash, and
  // an invented parameter there would be a URL that changes when nothing did —
  // busting every reader's cache on every deploy, the opposite failure.
  for (const absent of ['', null, undefined]) {
    assert.equal(withContentVersion('/audio/chapter_0001.m4a', absent),
                 '/audio/chapter_0001.m4a');
  }
});

test('H. the version goes on before the signature, and the object is unchanged', () => {
  const HASH = '9f2c1ab4c0de5567';
  const url = withMediaQuery(withContentVersion('/priv/s/b/audio/chapter_0003.m4a', HASH), Q);
  assert.equal(url, `/priv/s/b/audio/chapter_0003.m4a?${CONTENT_VERSION_PARAM}=${HASH}&${Q}`);
  // E, restated for the version: the path still names the same S3 object, so
  // no re-upload and no key change are implied by any of this.
  assert.equal(url.split('?')[0], '/priv/s/b/audio/chapter_0003.m4a');
});

test('H. it is the same parameter transcripts.json already uses', () => {
  // One name, not two. The service worker keeps `v` in its cache key and
  // strips the signature parameters around it; a second spelling here would be
  // a second thing to keep in step with sw.js.
  assert.equal(CONTENT_VERSION_PARAM, 'v');
});

test('H. a URL that already has a query keeps it', () => {
  assert.equal(withContentVersion('/audio/x.m4a?rsr=2', 'abc'), '/audio/x.m4a?rsr=2&v=abc');
});
