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
