// core-remote-progress.test.mjs — a reading position that outlives one browser.
//
// Run: deno test -A --no-check test/core-remote-progress.test.mjs
//      (node --test test/core-remote-progress.test.mjs where node exists)
//
// Progress has been a fact only one browser knows since the player shipped.
// The server half landed in books (GET/PUT /api/me/progress/<book_id>); this
// is the player half, and it is deliberately NOT a fetch client: the engine
// never names fetch, the host injects a backend, and a host that injects
// nothing gets exactly today's behaviour. Signed-out listeners stay
// localStorage-only and no anonymous id is ever minted.
//
// Two rules shape everything here and both are about not being trusted with
// someone's place in a book:
//
//   * The remote record is an OFFER, never a seek. A device that was paused
//     for a month must not yank a listener mid-chapter because it woke up.
//   * A PUT costs a GSI query on a public book (readable_book()), so the
//     cadence is events a person caused — pause, chapter change, the page
//     going away — never a timer and never a timeupdate.
//
// Contract under test:
//   A. no backend injected is no calls at all — the paired case with a spy
//      backend is what makes that assertion able to fail
//   B. a list() that rejects is swallowed; start() still resolves, and the
//      failure is recorded once through the diag seam
//   C. a remote record that is NEWER and DIFFERENT is offered
//   D. a remote record OLDER than the local savedAt is not offered
//   E. same chapter, within 30 s: not offered — that is the same place
//   F. same chapter, more than 30 s apart: offered
//   G. no local record at all: offered (there is nothing to be newer than)
//   H. a dismissal suppresses re-offering THAT remote record
//   I. a later remote update is offered again despite the old dismissal
//   J. coalescing: three puts while the first is in flight are two calls, and
//      the second carries the LAST position, not the middle one
//   K. a put that rejects is swallowed, and does not wedge the queue
//   L. a put with nothing in flight goes out once, with what it was given
//   M. device and contentVersion ride along when present, are omitted when not
//   N. a position the server would refuse is never sent — a 400 still costs
//      the round trip, and on a public book the GSI query that precedes it
//   O. the offer text names the chapter, the position, and the device

import assert from 'node:assert';
import { test } from 'node:test';
import {
  RemoteProgress, remoteRecordFor, offerText, DRIFT_S,
  leavesAChapter, chapterIdxForN, landingSeconds,
} from '../audiobook/player-src/src/core/remote-progress.ts';

function fakeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

/** A backend whose puts hang until the test lets them go. */
function fakeBackend(records = []) {
  const gates = [];
  const b = {
    records,
    listCalls: 0,
    listRejects: false,
    puts: [],
    list() {
      b.listCalls++;
      return b.listRejects ? Promise.reject(new Error('offline')) : Promise.resolve(b.records);
    },
    put(bookId, rec) {
      b.puts.push({ bookId, rec });
      return new Promise((resolve, reject) => gates.push({ resolve, reject }));
    },
    /** Let the nth outstanding put finish. */
    settle: (i = 0) => { gates[i].resolve(); return tick(); },
    fail: (i = 0) => { gates[i].reject(new Error('500')); return tick(); },
  };
  return b;
}

// Two turns: one for the backend's promise, one for the continuation that
// drains the queue. A single turn reports "no second put" for a queue that
// works, which is a false pass on the assertion J exists for.
const tick = () => new Promise((r) => setTimeout(r, 0));

const remote = (over = {}) => ({
  bookId: 'b1', chapterN: 3, seconds: 100,
  updatedAt: '2026-09-16T12:00:00.000Z', ...over,
});

const local = (over = {}) => ({
  bookId: 'b1', bookTime: 100, progress: 0.5, chapterIdx: 2, chapterN: 3,
  timeInChapter: 100, summary: false, savedAt: '2026-09-16T11:00:00.000Z', ...over,
});

const sync = (over = {}) => new RemoteProgress({
  store: fakeStore(), nowIso: () => '2026-09-16T13:00:00.000Z', ...over,
});

test('A. no backend injected means no calls, and a spy backend proves the assertion can fail', async () => {
  const spy = fakeBackend([remote()]);
  const wired = sync({ backend: spy });
  await wired.start();
  wired.put('b1', 3, 100);
  assert.equal(spy.listCalls, 1, 'a wired backend is listed');
  assert.equal(spy.puts.length, 1, 'a wired backend is put to');

  // The diag spy is what makes "no calls" observable. A put with no backend
  // does not throw — send() catches a synchronous transport failure on
  // purpose — so without this the guard could be deleted and nothing would
  // notice. It reaches the failure path instead, and that path is loud.
  const seen = [];
  const bare = sync({ onDiag: (ev, extra) => seen.push([ev, extra]) });
  assert.equal(bare.enabled(), false);
  await bare.start();                       // must resolve, not throw
  bare.put('b1', 3, 100);                   // must be a no-op, not a throw
  await tick();
  assert.deepEqual(seen, [], 'nothing was attempted, so nothing failed');
  assert.equal(bare.ready, false, 'nothing was ever listed');
  assert.equal(bare.offer('b1', null), null, 'with no backend there is nothing to offer');
});

