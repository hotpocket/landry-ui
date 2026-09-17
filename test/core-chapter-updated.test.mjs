import assert from 'node:assert/strict';
import {test} from 'node:test';
import {updatedDate,shortDate,chapterTranscript} from '../audiobook/player-src/src/core/transcript.ts';
test('source dates retain their original format',()=>assert.equal(shortDate('2020-10-19'),'2020/10/19'));
test('update dates require a timestamp with a timezone',()=>{
 for(const value of [null,undefined,'','garbage','2026-09-17','2026-09-17T10:00:00','2026-13-17T10:00:00Z']) assert.equal(updatedDate(value),'');
 assert.ok(updatedDate('2026-09-17T10:00:00Z'));
});
test('explicit chapter numbers win when positions differ',()=>{
 const actual={n:9,index:2,chunks:[]};
 assert.equal(chapterTranscript({chapters:[{n:4,index:1,chunks:[]},actual]},{id:0,n:9}),actual);
 assert.equal(chapterTranscript({chapters:[actual]},{id:1,n:7}),null);
});

test('mixed incremental transcripts still show legacy chapters',()=>{
 const legacy={index:1,chunks:[]};
 const book={chapters:[legacy,{n:2,index:2,chunks:[]}]};
 assert.equal(chapterTranscript(book,{id:0,n:1}),legacy);
});
