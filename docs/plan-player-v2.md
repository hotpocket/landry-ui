# Plan of record — player v2 + the seven todos

**Status: DELIVERED 2026-08-07/08.** Every item below shipped. This is kept as
the record of what was decided and why, not as a plan — read it for the
reasoning and the measurements behind choices that are now load-bearing, and see
`books/vault/sessions/` for what actually happened.

Two decisions recorded here were later **overturned by measurement** and are
marked inline: the signed-URL rejection (§ Rejected) and the parity assertion
count. Take the marked corrections, not the original text.

Agreed 2026-08-07 in a grilling session. Spans three repos: `landry-ui`,
`chatterbook`, `landry.bot/books`. This document is the contract for the
autonomous run; where the work and this document disagree, this document is
wrong and should be corrected in place.

## Why the port comes first

`audiobook/vanilla/player.js` is a blob by measurement, not by opinion: 1,624
lines, one IIFE, **68 functions over 54 module-level mutable `var`s**. The
friction that motivated this is countable too — **17 host-facing knobs**
(`config.audioBaseUrl, autoOpenLast, books, container, embedded, onAuthRefresh,
scenePauseMs, title, transcriptUrl, tree` + `opts.chrome, container, embedded,
feedbackUrl, force, transcriptUrl, updateUrl`), one per downstream
customization, climbing.

Every one of those 17 is "hide this" or "point at that". **None** customizes the
time model, transcript sync, or the service worker. So the friction is entirely
at the chrome seam — which is why the split that matters is **player vs chrome**,
not React vs vanilla.

A framework does not fix the blob; it forces the fix. Porting the 54-var closure
unchanged yields a 54-field reducer with JSX on top. The decomposition is the
work.

What makes this survivable: `test/` is 9 Playwright suites (152 assertions)
driven through the DOM with written contracts. They are framework-agnostic and
must pass **unchanged**.

## Foundation — landry-ui decompose + Preact port

Deployed **alone**, before any todo work touches the player.

- **Layout.** `audiobook/vanilla/` frozen exactly as-is — save `sw.js`, which is
  framework-agnostic and ships byte-identical to both players, so a worker change
  is made there and copied by the build (`test/vanilla-retirement.test.mjs`
  fails if they diverge). See CLAUDE.md. Source and toolchain in
  `audiobook/player-src/` (`package.json`, `tsconfig.json`, `src/`,
  gitignored `node_modules/`); built classic-script artifacts committed to
  `audiobook/player/` (`player.js`, `player.css`, `sw.js`, `icons/`,
  `manifest.webmanifest`). Consumers switch with a one-line path change —
  books' `PLAYER=` in `scripts/build-shell.sh`, chatterbook's
  `./luinst audiobook/player`. That one line is also the rollback.

  Source is deliberately **not** under `audiobook/player/`: `luinst` does
  `cp -r <component>/* <dest>/`, so a combined directory would ship `src/`,
  `package.json` and `node_modules/` to every consumer.

- **Core tests need no build.** Node 24 strips TypeScript types natively, so
  `test/core-*.test.mjs` import `../audiobook/player-src/src/core/*.ts`
  directly. The framework-free core is therefore testable without esbuild,
  without a browser, and without the artifacts being built at all.
- **Decomposition.** Seven modules: time model (book clock, chapter starts,
  summary clock), routing, progress/persistence, transcript+follow, offline/SW
  client, library+tree render, chapters+scrubber+touch.
- **Framework-free core.** The clock, routing, progress and transcript math have
  no DOM in them. They stay plain TS modules, unit-testable in node without a
  browser, importable by any future view layer. Preact owns rendering and wiring
  only.
- **Preact + `preact/compat`**, not React. Measured: `player.js` is **17.8 KB
  gzip** today (css 5.5, sw 4.7). React + ReactDOM is ~45 KB gzip — the runtime
  alone would be 2.5× the entire current player on a site tuned for mobile
  bandwidth. Preact is ~4–5 KB and takes idiomatic React source unmodified, so
  moving to React proper later is a build-config change, not a rewrite.
