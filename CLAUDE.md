# landry-ui

Reusable UI components for brandonlandry.com projects.

Consumed by books.landry.bot and karagame. If you are changing the player for
the books site, read `change_request.md` in the `books` repo first — it carries
the build pipeline (`player-src` → `build.mjs` → committed artifacts) and how
the shell picks the player up.

## Conventions

- Components live under a feature directory (e.g. `audiobook/`) with platform subdirectories (`vanilla/`, `react/`, `flutter/`).
- `audiobook/vanilla/` is IIFE JavaScript with no build step, served as-is. It
  is FROZEN — the parity reference and a fallback for consumers that have not
  switched (`audiobook/vanilla/RETIREMENT.md`). Do not fix features there.
  **One exception, and it is not a loophole:** `sw.js` is framework-agnostic and
  ships byte-identical to both players — `build.mjs` copies it, and
  `test/vanilla-retirement.test.mjs` fails if the two ever diverge. A service
  worker change is therefore made in `audiobook/vanilla/sw.js` and rebuilt, and
  the commit says so. Nothing else in the directory moves.
- `audiobook/player/` is the current player: TypeScript + Preact, source in
  `audiobook/player-src/`, built with `node build.mjs`, artifacts committed.
  Editing the source without rebuilding ships the previous player.
- React components are TypeScript, use Tailwind for styling.
- All platform variants implement the same features against the same data formats (manifest.json, transcripts.json, feedback API).
- Do not include AI attribution in commit messages or source files.
- **Durable over accurate — always.** Prefer references that survive commits, pushes, checkouts, and moves over ones merely correct now: relative/runtime-derived paths (never hardcoded absolutes), content hashes over mtimes, one source of truth over copied literals.

## Components

- `audiobook/vanilla/` — Vanilla JS audiobook player
- `audiobook/react/` — React/TypeScript audiobook player
- `serve/` — Dev server with HTTP Range support for large audio files

## Performance lessons

**Service worker Range requests on large files**: Never use `cached.arrayBuffer()` to serve Range requests — it reads the entire file (700MB+) into memory on every seek. Use `cached.blob()` then `Blob.slice(start, end)` which returns a lightweight reference with no memory copy. This is the difference between 20s seeks and instant seeks.

**M4B moov atom**: Always encode with `-movflags +faststart` so the moov atom is at the front of the file. Without it, the browser must read to the end of the file before it can seek.

## Consumers

Projects pull components via `luinst` (shallow clone fetch). Fetched directories are gitignored in consumer repos.

## Session conduct

Session-start orientation is injected by the global `SessionStart` router
(`~/bin/claude-orient`), which runs `scripts/session-start.sh`: latest recap
pointer + open-todo count. **Vault access is file-first** — `scripts/vault-digest
summaries|recap|todos|search <q>` (grep/awk over `vault/` frontmatter, no
Obsidian). Read a full note only after a summary points to it. When you discover
something durable, write it back to `vault/`; at session end, offer `/vault recap`.

Consumers (karagame) fetch this player at deploy time, so **commit + push here
first** — an uncommitted player change is overwritten by the fetch, and a
same-length edit (e.g. a constant) is invisible to size-based change detection.

## Docs layout

- `docs/` — generated working notes, plans, analyses.
- `docs/reports/` — persistent, shareable deliverables.
- `docs/logs/` — transient process output (gitignored).

## Tests

Browser tests for the vanilla player: `node test/follow.test.mjs` (Playwright
from the gstack pin; override with `PLAYWRIGHT_LIB`). Fixture regenerates via
`test/fixture/gen.sh` (needs ffmpeg).

Three entry points, and they cover different things:

- `node --test test/core-*.test.mjs` — the framework-free core. No browser, no
  build: Node strips the TypeScript types and imports `player-src/src/core/*`
  directly. Fast enough to run on every edit.
- `scripts/parity.sh` — every browser suite against the built player. It also
  reports which suites are *parity* suites and which are *feature* suites, and
  the classification is derived from how each one resolves the player on disk.
- individual feature suites (`node test/playback-recovery.test.mjs`,
  `search`, `book-menu`, `offline-download`, `reading-progress`) — behaviour that
  frozen vanilla never had, so they load `audiobook/player/` directly.

Suites worth knowing by name: `scene-pause` (the hold yields to a tap),
`resilience` (403 → onAuthRefresh → retry, capped), `lifecycle` (freeze/thaw,
the closest a headless test gets to the screen going off), `sw-cache` (the
service worker streams, caps and never poisons), `playback-recovery`
(recovery obeys an explicit pause, a hanging request is recovered, failures are
recorded to `rs-diag`), `storage-blocked` (the player mounts when the
`localStorage` GETTER throws — iOS Safari's "Block All Cookies" — which is a
class of defect no desktop browser can exhibit), and `reading-title` (a long
chapter title wraps to two lines and moves no control — it mounts the player the way books.landry.bot
does, a flex item under an `overflow-x: hidden` host, because a standalone page
cannot exhibit the min-content blowout it exists to catch).
