---
type: session
date: 2026-08-07
projects: [landry-ui, chatterbook, books]
concern: audiobooks
summary: "Decomposed the 1,624-line vanilla player into a framework-free TS core plus a Preact view and shipped it to books.landry.bot, then landed all seven outstanding todos across three repos. Parity is 183 assertions passing UNEDITED via a new scripts/parity.sh that refuses to run if it would test vanilla against itself. Mutation testing found eleven real defects in the new work, including an unloaded book displaying as 100% complete and a sign-out that would have stopped clearing the session cookie."
status: complete
---

# Player port, and the seven

## For humans

The vanilla player was a blob by measurement, not opinion: 1,624 lines, one
IIFE, **68 functions over 54 module-level mutable `var`s**. It is now a
framework-free TypeScript core (clock, routing, progress, transcript, scene
breaks, retry/prefetch policy, search, recency — 81 node assertions, no browser)
plus a Preact view. Live on books.landry.bot.

The bundle got *smaller*: **16.3 KB gzip** for the whole player including the
Preact runtime, against **17.8 KB** for vanilla's JS alone. React + ReactDOM
would have been ~45 KB of runtime before a line of player code, which is why
this ships `preact/compat` — the source is idiomatic React, so switching later
is a build-config change rather than a rewrite.

All seven todos landed: search, sharing, the reading-mode progress line,
per-chapter dates, summary passthrough, the `luinst` local source, and the
README. Two deploys went out (Lambda then shell), `live_check` green at 28/28
each time.

**Not verified: the device.** No headless test reaches real screen-off. The
5-minute checklist is in `docs/plan-player-v2.md`. Rollback is one line —
`PLAYER=` in books' `scripts/build-shell.sh` back to `audiobook/vanilla`.

## Next steps

- Device-test on a phone: lock screen, cross a chapter boundary, lock-screen
  controls, 10 minutes screen-off, wifi→cellular, reading mode.
- If a book 403s right after this deploy, **sign out and back in** before
  suspecting the port: entitlement cookies moved from `Path=/` to
  `Path=/priv/<space>/` and a browser holding both sends both until the old set
  expires (15 min).
- Share a real book with a real second account. The grant paths are covered by
  fakes and `/api/users` correctly 401s in production, but nothing has crossed
  a space boundary for real yet.
- Run `chatterbook/scripts/backfill_dates.py` against wbt's S3 prefix so the
  ~1,128 published chapters get dates and the "new" badge starts working.

## For agents

### The parity harness is the load-bearing artifact

`landry-ui/scripts/parity.sh` stages a copy of the tree with the built player
behind the path the suites already load from (`audiobook/vanilla/player.js`),
so **the suites run unedited**. It refuses to run if the staged file is
identical to vanilla — otherwise a green run could mean "tested vanilla against
itself", which is the failure mode that makes a parity check worthless.
Verified sensitive by md5 and by breaking the build on purpose.

183 assertions across 10 browser suites, plus 81 node assertions on the core.

### Mutation testing found eleven real defects in this session's own work

Not theoretical. Each was a surviving mutant that turned out to be a genuine
bug or a test that could not fail:

1. **An unloaded book displayed as 100% complete** — clamping alone turned a
   zero duration into `Infinity → 1`.
2. **A summary track polluted the manifest's book clock** — invisible through
   `build_site`, which accumulates its own offsets.
3. **A scene-break test never exercised the seek threshold** — the jump did not
   span the divider, so it passed for the wrong reason.
4. **A summary-transcript test passed when full text was substituted** — the
   assertion used a word present in both.
5. **The reading-mode line passed its "hidden" test for the wrong reason** —
   zero height, not `display:none`.
6. **Sign-out would have stopped clearing the session cookie** — `headers +=`
   → `headers =` left the caller signed in.
7. **A case-insensitivity test could not detect case sensitivity** — every
   fixture chunk also contained the lowercase form.
8. **A whitespace-query test passed untrimmed** — no chunk contains three
   spaces, so trimming was untested.
9. **A search suite reported nothing on failure** — bare `await waitFor…`
   followed by `ok()` crashes instead of failing, so a timeout counted as
   neither pass nor fail.
