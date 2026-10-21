// core-transcript.test.mjs — finding the words that match the audio.
//
// Run: node test/core-transcript.test.mjs
//
// Two indexing systems meet here and disagree by one: chapters carry a 0-based
// `id`, transcripts carry a 1-based `index`. That seam is the single most
// likely place for the transcript to silently follow the wrong chapter, so it
// gets pinned explicitly rather than left to the call sites.
//
// Contract under test:
//   A. a chapter's transcript is found by index === chapter.id + 1
//   B. a book is matched by slug
//   C. a book identified by filename matches after its extension is stripped
//   D. missing transcript data yields null rather than throwing
//   E. chunksFor returns summary chunks in summary mode
//   F. a chapter with no summary chunks yields an empty list in summary mode,
//      never the full chunks — showing full text against summary audio is
//      worse than showing none
//   G. findChunkAt is boundary-inclusive at start, exclusive at end
//   H. a time in a gap between chunks matches nothing, rather than sticking to
//      the previous chunk
//   I. times before the first and after the last chunk match nothing
//   J. an empty chunk list matches nothing
//   K. when BOTH sides carry the source chapter number, that is what pairs
//      them — position is not identity.
//
//      The two lists are built from different membership rules. A chapter is
//      in the manifest when it has an M4A and a title; it is in the transcript
//      when it has a WAV, an N.txt and a title. A chapter rendered to WAV but
//      not yet encoded is in one and not the other — the normal state of a tree
//      whose renderer encodes after it transcribes — and from that chapter on,
//      pairing by position shows every chapter the PREVIOUS chapter's text. No
//      error, no warning, and it lasts exactly as long as the gap does.
//
//      `n` is only consulted when both sides have it, so every host that has
//      not republished keeps the positional rule it has always had.

import assert from 'node:assert';
import { test } from 'node:test';
import {
  bookTranscript, chapterTranscript, chunksFor, findChunkAt,
} from '../audiobook/player-src/src/core/transcript.ts';

const data = {
  books: [
    {
      slug: 'repo-story',
      chapters: [
        {
          index: 1,
          chunks: [
            { index: 0, text: 'one', start: 0, end: 2 },
            { index: 1, text: 'two', start: 2, end: 4 },
            // deliberate gap 4..5
            { index: 2, text: 'three', start: 5, end: 7 },
          ],
          summary_chunks: [{ index: 0, text: 'summary one', start: 0, end: 1 }],
        },
        { index: 2, chunks: [{ index: 0, text: 'ch2', start: 0, end: 3 }] },
      ],
    },
  ],
};

test('A. a chapter transcript is found by index === id + 1', () => {
  const bt = bookTranscript(data, { slug: 'repo-story' });
  assert.equal(chapterTranscript(bt, { id: 0 }).index, 1);
  assert.equal(chapterTranscript(bt, { id: 1 }).index, 2);
  assert.equal(chapterTranscript(bt, { id: 5 }), null);
});

test('B. a book is matched by slug', () => {
  assert.equal(bookTranscript(data, { slug: 'repo-story' }).slug, 'repo-story');
  assert.equal(bookTranscript(data, { slug: 'nope' }), null);
});

test('C. a filename identity matches after the extension is stripped', () => {
  assert.equal(bookTranscript(data, { filename: 'repo-story.m4a' }).slug, 'repo-story');
});

test('D. missing transcript data yields null', () => {
  assert.equal(bookTranscript(null, { slug: 'repo-story' }), null);
  assert.equal(bookTranscript(data, null), null);
  assert.equal(chapterTranscript(null, { id: 0 }), null);
});

test('E. summary mode returns summary chunks', () => {
  const bt = bookTranscript(data, { slug: 'repo-story' });
  const ct = chapterTranscript(bt, { id: 0 });
  assert.equal(chunksFor(ct, true)[0].text, 'summary one');
  assert.equal(chunksFor(ct, false)[0].text, 'one');
});

