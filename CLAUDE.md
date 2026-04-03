# landry-ui

Reusable UI components for brandonlandry.com projects.

## Conventions

- Components live under a feature directory (e.g. `audiobook/`) with platform subdirectories (`vanilla/`, `react/`, `flutter/`).
- Vanilla JS uses IIFEs, no build step, served as-is.
- React components are TypeScript, use Tailwind for styling.
- All platform variants implement the same features against the same data formats (manifest.json, transcripts.json, feedback API).
- Do not include AI attribution in commit messages or source files.

## Components

- `audiobook/vanilla/` — Vanilla JS audiobook player
- `audiobook/react/` — React/TypeScript audiobook player
- `serve/` — Dev server with HTTP Range support for large audio files

## Performance lessons

**Service worker Range requests on large files**: Never use `cached.arrayBuffer()` to serve Range requests — it reads the entire file (700MB+) into memory on every seek. Use `cached.blob()` then `Blob.slice(start, end)` which returns a lightweight reference with no memory copy. This is the difference between 20s seeks and instant seeks.

**M4B moov atom**: Always encode with `-movflags +faststart` so the moov atom is at the front of the file. Without it, the browser must read to the end of the file before it can seek.

## Consumers

Projects pull components via `luinst` (shallow clone fetch). Fetched directories are gitignored in consumer repos.
