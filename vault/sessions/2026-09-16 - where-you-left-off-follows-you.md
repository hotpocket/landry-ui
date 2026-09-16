---
tags: [session, landry-ui, progress, resume, storage]
type: session
date: 2026-09-16
projects: [landry-ui, books]
concern: audiobooks
summary: "Listening progress was keyed by library index, so any book added or reordered moved every saved position onto the wrong book. 6cbc897 keys it by book id (rs-progress-<bookId>, rs-last-book-id — a new key, because a legacy index and an id can both be decimal strings and the value alone cannot say which era it is from) with a one-time, idempotent, storage-safe migration. 470b79a adds an injected remoteProgress backend: the host supplies list()/put(), the engine renders local first, then offers Continue from Ch N · mm:ss on device only when the remote record is newer and different; Continue seeks, Dismiss remembers that updatedAt; puts on pause, chapter change and page hide, coalesced, never per tick. Three decisions moved into core/remote-progress.ts so they are testable without a browser. Tests ran under Deno on a box with no node — calibrated by a rebuild reproducing the committed player.js byte for byte. The browser parity suites did not run."
status: complete
---

# Where you left off follows you

## The key that moved (6cbc897)

`rs-progress-<idx>` was keyed by the book's position in the library. Reorder the library, or publish a book, and every saved position pointed at a different book; the reader saw chapter one, or a stranger's offset. Now `rs-progress-<bookId>` (the host's immutable `book_id`, falling back to the URL slug for hosts without one) and `rs-last-book-id`. A new key rather than `rs-last-book` reused: the legacy value is a decimal index string and a book id can be a decimal string too, so "already migrated" is a fact about which key exists, not a guess about a value's shape. The migration runs once on engine start when the library is known, copies each legacy record to the id key if none exists, deletes the legacy keys, drops an index the library no longer has, and never throws — `safeStore(() => localStorage)` is a thunk because on iOS "Block All Cookies" the throw is naming the identifier. The reorder test was red against the old code; seven mutants each caught; one test that stayed green under every mutant was rewritten until it could fail.

## The position that leaves the browser (470b79a)

- `remoteProgress?: { list(), put(bookId, rec) }` at init. The engine never imports fetch; books' shell supplies the backend only when signed in (its recap has the API). Absent option: today's behaviour exactly.
- Render from local first; `list()` in the background, rejections swallowed into `rs-diag`. Local records gain `savedAt`.
- On book open, an offer row — "Continue from Ch N · mm:ss on device?" — only when the remote record is newer than local and different (other chapter, or more than 30 s apart). Continue seeks and saves; Dismiss remembers that `updatedAt` and a later remote update prompts again. Never an automatic seek; the row survives reading mode on purpose (an unanswered question is not chrome).
- `put()` on pause, chapter change (the position at the moment of leaving), pagehide and hidden. Not on timeupdate, not on a timer: a PUT on a public book costs the API a GSI query. One in flight per book; later puts coalesce, latest wins.
- `leavesAChapter`, `chapterIdxForN`, `landingSeconds` extracted to `core/remote-progress.ts` ("the decisions live in core/, tested without a browser"): a reload in place is not a move and costs no request; the chapter's own number, not `n - 1`; a landing past the end of a republished-shorter chapter clamps to the audio, not the text. 138 core tests, 13 mutants each caught.

## The instrument

No `node` on ai-3090. Deno 2.9 drove the same `node:test` files unchanged, typechecked, and built — and a rebuild before any edit reproduced the committed `player.js` byte for byte, which is what made the toolchain trustworthy. `deno run` swallows a failing assertion; `deno test` reports it.

**Not run:** every browser suite (`parity.sh`, `lifecycle`, `embed`, `reading-progress`, `re-init`). The `pause()` call site, the accept-and-seek path and the offer row's rendering are exercised by nothing but the decisions behind them. Run `scripts/parity.sh` on the workstation before deploying. Deploy from books: `scripts/build-shell.sh && scripts/deploy-content.sh --shell-only`.

## Left open

An offer row already on screen is not withdrawn after the reader listens on, so a late tap on Continue moves them back to the older position; a fourth gate is a design decision. `contentVersion` is wired end to end but `/api/library` does not emit it.
