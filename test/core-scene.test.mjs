// core-scene.test.mjs — the pause between scenes.
//
// Run: node test/core-scene.test.mjs
//
// The source marks a scene change with a "* * *" divider the narrator does not
// speak. Playback holds briefly when it crosses one. Every guard in here exists
// because without it the hold fires at a moment that is not a scene change —
// and a spurious two-second silence mid-sentence is worse than no feature.
//
// Contract under test:
//   A. an explicit scene_break flag marks a chunk
//   B. a divider of asterisks and whitespace marks a chunk
//   C. a single asterisk does not — emphasis is not a scene break
//   D. ordinary text does not, even mentioning asterisks
//   E. crossing a divider between the last tick and this one triggers
//   F. a divider exactly at the current time triggers (end-inclusive), one
//      exactly at the previous time does not (start-exclusive) — otherwise the
//      same divider fires on two consecutive frames
//   G. a backwards jump does not trigger — that is a seek, not playback
//   H. a large forward jump does not trigger — also a seek. The threshold is
//      what separates a frame from a scrub
//   I. a chapter change does not trigger, however the times line up
//   J. no divider in range means no trigger

import assert from 'node:assert';
import { test } from 'node:test';
import { isSceneBreak, crossedSceneBreak, SEEK_THRESHOLD_S } from '../audiobook/player-src/src/core/scene.ts';

const chunks = [
  { index: 0, text: 'the first scene ends', start: 0, end: 5 },
  { index: 1, text: '* * *', start: 5, end: 5 },
  { index: 2, text: 'the second scene begins', start: 5, end: 10 },
];

test('A. an explicit flag marks a scene break', () => {
  assert.equal(isSceneBreak({ text: 'anything', scene_break: true }), true);
});

test('B. an asterisk divider marks a scene break', () => {
  assert.equal(isSceneBreak({ text: '* * *' }), true);
  assert.equal(isSceneBreak({ text: '***' }), true);
  assert.equal(isSceneBreak({ text: '  *  *  ' }), true);
});

test('C. a single asterisk is not a scene break', () => {
  assert.equal(isSceneBreak({ text: '*' }), false);
});

test('D. ordinary text is not a scene break', () => {
  assert.equal(isSceneBreak({ text: 'she paused *then* went on' }), false);
  assert.equal(isSceneBreak({ text: '' }), false);
  assert.equal(isSceneBreak(null), false);
});

test('E. crossing a divider triggers', () => {
  assert.equal(crossedSceneBreak({ chunks, from: 4.9, to: 5.1, chapterChanged: false }), true);
});

test('F. the window is start-exclusive and end-inclusive', () => {
  // Divider is at 5. Arriving exactly at 5 triggers...
  assert.equal(crossedSceneBreak({ chunks, from: 4.9, to: 5, chapterChanged: false }), true);
  // ...and the next frame, having already passed it, must not fire again.
  assert.equal(crossedSceneBreak({ chunks, from: 5, to: 5.1, chapterChanged: false }), false);
});

test('G. a backwards jump does not trigger', () => {
  assert.equal(crossedSceneBreak({ chunks, from: 6, to: 4, chapterChanged: false }), false);
});

test('H. a large forward jump does not trigger', () => {
  // The jump must SPAN the divider, or this asserts nothing about the
  // threshold — the first version of this test jumped 0 → 1.6 with the divider
  // at 5, and passed because the window was empty. Mutation caught it.
  assert.equal(crossedSceneBreak({ chunks, from: 4.9, to: 4.9 + SEEK_THRESHOLD_S + 0.1, chapterChanged: false }), false);
  // Just inside the threshold still counts as playback.
  assert.equal(crossedSceneBreak({ chunks, from: 4.9, to: 4.9 + SEEK_THRESHOLD_S, chapterChanged: false }), true);
});

test('I. a chapter change does not trigger', () => {
  assert.equal(crossedSceneBreak({ chunks, from: 4.9, to: 5.1, chapterChanged: true }), false);
});

test('J. no divider in range means no trigger', () => {
  assert.equal(crossedSceneBreak({ chunks, from: 1, to: 1.5, chapterChanged: false }), false);
  assert.equal(crossedSceneBreak({ chunks: [], from: 1, to: 1.5, chapterChanged: false }), false);
});

test('K. no progress at all does not trigger', () => {
  // A paused player ticks with from === to; the divider sits exactly there.
  assert.equal(crossedSceneBreak({ chunks, from: 5, to: 5, chapterChanged: false }), false);
});
