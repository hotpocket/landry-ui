// vanilla-retirement.test.mjs — a self-liquidating flag.
//
// Run: node --test test/vanilla-retirement.test.mjs
//
// audiobook/vanilla/ outlives the Preact port only until its consumers switch.
// "Remember to delete it later" is not a plan, so the reminder is a test: it
// reads the checklist in RETIREMENT.md and goes red the moment the last
// consumer is ticked off, telling you to delete the directory.
//
// It also pins the one thing the port must not change: sw.js ships
// byte-identical, which is what makes the iOS Safari streamed-206 path unable
// to regress across the rewrite.
//
// Contract under test:
//   A. while consumers remain, the flag is quiet
//   B. when none remain, the flag fires and names what to do
//   C. the built service worker is byte-identical to the vanilla one
//   D. the checklist exists at all — deleting it must not silence the flag

import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const VANILLA = join(repo, 'audiobook', 'vanilla');
const BUILT = join(repo, 'audiobook', 'player');
const CHECKLIST = join(VANILLA, 'RETIREMENT.md');

/** Unticked boxes in the "Remaining consumers" list. */
export function remainingConsumers(markdown) {
  return markdown
    .split('\n')
    .filter((l) => /^\s*-\s*\[ \]/.test(l))
    .map((l) => l.replace(/^\s*-\s*\[ \]\s*/, '').trim());
}

test('D. the checklist exists', () => {
  assert.ok(existsSync(CHECKLIST),
    'audiobook/vanilla/RETIREMENT.md is missing — deleting the checklist must ' +
    'not be a way to silence the retirement flag');
});

test('A/B. vanilla still has consumers, or it is time to delete it', () => {
  const remaining = remainingConsumers(readFileSync(CHECKLIST, 'utf8'));
  assert.ok(remaining.length > 0,
    'no consumers left — delete audiobook/vanilla/ (and this test, and the ' +
    'copy step for it in audiobook/player-src/build.mjs)');
});

test('C. the built service worker is byte-identical to the vanilla one', () => {
  const sw = join(BUILT, 'sw.js');
  assert.ok(existsSync(sw), 'audiobook/player/sw.js is missing — run the build');
  const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  assert.equal(hash(sw), hash(join(VANILLA, 'sw.js')),
    'sw.js diverged from the vanilla one. It is framework-agnostic and ships ' +
    'byte-identical on purpose: that is what makes the iOS streamed-206 path ' +
    'unable to regress across the port. If it must change, change it in ' +
    'vanilla/ and rebuild, and say so in the plan.');
});
