// core-search.test.mjs — finding a passage across the whole library.
//
// Run: node test/core-search.test.mjs
//
// Measured on the real karagame transcripts (4 books, 62,033 chunks, 8.4 MB of
// text): 42 ms to parse, 10 ms for a full linear scan. There is no performance
// problem to design around, so this is a plain scan rather than an index — the
// only real constraint is that other books' transcripts are not on the client
// yet, which is a loading problem, not a searching one.
//
// Contract under test:
//   A. matches are case-insensitive
//   B. results carry everything needed to navigate: book, chapter, chunk, and
//      the chunk's start time
//   C. results are grouped by book with counts — a flat list is 47k rows for a
//      common word
//   D. a chunk matching twice is ONE result, not two
//   E. an empty or whitespace query matches nothing, rather than everything
//   F. queries shorter than the minimum match nothing — one letter is 40k rows
//      and answers no question
//   G. regex metacharacters are literal: searching for "*" must not throw or
//      match everything
//   H. searching a book whose transcript has not loaded yet yields nothing for
//      that book, without failing the books that have
//   I. results preserve chapter and chunk order within a book, so "next match"
//      moves forward through the text
//   J. a snippet of surrounding context comes back, trimmed, for display
//   K. summary chunks are searched when the book is in summary mode, because
//      that is the text actually on screen

import assert from 'node:assert';
import { test } from 'node:test';
import { searchBooks, MIN_QUERY } from '../audiobook/player-src/src/core/search.ts';

const alpha = {
  slug: 'alpha',
  chapters: [
    {
      index: 1,
      chunks: [
        { index: 0, text: 'The dragon roared at dawn.', start: 0, end: 3 },
        { index: 1, text: 'Aria drew her blade.', start: 3, end: 6 },
      ],
      summary_chunks: [
        { index: 0, text: 'A dragon; Aria draws.', start: 0, end: 2 },
      ],
    },
    {
      index: 2,
      chunks: [
        { index: 0, text: 'DRAGON fire lit the valley, dragon smoke above.', start: 0, end: 4 },
      ],
    },
    {
      index: 3,
      // UPPERCASE ONLY. Without this, a case-sensitive implementation still
      // found both other chunks (each contains a lowercase 'dragon' somewhere)
      // and the contract passed while being false. Mutation caught it.
      chunks: [
        { index: 0, text: 'THE DRAGON SLEPT.', start: 0, end: 2 },
      ],
    },
  ],
};

const beta = {
  slug: 'beta',
  chapters: [
    { index: 1, chunks: [{ index: 0, text: 'No beasts here. Only rain *and* fog.', start: 0, end: 5 }] },
  ],
};

const books = [
  { slug: 'alpha', title: 'Alpha' },
  { slug: 'beta', title: 'Beta' },
  { slug: 'gamma', title: 'Gamma' },   // transcript never loaded
];

const loaded = { alpha, beta };

function run(query, opts = {}) {
  return searchBooks({ books, transcripts: loaded, query, ...opts });
}

test('A. matching is case-insensitive', () => {
  const groups = run('dragon');
  const all = groups.flatMap((g) => g.matches);
  assert.equal(all.length, 3, JSON.stringify(all.map((m) => m.text)));
  assert.ok(all.some((m) => m.text === 'THE DRAGON SLEPT.'),
            'an uppercase-only chunk was missed');
});

test('B. a result carries what navigation needs', () => {
  const m = run('blade')[0].matches[0];
  assert.equal(m.bookSlug, 'alpha');
  assert.equal(m.chapterIndex, 1);
  assert.equal(m.chunkIndex, 1);
  assert.equal(m.start, 3);
});

test('C. results are grouped by book with counts', () => {
  const groups = run('dragon');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].bookSlug, 'alpha');
  assert.equal(groups[0].title, 'Alpha');
  assert.equal(groups[0].count, 3);
});

test('D. a chunk matching twice is one result', () => {
  // Chapter 2's chunk says "DRAGON" and "dragon".
  const ch2 = run('dragon')[0].matches.filter((m) => m.chapterIndex === 2);
  assert.equal(ch2.length, 1);
});

test('E. an empty query matches nothing', () => {
  assert.deepEqual(run(''), []);
  assert.deepEqual(run('   '), []);
  assert.deepEqual(run(null), []);
  // Padding is trimmed rather than searched for: without a trim, '   ' also
  // matched nothing (no chunk has three spaces) and this contract passed
  // vacuously. A padded REAL query is what tells the two apart.
  assert.equal(run('  dragon  ').flatMap((g) => g.matches).length, 3);
});

test('F. a too-short query matches nothing', () => {
  assert.deepEqual(run('a'.repeat(MIN_QUERY - 1)), []);
  assert.ok(run('a'.repeat(MIN_QUERY)).length >= 0);   // just must not throw
});

test('G. regex metacharacters are literal', () => {
  const groups = run('*and*');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].bookSlug, 'beta');
  // And a lone metacharacter neither throws nor matches everything.
  const dots = run('...');
  assert.ok(Array.isArray(dots));
  assert.equal(dots.flatMap((g) => g.matches).length, 0);
});

test('H. an unloaded book is skipped, not fatal', () => {
  const groups = run('dragon');
  assert.ok(!groups.some((g) => g.bookSlug === 'gamma'));
  assert.equal(groups[0].count, 3, 'loaded books still returned their matches');
});

test('I. matches are in reading order within a book', () => {
  const ms = run('dragon')[0].matches;
  const keys = ms.map((m) => `${m.chapterIndex}:${m.chunkIndex}`);
  assert.deepEqual(keys, [...keys].sort());
});

test('J. a display snippet comes back', () => {
  const m = run('blade')[0].matches[0];
  assert.ok(m.snippet.toLowerCase().includes('blade'));
  assert.ok(m.snippet.length <= 160);
});

test('K. summary mode searches the summary text', () => {
  const groups = run('draws', { summaryFor: { alpha: true } });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matches[0].chunkIndex, 0);
  // ...and the full text is NOT searched in summary mode: it is not on screen,
  // so a hit there would seek to a position the reader cannot see.
  assert.deepEqual(run('roared', { summaryFor: { alpha: true } }), []);
});
