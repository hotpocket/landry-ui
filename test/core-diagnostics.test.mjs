// core-diagnostics.test.mjs — the evidence a phone leaves behind.
//
// Run: node test/core-diagnostics.test.mjs
//
// Every playback failure so far was diagnosed by reading code, because a phone
// with its screen off has no console and the person listening is not at the
// machine. This is the buffer that makes the next one explainable: capped, so a
// long listen cannot fill storage the progress records share, and newest-wins,
// because the failure being reported is the recent one.
//
// Contract under test:
//   A. an entry appends, and reads back as an object
//   B. the buffer is capped: past the cap the OLDEST go, the newest survive
//   C. absent or corrupt storage reads as empty and still accepts a write —
//      diagnostics must never be the thing that breaks playback
//   D. order is chronological, so a sequence (error → retry → gave up) can be
//      read as a sequence

import assert from 'node:assert';
import { test } from 'node:test';
import { appendDiag, readDiag, DIAG_MAX } from '../audiobook/player-src/src/core/diagnostics.ts';

const entry = (n) => ({ at: `2026-08-09T00:00:${String(n).padStart(2, '0')}Z`, ev: 'error', ch: n });

test('A. an entry appends and reads back', () => {
  const stored = appendDiag(null, entry(1));
  const got = readDiag(stored);
  assert.equal(got.length, 1);
  assert.equal(got[0].ev, 'error');
  assert.equal(got[0].ch, 1);
  assert.equal(got[0].at, '2026-08-09T00:00:01Z');
});

test('B. the buffer is capped, dropping the oldest', () => {
  let s = null;
  for (let i = 0; i < DIAG_MAX + 5; i++) s = appendDiag(s, entry(i));
  const got = readDiag(s);
  assert.equal(got.length, DIAG_MAX);
  assert.equal(got[0].ch, 5, 'the five oldest were dropped, not the five newest');
  assert.equal(got[got.length - 1].ch, DIAG_MAX + 4);
});

test('B. the cap is overridable and always honoured', () => {
  let s = null;
  for (let i = 0; i < 10; i++) s = appendDiag(s, entry(i), 3);
  assert.deepEqual(readDiag(s).map((e) => e.ch), [7, 8, 9]);
});

test('C. corrupt or missing storage reads empty and still writes', () => {
  assert.deepEqual(readDiag(null), []);
  assert.deepEqual(readDiag(''), []);
  assert.deepEqual(readDiag('{not json'), []);
  // A JSON object rather than an array: valid JSON, wrong shape.
  assert.deepEqual(readDiag('{"a":1}'), []);
  const recovered = readDiag(appendDiag('{not json', entry(2)));
  assert.equal(recovered.length, 1, 'a corrupt buffer is replaced, not appended to');
  assert.equal(recovered[0].ch, 2);
});

test('D. order is chronological', () => {
  let s = appendDiag(null, { at: 't1', ev: 'error' });
  s = appendDiag(s, { at: 't2', ev: 'retry' });
  s = appendDiag(s, { at: 't3', ev: 'gave-up' });
  assert.deepEqual(readDiag(s).map((e) => e.ev), ['error', 'retry', 'gave-up']);
});