test('B. a list() that rejects is swallowed and recorded once', async () => {
  const b = fakeBackend();
  b.listRejects = true;
  const seen = [];
  const s = sync({ backend: b, onDiag: (ev, extra) => seen.push([ev, extra]) });
  await s.start();                          // resolves; a rejection here is a blank page
  assert.equal(s.ready, false);
  assert.equal(s.offer('b1', local()), null, 'no records means nothing to offer');
  assert.equal(seen.length, 1, 'recorded once, not per book');
  assert.equal(seen[0][0], 'remote-list');
});

test('C. a newer, different remote record is offered', async () => {
  const b = fakeBackend([remote({ chapterN: 7, seconds: 12 })]);
  const s = sync({ backend: b });
  await s.start();
  const got = s.offer('b1', local());
  assert.ok(got, 'a different chapter, saved later elsewhere, is an offer');
  assert.equal(got.chapterN, 7);
});

test('D. a remote record older than the local save is not offered', async () => {
  const b = fakeBackend([remote({ chapterN: 7, updatedAt: '2026-09-16T10:00:00.000Z' })]);
  const s = sync({ backend: b });
  await s.start();
  assert.equal(s.offer('b1', local()), null,
    'this browser is the one that moved last; it is not behind anything');
});

test('E. the same chapter within 30 s is the same place, and is not offered', async () => {
  const b = fakeBackend([remote({ chapterN: 3, seconds: 100 + DRIFT_S })]);
  const s = sync({ backend: b });
  await s.start();
  assert.equal(s.offer('b1', local({ timeInChapter: 100 })), null,
    'exactly at the threshold is still the same place');
});

test('F. the same chapter more than 30 s apart is offered', async () => {
  const b = fakeBackend([remote({ chapterN: 3, seconds: 100 + DRIFT_S + 0.5 })]);
  const s = sync({ backend: b });
  await s.start();
  assert.ok(s.offer('b1', local({ timeInChapter: 100 })), 'past the threshold is a real gap');
});

test('G. a book with no local record at all is offered', async () => {
  const b = fakeBackend([remote()]);
  const s = sync({ backend: b });
  await s.start();
  assert.ok(s.offer('b1', null), 'nothing local means nothing to be newer than');
});

test('H. a dismissal suppresses that remote record', async () => {
  const b = fakeBackend([remote({ chapterN: 7 })]);
  const store = fakeStore();
  const s = sync({ backend: b, store });
  await s.start();
  const got = s.offer('b1', local());
  assert.ok(got);
  s.dismiss(got);
  assert.equal(s.offer('b1', local()), null, 'asked and answered');
});

test('I. a LATER remote update is offered again despite the dismissal', async () => {
  const b = fakeBackend([remote({ chapterN: 7 })]);
  const store = fakeStore();
  const s = sync({ backend: b, store });
  await s.start();
  s.dismiss(s.offer('b1', local()));

  // The other device moved again. A dismissal is about one record, not about
  // the book: keyed on the book alone it would silence every future device.
  const later = fakeBackend([remote({ chapterN: 9, updatedAt: '2026-09-16T12:30:00.000Z' })]);
  const s2 = new RemoteProgress({ store, backend: later, nowIso: () => 'x' });
  await s2.start();
  assert.ok(s2.offer('b1', local()), 'a new position from elsewhere is a new question');
});

test('J. three puts while the first is in flight are two calls, and the last position wins', async () => {
  const b = fakeBackend();
  const s = sync({ backend: b });
  await s.start();
  s.put('b1', 3, 10);
  s.put('b1', 3, 20);
  s.put('b1', 4, 30);
  assert.equal(b.puts.length, 1, 'one in flight per book');
  await b.settle(0);
  await tick();
  assert.equal(b.puts.length, 2, 'the queue drains to exactly one more call');
  assert.equal(b.puts[1].rec.seconds, 30, 'the middle position is superseded, not sent');
  assert.equal(b.puts[1].rec.chapterN, 4);
});

test('J2. a second book is not queued behind the first', async () => {
  const b = fakeBackend();
  const s = sync({ backend: b });
  await s.start();
  s.put('b1', 3, 10);
  s.put('b2', 1, 5);
  assert.equal(b.puts.length, 2, 'coalescing is per book, not global');
});

test('K. a put that rejects is swallowed, and the queue still drains', async () => {
  const b = fakeBackend();
  const s = sync({ backend: b });
  await s.start();
  s.put('b1', 3, 10);
  s.put('b1', 3, 40);
  await b.fail(0);
  await tick();
  assert.equal(b.puts.length, 2, 'a failure must not strand the queued position');
  s.put('b1', 3, 50);
  await b.settle(1);
  await tick();
  assert.equal(b.puts.length, 3, 'and must not leave the book permanently in flight');
});

test('L. a put with nothing in flight goes out once, with what it was given', async () => {
  const b = fakeBackend();
  const s = sync({ backend: b });
  await s.start();
  s.put('b1', 5, 77.5);
  assert.equal(b.puts.length, 1);
  assert.equal(b.puts[0].bookId, 'b1');
  assert.equal(b.puts[0].rec.chapterN, 5);
  assert.equal(b.puts[0].rec.seconds, 77.5);
  assert.equal(b.puts[0].rec.updatedAt, '2026-09-16T13:00:00.000Z', 'the client stamps its own clock');
});