- **TypeScript with a `tsc --noEmit` gate.** Unchecked types read as guarantees
  nothing enforces; esbuild strips types without checking them.
- **Toolchain.** esbuild → single classic-script IIFE. Classic script, not ESM:
  `build_book.sh --mode standalone` emits a `file://` bundle and Chrome blocks
  ES-module fetches over `file://`. Artifacts are **committed**, so a deploy
  from a machine without node still works — the deploy path is node-free today
  and stays that way. No consumer grows a `node_modules`.

### Parity bar

- All 9 browser suites pass **unchanged**, via `scripts/parity.sh`. (The figure
  quoted in this document and in the 2026-08-07 recap was later found to be
  inflated: feature suites were being swept into the parity run. The parity
  count is **158**.) No edits to test files. A rewrite
  that gets to edit its own tests is not a parity check. Where a test genuinely
  encodes a vanilla implementation detail rather than behaviour, raise it rather
  than quietly relaxing it.
- `tsc --noEmit` clean.
- books' `scripts/test.sh` green.
- Bundle ≤ ~25 KB gzip.
- **New lifecycle suite**: `visibilitychange` hidden→visible plus CDP
  `Page.setWebLifecycleState('frozen'→'active')`, asserting the clock recovers
  across the gap, the rAF loop restarts, and progress survives. This is the one
  failure class where the port is genuinely riskier than the original, and it is
  exactly what a decomposition breaks silently.
- **`sw.js` ships byte-identical**, pinned by a checksum assertion. The service
  worker is framework-agnostic, so the iOS Safari streamed-206 path cannot
  regress by construction.
- Deployed to books.landry.bot, **Lambda before shell**, then
  `tests/live_check.mjs` green against production.

### Retirement flag

`audiobook/vanilla/RETIREMENT.md` holds the remaining-consumer checklist
(karagame, chatterbook standalone). `test/vanilla-retirement.test.mjs` greps
consumers for `audiobook/vanilla` and **fails once none remain**, with the
failure message "no consumers left — delete audiobook/vanilla/". The flag is a
red test in the gate you already run, not a note someone must remember to
re-read.

karalandry.com is being phased out; that is what the sharing work is for. Keep
vanilla until karagame is actually gone, so the phase-out and the rewrite cannot
fail at the same time with no way to tell which broke it.

## Device verification

No headless test reaches real screen-off. The existing suites already cover the
*mechanisms* of all three known deaths — 403→`onAuthRefresh`→retry and the retry
cap (`resilience` A,B), MediaSession handlers installed (E), next-chapter
prefetch (F), SW streaming/capping/not-poisoning (`sw-cache` A–E). What remains
device-only: real backgrounded lifecycle, iOS acceptance of the streamed 206,
lock-screen controls, cellular transitions.

Work continues while the device test is pending — the vanilla player is the
fallback and the revert is one line. Consequence accepted: search and the
triple-dot menu are written against the ported player, so a revert takes their
view layer. The framework-free core limits the loss to wiring.

**Checklist (~5 min):** play a chapter, lock the phone, confirm audio continues
past a chapter boundary; use lock-screen next/pause; leave screen-off ~10 min and
confirm no stall; reopen and confirm position is right; toggle wifi→cellular
mid-chapter; enter reading mode and confirm transcript follow tracks.

## The seven

| # | What | Repo |
|---|---|---|
| 2 | Reading-mode chapter progress line — 1–2px, pinned top, fills L→R with position in chapter | landry-ui |
| 3 | `luinst` local source | chatterbook |
| 4 | README §install rewrite | chatterbook |
| 5 | Per-chapter date-added | chatterbook → books |
| 6 | Full/Summary passthrough | chatterbook |
| 7 | Search | landry-ui |
| 8 | Per-book sharing | books + landry-ui |

### 3 — `luinst` local source

