# landry-ui

Reusable UI components for brandonlandry.com projects.

## Conventions

- Vanilla JS, no frameworks. Components are IIFEs that expose a global init function.
- No build step. Files are served as-is.
- Do not include AI attribution in commit messages or source files.

## Components

- `player/` — Audiobook player with chapters, transcript sync, and error flagging
- `serve/` — Dev server with HTTP Range support for large audio files

## Consumers

Projects pull components via `update-deps.sh` (git archive fetch). The `player/` directory is gitignored in consumer repos — it's a fetched dependency.
