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

import assert from 'node:assert';
import { test } from 'node:test';
import { withMediaQuery } from '../audiobook/player-src/src/core/media-url.ts';

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