`LANDRY_UI` naming, matching books' `scripts/build-shell.sh` rather than minting
a third convention. A local checkout is **cloned**, not copied, so only
committed work is ever valid — UI work must be committed in landry-ui to count.
Warn loudly when the local checkout is dirty, and print which source won, so a
deploy never silently ships uncommitted UI. GitHub remote + yubikey stays the
default.

### 4 — README §install

Stale, and only the docs are: `~/.local/lib/python3.14/site-packages/chatterbook.pth`
points at the repo root and the chatterbox pyenv (3.10.20) carries a real
editable install. Both `python3` and `~/.pyenv/versions/chatterbox/bin/python`
import chatterbook today. The README describes a dead 3.10 `.pth`.

### 5 — Per-chapter date-added

`write_chapters_manifest` rebuilds from disk every run and carries forward only
durations. Add first-seen, **written at encode time** and carried forward the
same way. Not mtime — it dies on re-encode, and conduct forbids keying on it.
Seed existing chapters once from S3 `LastModified`, then never consult S3 again.
Undated chapters render without a badge rather than as "new".

### 6 — Full/Summary passthrough

The player already implements the toggle in full (`summaryMode`,
`summary_chunks`, summary clock, `#mode-summary`). The entire gap is
builder-side: manifest carries an optional `summary` per chapter,
`build_site.py` passes it through, `build_transcripts.py` emits
`summary_chunks`. Summary **text and wavs stay downstream** — next-chapter globs
`summary-NN-*.wav` from an upstream step and chatterbook's "no pip
dependencies" boundary is worth keeping.

### 7 — Search

> **SUPERSEDED 2026-08-08.** What is described here was built and shipped, then
> the whole search surface was redesigned and tabled before any of the new
> design was written — a magnifier that expands, a paged results page with
> per-book chips, AND-only clauses, and a separate in-book find. The in-player
> box below is expected to be replaced by it. The measurements here still hold
> and are the reason book-level search stays client-side; what changed is the
> shape, not the arithmetic. See `books/docs/search-discussion.md` for what is
> settled, what is still open, and the index question that blocks it.

Client-side. Measured, against the 17.8 MB karagame `transcripts.json`
(4 books, 62,033 chunks, 8.4 MB of actual text): **4.3 MB gzip over the wire,
42 ms to parse, 10 ms for a full linear scan**. There is no performance problem
— the earlier concern was extrapolated from raw byte count instead of measured.
The real issue is only that other books' transcripts are not on the client yet.

- Take the search term immediately; search transcripts as they become available.
- **Never** preload audio. Audio loads only once a result is selected and
  navigated to.
- Minimal spinner in the top row; hover/tap reveals what is loading.
- Results grouped by book with counts — a flat list is 47k rows for a common
  word. Click seeks to the chunk's timestamp.
- Client-side also means karagame and brandonlandry.com get search; a Lambda
  would have left those static sites with none.

### 8 — Per-book sharing

**Already built server-side**: `patch_book` handles `visibility: public|private`,
moves the S3 bytes (`move_prefix`), and adds/removes the sparse GSI. No frontend
calls it — `site/app.js` has zero visibility UI. Public/private is therefore
pure UI work.

- **Menu**: rendered by landry-ui (`renderLibrary`/`renderTreeNode` live there),
  driven by a host-supplied **actions hook** — an array of
  `{id, label, onSelect}`. Values and callbacks cross the boundary, never JSX,
  so **books stays vanilla and needs no toolchain**. Precedent: `config.onAuthRefresh`
  is already a host-supplied function. Escape hatch if a host ever needs rich
  UI inside the menu: let an item hand back a DOM node the player appends.
  Absent unless the host passes the option, so static consumers cannot render a
  menu whose every action would 404.
