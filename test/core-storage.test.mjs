// core-storage.test.mjs — a Storage the player can always write to.
//
// Run: node --test test/core-storage.test.mjs
//
// `localStorage` is not a property that merely returns null when storage is
// unavailable. iOS Safari with Settings → Safari → Advanced → "Block All
// Cookies" throws SecurityError from the GETTER, so *naming the identifier* is
// enough to take down whatever is on the stack. In init() that is the mount,
// and the book page renders nothing at all — which is how books.landry.bot
// came to show a bare footer on a phone and nothing else.
//
// A second shape exists and is not the same one: storage that reads fine and
// throws on write (quota, and older private modes). Both must degrade to a
// store that works and forgets, never to a throw.
//
// Contract under test:
//   A. a getter that throws yields a working store rather than an exception
//   B. that store round-trips: what was set is what is read back
//   C. a usable storage IS used — writes land in it, not in a shadow
//   D. reads come from the real storage, including values it already held
//   E. a setItem that throws (quota) does not propagate...
//   F. ...and the value is still readable afterwards, so the session behaves
//   G. a getItem that throws reads as absent, not as a crash
//   H. an absent key is null, matching Storage's own contract
//   I. a shadowed key stops shadowing once a write succeeds — quota clears
//      mid-session, and a pinned stale value would outlive the condition

import assert from 'node:assert';
import { test } from 'node:test';
import { safeStorage } from '../audiobook/player-src/src/core/storage.ts';

const throwingGetter = () => { throw new Error('SecurityError: The operation is insecure.'); };

function fakeStorage(seed = {}, { failWrites = false, failReads = false } = {}) {
  const m = new Map(Object.entries(seed));
  const s = {
    failWrites,
    getItem: (k) => {
      if (failReads) throw new Error('read blocked');
      return m.has(k) ? m.get(k) : null;
    },
    setItem: (k, v) => {
      if (s.failWrites) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
    dump: () => Object.fromEntries(m),
  };
  return s;
}

test('A. a getter that throws yields a working store rather than an exception', () => {
  const s = safeStorage(throwingGetter);
  assert.doesNotThrow(() => s.setItem('rs-follow', '0'));
});

test('B. the fallback store round-trips', () => {
  const s = safeStorage(throwingGetter);
  s.setItem('rs-follow', '0');
  assert.equal(s.getItem('rs-follow'), '0');
});

test('C. a usable storage IS used — writes land in it', () => {
  const real = fakeStorage();
  safeStorage(() => real).setItem('rs-reading', '1');
  assert.deepEqual(real.dump(), { 'rs-reading': '1' });
});

test('D. reads come from the real storage, including what it already held', () => {
  const real = fakeStorage({ 'rs-summary': '1' });
  assert.equal(safeStorage(() => real).getItem('rs-summary'), '1');
});

test('E. a setItem that throws does not propagate', () => {
  const s = safeStorage(() => fakeStorage({}, { failWrites: true }));
  assert.doesNotThrow(() => s.setItem('rs-textsize-n', '2'));
});

test('F. a value written after a failed write is still readable', () => {
  const s = safeStorage(() => fakeStorage({}, { failWrites: true }));
  s.setItem('rs-textsize-n', '2');
  assert.equal(s.getItem('rs-textsize-n'), '2');
});

test('G. a getItem that throws reads as absent, not as a crash', () => {
  const s = safeStorage(() => fakeStorage({ 'rs-diag': 'x' }, { failReads: true }));
  assert.equal(s.getItem('rs-diag'), null);
});

test('H. an absent key is null', () => {
  assert.equal(safeStorage(throwingGetter).getItem('never-written'), null);
});

test('I. a shadowed key stops shadowing once a write succeeds', () => {
  const real = fakeStorage({}, { failWrites: true });
  const s = safeStorage(() => real);
  s.setItem('rs-textsize-n', '2');   // shadowed: the quota was full
  real.failWrites = false;           // ...and then it was not
  s.setItem('rs-textsize-n', '3');
  assert.equal(s.getItem('rs-textsize-n'), '3');
});
