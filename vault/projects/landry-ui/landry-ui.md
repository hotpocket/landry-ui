---
tags: [project, landry-ui, audiobook, player]
concerns: [ux, ops]
type: project
audience: [dev, claude-code]
summary: "Reusable UI components for brandonlandry.com projects. The audiobook player (audiobook/vanilla + react) is the main consumer surface, fetched via luinst into chatterbook/lui-deps and shipped by the karagame deploy. Same features across platform variants against shared data formats (manifest.json, transcripts.json)."
repo: git@github.com:hotpocket/landry-ui.git
path: /home/brandon/git/landry-ui
language: [javascript, typescript]
created: 2026-07-06
status: active
---
# landry-ui — Reusable UI Components

Feature dirs with platform subdirs (`vanilla/`, `react/`, `flutter/`). Vanilla JS = IIFEs, no build step, served as-is.

- `audiobook/vanilla/player.js` — the shipped audiobook player (transcript panel, scene-break holds, SW audio cache).
- `serve/` — dev server with HTTP Range support for large audio.

**Consumer coupling**: [[karagame]]'s `deploy.sh` fetches the player via `luinst` into `chatterbook/lui-deps/` at deploy time — so **commit + push here before deploying**, and note a same-length edit (constant tweak) is invisible to size-based change detection (fixed deploy-side 2026-07-06 by content-hashing the player).

## Sessions
See [[Session Log]].