- **Grants**: **superseded 2026-08-08 — see "Rejected: signed URLs" below**,
  which is where the mechanism actually landed; the cookie design here is kept
  for its reasoning, and the grant cap below is the cookie-era number, not an
  enforced one. DynamoDB rows record the grant and drive the listing, but that is
  not sufficient — see below. Entitlement cookies move from `Path=/` to
  `Path=/priv/<space_id>/`, one triple per grant, so the browser sends exactly
  the right one per request. Browsers allow ~180 cookies/domain, so the real cap
  is ~50 grants. Enforce it server-side with a clear error rather than letting it
  fail in the browser.
- **Recipient discovery**: search only, over users who have opted into the
  directory by claiming a public handle. Never enumerable — no listing endpoint,
  prefix match with a minimum query length, capped results, rate limited.
- **Library assembly**: `get_library` currently unions public books with the
  caller's own space. It must also include books granted to the caller.

#### Why DynamoDB alone cannot do this

The Lambda is never in the path of an audio or transcript fetch. CloudFront
behaviors are pinned straight at S3 prefixes, and the only gate is a signed
cookie whose policy is literally `https://<domain>/priv/<space_id>/*`
(`signing.py:82`). A CloudFront custom policy holds **exactly one statement**. So
a grant row alone would list a shared book in the grantee's library and then
403 every chapter. Something must also unlock the bytes.

#### Rejected: signed URLs — **OVERTURNED 2026-08-08**

> This rejection was wrong, and wrong on its own terms rather than because
> circumstances changed. CloudFront excludes the signature parameters from the
> cache key even under `query_string_behavior=all()` — verified 5/5 against
> production the next day, `books/docs/signed-url-verification.md`. Signed URLs
> became the mechanism for public books, private books and visibility itself;
> the path-scoped grant cookies described above are now the odd one out and are
> logged for replacement. The reasoning below is left standing because it was
> persuasive and wrong, which is the useful part.

Both media cache policies use `query_string_behavior=all()`
(`stack.py:230,253`), so every user's signed URL is a **distinct CloudFront
cache object** — a shared or public book loses edge caching entirely, per
reader. The service worker caches by URL too, so offline downloads churn and
expire. `transcripts.json` would need its own mint as well.

#### Deferred, recorded: the S3 "symlink"

S3 has no symlinks. `x-amz-website-redirect-location` only works on the S3
website endpoint, which needs a public bucket and forfeits OAC.

The idea survives as an **edge rewrite**. A CloudFront Function already strips
`/pub`/`/priv` (`stack.py:43`), and — provable from the fact that production
works — the signature is validated against the **viewer-facing URL**, not the
rewritten one (the policy says `/priv/<space>/*` while the function strips
`/priv` before the origin sees it). So:

> grantee fetches `/priv/<their-own-sid>/shared/<owner-sid>/<book>/chapter_0007.m4a`
> → already covered by their existing cookie, **no cookie changes at all**
> → CF Function rewrites to the owner's real key.

The rewrite is easy; **authorizing** it is not. CloudFront Functions cannot read
DynamoDB, so the grant must prove itself at the edge — an HMAC'd grant cookie the
function verifies. CloudFront Functions runtime 2.0 reportedly ships a `crypto`
module with HMAC; **this is unverified and must be confirmed against live AWS
before anyone bets on it.**

Not chosen now because it buys nothing path-scoped cookies do not already have,
and pays for it with bespoke crypto in the path of every Range request. Revisit
if grants ever exceed ~50.

## Fixed conditions

- Deploy **books.landry.bot only**. Lambda before shell. `--profile landry`,
  verified with `aws sts get-caller-identity` first; bail if the SSO window has
  lapsed.
- karagame picks up player changes whenever its `deploy.sh` next runs — do not
  let that be a surprise.
- Branch per deliverable.
- Tests before code. Red per assertion, not per file. Revert-and-watch after
  green. Real-browser check on anything with pixels.
- **Never `git push`** — the agent, that is. Pushing is the owner's, so they can
  watch it; the agent prepares the branch and hands over the exact commands. The
  push itself is not optional: consumers fetch this player at deploy time, so an
  unpushed change is one karagame's next `deploy.sh` silently overwrites.
