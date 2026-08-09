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

import assert from 'node:assert';
import { test } from 'node:test';
import { withMediaQuery, secondsUntilExpiry, withCacheBust } from '../audiobook/player-src/src/core/media-url.ts';

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