10. **The menu's toggle-closed behaviour was untested** — the test switched
    between two books, where "one menu open" held either way.
11. **A grant-cap test capped the wrong side** — the limit is per grantee
    (their browser's cookies), not per owner.

Four other survivors were **unreachable code rather than untested code** and
were deleted: an empty-slug guard in `bookIdxFromSlug`, a duplicate
divide-by-zero guard, a zero/backwards-progress check the scene window already
excluded, and a `summary:none` hash sentinel. Two were kept deliberately with
the reason recorded in-comment (a "no record yet" guard and a "no date" guard):
mutation cannot distinguish them from their fallbacks, but routing normal
operation through an exception handler or through NaN semantics reads worse
than the redundancy costs.

### Sharing: why DynamoDB alone could not do it

The Lambda is never in the path of an audio fetch. CloudFront behaviours are
pinned at S3 prefixes and the only gate is a signed cookie whose policy is
literally `https://<domain>/priv/<space_id>/*` — and a CloudFront custom policy
holds **exactly one statement**. A grant recorded only in the database lists a
book and then 403s every chapter of it.

Solved by **path-scoping**: the three CloudFront cookie names are fixed, so two
sets at `Path=/` overwrite each other, but scoped to `/priv/<space>/` the
browser sends exactly the set matching the object being fetched. Grants are
keyed on the **grantee** (`SPACE#<grantee>` / `GRANT#<owner>#<book>`) so a
reader's library is one query; the cap of 40 is a browser cookie limit and is
therefore counted per grantee, refused loudly rather than truncated.

### Rejected, with the reason, so nobody re-derives it

- **Signed URLs per object.** Both media cache policies use
  `query_string_behavior=all()`, so every user's signed URL is a distinct
  CloudFront cache object — a shared or public book loses edge caching entirely,
  per reader. The service worker caches by URL too, so offline downloads churn.
- **Server-side search.** Measured on the real karagame transcripts (4 books,
  62,033 chunks, 8.4 MB of text): 4.3 MB gzip over the wire, 42 ms to parse,
  **10 ms for a full linear scan**. There is no performance problem. A Lambda
  would also have left karagame and brandonlandry.com — static, no API — with
  no search at all.
- **An S3 "symlink".** S3 has none; `x-amz-website-redirect-location` needs the
  website endpoint and forfeits OAC. The idea survives as a CloudFront Function
  URI rewrite — provably viable, because the signature is validated against the
  *viewer-facing* URL while the existing function strips `/pub`/`/priv` before
  the origin. The blocker is authorizing the rewrite: CF Functions cannot read
  DynamoDB, so the grant would have to prove itself via an HMAC'd cookie the
  function verifies. **CloudFront Functions runtime 2.0 reportedly has a
  `crypto` module with HMAC — unverified, confirm against live AWS before
  betting on it.** Revisit only if grants exceed ~50.

### Traps found the hard way

- **`deploy.sh --shell-only` uploads `build/site` as it stands and does not
  rebuild.** This shipped a shell older than the player, and `live_check` stayed
  green because it does not cover the changed feature. Now `push_shell` refuses
  a shell whose `player.js` differs from the source and names the fix.
- **`luinst` clones**, so a local `LANDRY_UI` source installs the last *commit*,
  not the working tree. That is deliberate — uncommitted UI must not ship — but
  it warns loudly when the checkout is dirty, and always prints which source won.
- **Node 24 strips TypeScript types natively**, so `test/core-*.test.mjs` import
  `.ts` directly. The core is testable with no build step and no browser.
- **Source lives in `audiobook/player-src/`, not `audiobook/player/src/`**,
  because `luinst` does `cp -r <component>/* <dest>/` and would otherwise ship
  `node_modules/` to every consumer.
- **`sw.js` ships byte-identical** and is pinned by a checksum assertion in
  `test/vanilla-retirement.test.mjs`. It is framework-agnostic, so the iOS
  streamed-206 path cannot regress across the port by construction.
- **`audiobook/vanilla/` retirement is a self-liquidating flag**: the checklist
  in `RETIREMENT.md` is read by a test that goes red once the last consumer is
  ticked off.

Plan of record, with every measurement and rejected alternative:
`landry-ui/docs/plan-player-v2.md`.
