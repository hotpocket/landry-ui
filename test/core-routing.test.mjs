// core-routing.test.mjs — the URL is the source of truth for which book is open.
//
// Run: node test/core-routing.test.mjs
//
// Refresh-keeps-your-place (2026-08-02) rests entirely on this: the hash names
// the book, so a reload reopens it. That makes slug stability a correctness
// property, not cosmetics — a slug that changes shape silently orphans every
// link and every restored session.
//
// Contract under test:
//   A. slugify lowercases, collapses runs of non-alphanumerics to one dash,
//      and trims dashes from both ends
//   B. slugify caps length, so a pathological title cannot produce an
//      unbounded URL
//   C. a title that slugifies to nothing does not yield an empty slug
//   D. an explicit slug wins over the title
//   E. the placeholder slug 'book' does NOT win — single-book sites ship it as
//      a default, and a library of them would collide on one URL
//   F. lookup by slug returns -1 for unknown slugs rather than a false 0
//   G. round-trip: every book in a library resolves back to its own index
//   H. the hash for a book is '#/<slug>', and the library is the empty hash

import assert from 'node:assert';
import { test } from 'node:test';
import {
  slugify, bookSlug, bookIdxFromSlug, hashForBook, slugFromHash,
} from '../audiobook/player-src/src/core/routing.ts';

const books = [
  { slug: 'book', title: 'The Weakest Beast Tamer' },
  { slug: 'repo-story', title: 'Repo Story' },
  { title: 'No Slug At All' },
];

test('A. slugify lowercases, collapses, and trims', () => {
  assert.equal(slugify('  The Weakest — Beast  Tamer!! '), 'the-weakest-beast-tamer');
});

test('B. slugify is length-capped', () => {
  const s = slugify('a'.repeat(200));
  assert.equal(s.length, 60);
});

test('C. an unslugifiable title yields an empty string, not a dash', () => {
  assert.equal(slugify('!!! ???'), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

test('D. an explicit slug wins over the title', () => {
  assert.equal(bookSlug({ slug: 'repo-story', title: 'Repo Story' }), 'repo-story');
});

test('E. the placeholder slug "book" loses to the title', () => {
  assert.equal(bookSlug(books[0]), 'the-weakest-beast-tamer');
});

test('E2. placeholder with no usable title falls back to "book"', () => {
  assert.equal(bookSlug({ slug: 'book', title: '???' }), 'book');
});

test('F. unknown slugs return -1', () => {
  assert.equal(bookIdxFromSlug(books, 'nope'), -1);
  assert.equal(bookIdxFromSlug(books, ''), -1);
  assert.equal(bookIdxFromSlug(books, null), -1);
});

test('G. every book round-trips to its own index', () => {
  books.forEach((b, i) => {
    assert.equal(bookIdxFromSlug(books, bookSlug(b)), i, `book ${i} did not round-trip`);
  });
});

test('H. hash form is #/<slug>; library is empty', () => {
  assert.equal(hashForBook(books, 1), '#/repo-story');
  assert.equal(hashForBook(books, null), '');
  assert.equal(slugFromHash('#/repo-story'), 'repo-story');
  assert.equal(slugFromHash(''), null);
});

test('H2. slugs survive URL encoding round-trip', () => {
  // Slugs are already URL-safe by construction, but the hash is encoded on the
  // way out; decoding must return the same slug or lookup fails after a reload.
  const s = bookSlug(books[2]);
  assert.equal(slugFromHash(hashForBook(books, 2)), s);
});
