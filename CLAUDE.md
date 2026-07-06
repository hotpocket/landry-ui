# landry-ui

Reusable UI components for brandonlandry.com projects.

## Conventions

- Components live under a feature directory (e.g. `audiobook/`) with platform subdirectories (`vanilla/`, `react/`, `flutter/`).
- Vanilla JS uses IIFEs, no build step, served as-is.
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