test('M. device and contentVersion ride along, and are omitted when absent', () => {
  const withBoth = remoteRecordFor('b1', 2, 3, {
    device: 'phone', contentVersion: 'v9', nowIso: () => 't',
  });
  assert.equal(withBoth.device, 'phone');
  assert.equal(withBoth.contentVersion, 'v9');

  const bare = remoteRecordFor('b1', 2, 3, { nowIso: () => 't' });
  assert.ok(!('device' in bare), 'an absent device is absent, not empty — the server bounds strings');
  assert.ok(!('contentVersion' in bare), 'same for a book whose version the player does not know');
});

test('N. a position the server would refuse is never sent', async () => {
  const b = fakeBackend();
  const s = sync({ backend: b });
  await s.start();
  s.put('b1', null, 10);          // no chapter number: chapter_n must be >= 1
  s.put('b1', 0, 10);             // a list position, not a chapter number
  s.put('b1', 2, NaN);            // json.loads parses a bare NaN; the API rejects it
  s.put('b1', 2, -1);
  s.put('', 2, 10);               // no book id: the URL would be /api/me/progress/
  assert.equal(b.puts.length, 0,
    'a 400 still costs a round trip, and on a public book the GSI query before it');
});

test('O. the offer text names the chapter, the position, and the device', () => {
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  assert.equal(offerText(remote({ chapterN: 3, seconds: 125 }), fmt),
    'Continue from Ch 3 · 2:05?');
  assert.equal(offerText(remote({ chapterN: 3, seconds: 125, device: 'phone' }), fmt),
    'Continue from Ch 3 · 2:05 on phone?');
});

// ---------------------------------------------------------------------------
// Landing a remote record, and the cadence that produces one.
//
// P-R are the decisions the engine used to hold inline. They are here for the
// reason every other decision in core/ is: `engine/player.ts` imports preact
// and touches the audio element, so the browser suites are the only thing that
// can run it — and the rules below are the ones a browser suite would be
// asserting through three layers of DOM anyway.
//
//   P. a chapter change records the position of the chapter being LEFT, and
//      only when it is a move within the book that is open
//   Q. a remote record names a chapter NUMBER; this build of the book has to
//      be asked where that is, because it may not be at n - 1 and may not be
//      here at all
//   R. the landing position is clamped into the chapter it lands in

test('P. leaving a chapter within the open book is the only thing that records one', () => {
  const at = (bookIdx, chapterIdx) => ({ bookIdx, chapterIdx });

  assert.equal(leavesAChapter(at(0, 2), at(0, 3)), true,
    'a move to the next chapter is the last moment the old position exists');

  // The element's clock resets on a new src, so the put has to happen on the
  // way out; a reload of the SAME chapter is not a way out. Recovery and the
  // stall watchdog both reload in place, and a PUT per recovery attempt is a
  // GSI query per attempt for a position that has not moved.
  assert.equal(leavesAChapter(at(0, 2), at(0, 2)), false,
    'a reload in place is not a move and costs no request');

  // The guard that matters: openBook retargets currentBookIdx BEFORE it loads
  // the new book's first chapter, so without the loaded chapter's own book
  // this would file book 0's offset under book 1.
  assert.equal(leavesAChapter(at(0, 2), at(1, 0)), false,
    "the outgoing book's position is openBook's to record, under the outgoing id");

  assert.equal(leavesAChapter(at(null, -1), at(0, 0)), false,
    'the first chapter of a session leaves nothing behind');
});

test('Q. a remote chapter number is looked up in this build of the book', () => {
  const chapters = [{ n: 3 }, { n: 4 }, { n: 5 }];

  assert.equal(chapterIdxForN(chapters, 4), 1,
    'the chapter\'s OWN number — n - 1 would be 3 here and point past the end');
  assert.equal(chapterIdxForN(chapters, 3), 0);

  // A record written against a book that has since been republished shorter.
  // Not a reason to throw and not a reason to seek to something else: the
  // offer is answered and the listener stays where they are.
  assert.equal(chapterIdxForN(chapters, 99), -1, 'not in this build');
  assert.equal(chapterIdxForN([], 1), -1);
  assert.equal(chapterIdxForN(chapters, null), -1, 'no number is no chapter');
});

test('R. the landing position is clamped into the chapter it lands in', () => {
  assert.equal(landingSeconds(30, 120), 30, 'inside the chapter, as sent');
  assert.equal(landingSeconds(300, 120), 120,
    'past the end of a republished-shorter chapter, not past the end of the audio');
  assert.equal(landingSeconds(-5, 120), 0, 'never behind the start');

  // Duration is 0 until the manifest says otherwise. Clamping against an
  // unknown duration would land every offer at 0:00, which is the one place
  // the listener certainly was not.
  assert.equal(landingSeconds(300, 0), 300, 'an unknown duration clamps nothing');
});
