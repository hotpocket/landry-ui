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
//   I. a malformed hash reads as the library rather than throwing — the boot
//      path calls slugFromHash, so a URIError there takes the whole player down
//   K. a chapter may be named after the book: '#/<slug>/<n>', 1-based, the same
//      ordinal the list shows. Reading it must not corrupt the slug — the whole
//      point of the segment is that '#/abc/3' still opens book 'abc'.
//   L. the chapter segment is optional and hostile input degrades to "no
//      chapter" rather than to a bad book: it runs on the boot path, and an
//      exception there is a blank player.
//   M. an encoded slug survives a chapter segment, because a host-supplied slug
//      may contain the separator and the hash encodes it.
//   J. collidingSlugs names books that resolve to the same hash. Truncation at
//      MAX_SLUG can do it to two titles that differ only after character 60,
//      and bookIdxFromSlug then sends both hashes to the first book — the second
//      is unreachable by URL, with nothing said. NOT fixed by making the slug
//      unique: a content suffix would change the slug of every long-titled book
//      that already exists, orphaning live links and stored positions, which is
//      the property this file exists to protect. Detected, and left to the human.

import assert from 'node:assert';
import { test } from 'node:test';
import {
  slugify, bookSlug, bookIdxFromSlug, hashForBook, slugFromHash, collidingSlugs,
  hashForChapter, routeFromHash,
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

test('I. a malformed percent escape reads as the library, not a throw', () => {
  // decodeURIComponent('%') throws URIError. slugFromHash runs in start() before
  // the first book opens, so an unthrown one is a blank page, not a bad route.
  for (const bad of ['#/%', '#/%zz', '#/a%', '#/%E0%A4%A']) {
    assert.equal(slugFromHash(bad), null, `${bad} did not degrade to the library`);
  }
});

test('H2. slugs survive URL encoding round-trip', () => {
  // Slugs are already URL-safe by construction, but the hash is encoded on the
  // way out; decoding must return the same slug or lookup fails after a reload.
  const s = bookSlug(books[2]);
  assert.equal(slugFromHash(hashForBook(books, 2)), s);
});

test('J. two titles that differ only past the cap are named as colliding', () => {
  assert.deepEqual(collidingSlugs(books), [], 'a clean library reports nothing');

  // 60 identical characters, then a difference the slug cannot carry.
  const stem = 'the-same-opening-sixty-characters-of-a-very-long-book-title-';
  assert.equal(stem.length, 60);
  const pair = [{ title: stem + 'Volume One' }, { title: stem + 'Volume Two' }];
  assert.equal(slugify(pair[0].title), slugify(pair[1].title), 'the premise: the slugs are equal');
  assert.deepEqual(collidingSlugs(pair), [slugify(pair[0].title)]);

  // And the damage it stands for: the second book is unreachable.
  assert.equal(bookIdxFromSlug(pair, bookSlug(pair[1])), 0);

  // An explicit duplicate slug counts too — same outcome, different cause.
  assert.deepEqual(collidingSlugs([{ slug: 'a' }, { slug: 'a' }, { slug: 'b' }]), ['a']);

  // Each colliding slug is named once, however many books land on it.
  assert.deepEqual(collidingSlugs([{ slug: 'a' }, { slug: 'a' }, { slug: 'a' }]), ['a']);

  assert.deepEqual(collidingSlugs([]), []);
});

test('K. a chapter is named after the book, 1-based', () => {
  assert.equal(hashForChapter(books, 1, 3), '#/repo-story/3');
  assert.equal(routeFromHash('#/repo-story/3').slug, 'repo-story');
  assert.equal(routeFromHash('#/repo-story/3').chapter, 3);

  // The regression the segment could cause: the book must still resolve.
  assert.equal(bookIdxFromSlug(books, slugFromHash('#/repo-story/3')), 1);
});

test('K2. no chapter segment means no chapter, and the book still reads', () => {
  assert.deepEqual(routeFromHash('#/repo-story'), { slug: 'repo-story', chapter: null });
  assert.deepEqual(routeFromHash(''), { slug: null, chapter: null });
  assert.equal(hashForChapter(books, 1, null), '#/repo-story');
  assert.equal(hashForChapter(books, null, 3), '');
});

test('L. a chapter segment that is not a chapter reads as none, never as a throw', () => {
  // Every one of these reaches start() on a cold load. A URIError or a NaN
  // chapter here is a player that never mounts, or one that seeks nowhere.
  for (const bad of ['#/repo-story/0', '#/repo-story/-1', '#/repo-story/abc',
                     '#/repo-story/1.5', '#/repo-story/', '#/repo-story/3/4']) {
    const r = routeFromHash(bad);
    assert.equal(r.chapter, null, `${bad} produced a chapter`);
    // And it degrades to the BOOK, not to the library: a junk tail must not
    // cost the reader the book they asked for. Asserted because "chapter is
    // null" alone is satisfied by a function that never finds anything.
    assert.equal(r.slug, 'repo-story', `${bad} lost the book`);
  }
  // A malformed escape still degrades to the library rather than throwing.
  assert.equal(routeFromHash('#/%/2').slug, null);
  assert.equal(slugFromHash('#/%/2'), null);
});

test('M. a slug containing the separator survives a chapter segment', () => {
  // Slugs from slugify never contain '/', but `slug` is host-supplied and the
  // hash encodes it. Splitting the DECODED string would eat the slug.
  const odd = [{ slug: 'a/b' }];
  assert.equal(hashForChapter(odd, 0, 2), '#/a%2Fb/2');
  assert.deepEqual(routeFromHash('#/a%2Fb/2'), { slug: 'a/b', chapter: 2 });
  assert.equal(bookIdxFromSlug(odd, routeFromHash('#/a%2Fb/2').slug), 0);
});
