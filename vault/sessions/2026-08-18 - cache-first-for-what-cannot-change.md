---
tags: [session, landry-ui, sw]
type: session
date: 2026-08-18
projects: [landry-ui]
concern: audiobooks
summary: "One commit: shell assets published under a content hash (?v=<hash>) are now served cache-first instead of network-first, removing a round trip per asset from every cold load. index.html deliberately stays network-first — it is the file that POINTS at the new hashes, so pinning it would freeze the shell at whatever version installed first. sw.js changed in vanilla/ and rebuilt into player/, byte-identity intact. The first draft of the test was green against a feature that did not exist: it fetched a path the fixture does not serve, so every assertion ran against 404s. A second assertion survives disabling the new branch entirely, because the network-first branch populates the same cache — annotated rather than left to read as a guard."
status: complete
---

# Cache-first for what cannot change

## For humans

books.landry.bot's first load was slow for reasons that were mostly its own
(see the books vault recap for 2026-08-18). landry-ui's share was one round trip
per shell asset.

Every shell file went **network-first**, including the ones published under a
content hash — `/app.js?v=55c71e30162e`. A hash in the URL makes the response
immutable *by construction*: new bytes are published under a new `?v=`. So that
round trip spent 0.1–0.3 s of a cold page load confirming an answer that could
not have changed.

Now: cache-first for anything carrying `?v=`, network-first for everything else.
`index.html` deliberately has no hash — it is the file that **points at** the new
hashes, so pinning it would freeze the whole shell at whatever version installed
first and no deploy would ever be picked up. That is contract **H**, asserted
both ways.

`cache.put` runs under `waitUntil` rather than being awaited, so bytes reach the
page before the write lands; the suite polls for the write instead of racing it.

`sw.js` was changed in `vanilla/` and rebuilt into `player/` — the deliberate act
`vanilla-retirement.test.mjs` asks for, byte-identity intact. Parity green: 184
assertions against the Preact build, suites unedited.

## Next steps

- Not pushed (`e6606bb`).
- The other consumers still fetch `main` and are on vanilla; this change is in
  vanilla, so they get it when they next fetch.

## For agents

**The first version of contract H was green against a feature that did not
exist.** It fetched `/player.js`, which `test/fixture/out/` does not serve — the
fixture holds only `index.html` and `audio/`. Every assertion ran against 404s,
and a 404 is not cached by either branch, so it passed. Use
`/audiobook/vanilla/player.js`, which the stub origin actually serves.

**One assertion in H survives disabling the new branch.** "The versioned asset
is written to the shell cache" passes either way, because the network-first
branch populates the same cache. It guards that the write happens at all and
makes the next assertion's timing deterministic; the **origin-hit count** is the
one that discriminates. Annotated in place rather than left to read as a
stronger guard than it is.

**`sw.js` is byte-identical between `vanilla/` and `player/`** and pinned by
checksum. Change it in `vanilla/` and run `player-src/build.mjs`; editing the
built copy fails the retirement test.

Related global change: the session that produced this also produced the
`/filmstrip` skill in `.configs` — screenshots every 100 ms of a cold load,
because three visual defects that day were invisible to every assertion and
obvious in a strip of frames.
