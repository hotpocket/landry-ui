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

## Consumers

Projects pull components via `luinst` (git archive fetch). Fetched directories are gitignored in consumer repos.