test('F. a chapter without summary chunks yields none in summary mode', () => {
  const bt = bookTranscript(data, { slug: 'repo-story' });
  const ct = chapterTranscript(bt, { id: 1 });
  assert.deepEqual(chunksFor(ct, true), []);
});

test('G. chunk boundaries are start-inclusive, end-exclusive', () => {
  const chunks = data.books[0].chapters[0].chunks;
  assert.equal(findChunkAt(chunks, 0).text, 'one');
  assert.equal(findChunkAt(chunks, 1.999).text, 'one');
  assert.equal(findChunkAt(chunks, 2).text, 'two');
});

test('H. a time in a gap matches nothing', () => {
  const chunks = data.books[0].chapters[0].chunks;
  assert.equal(findChunkAt(chunks, 4.5), null);
  // Exactly on a chunk's end, with a gap after it. 4.5 alone could not tell
  // end-exclusive from end-inclusive — mutation caught that.
  assert.equal(findChunkAt(chunks, 4), null);
});

test('I. times outside the chunk range match nothing', () => {
  const chunks = data.books[0].chapters[0].chunks;
  assert.equal(findChunkAt(chunks, -1), null);
  assert.equal(findChunkAt(chunks, 99), null);
});

test('J. an empty chunk list matches nothing', () => {
  assert.equal(findChunkAt([], 0), null);
  assert.equal(findChunkAt(null, 0), null);
});

// --- K: identity beats position -------------------------------------------

// The transcript has an entry chapter 2 that the MANIFEST does not: chapter 2
// rendered to WAV and has not been encoded to M4A yet. So the manifest's
// chapters are n=1 (id 0) and n=3 (id 1), and this list has three entries.
const gapped = {
  books: [{
    slug: 'gapped',
    chapters: [
      { index: 1, n: 1, chunks: [{ index: 0, text: 'one', start: 0, end: 1 }] },
      { index: 2, n: 2, chunks: [{ index: 0, text: 'two', start: 0, end: 1 }] },
      { index: 3, n: 3, chunks: [{ index: 0, text: 'three', start: 0, end: 1 }] },
    ],
  }],
};
const gappedBt = bookTranscript(gapped, { slug: 'gapped' });
const plainBt = bookTranscript(data, { slug: 'repo-story' });

test('K. a chapter is paired by its number when both sides carry one', () => {
  assert.equal(chapterTranscript(gappedBt, { id: 0, n: 1 }).chunks[0].text, 'one');
  assert.equal(chapterTranscript(gappedBt, { id: 1, n: 3 }).chunks[0].text, 'three');
});

test('K. the instrument can see the defect it is here for', () => {
  // The same reader, paired by position: chapter 3's audio against chapter 2's
  // words. That is what a listener has been getting, with nothing to say so.
  const byPosition = gappedBt.chapters.find((c) => c.index === 1 + 1);
  assert.equal(byPosition.chunks[0].text, 'two');
  assert.notEqual(byPosition.chunks[0].text,
                  chapterTranscript(gappedBt, { id: 1, n: 3 }).chunks[0].text);
});

test('K. a transcript with no numbers still pairs by position', () => {
  // Every host that has not republished. `data` above carries no `n`.
  assert.equal(chapterTranscript(plainBt, { id: 0, n: 1 }).index, 1);
  assert.equal(chapterTranscript(plainBt, { id: 1, n: 2 }).index, 2);
});

test('K. a chapter with no number still pairs by position', () => {
  // The other half: a host whose chapter records carry no `n`.
  assert.equal(chapterTranscript(gappedBt, { id: 0 }).chunks[0].text, 'one');
  assert.equal(chapterTranscript(gappedBt, { id: 1 }).chunks[0].text, 'two');
});

test('K. a number that matches nothing does not fall back to a position', () => {
  // Silently showing the wrong chapter's text is the defect. Showing none is a
  // chapter that has not been transcribed yet, which is the truth.
  assert.equal(chapterTranscript(gappedBt, { id: 9, n: 99 }), null);
});
