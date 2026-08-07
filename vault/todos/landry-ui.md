---
tags: [todos, landry-ui]
type: todo
audience: [dev, claude-code]
summary: "Open items for landry-ui."
created: 2026-07-06
status: active
---
# landry-ui TODOs

- [x] Reading-mode chapter progress: 1–2px line pinned to the top of the view,
      filling left→right with position within the current chapter. Done
      2026-08-07 in the Preact build (`audiobook/player-src/src/`), covered by
      `test/reading-progress.test.mjs`.

- [ ] **Retire `audiobook/vanilla/`.** Tracked by
      `audiobook/vanilla/RETIREMENT.md`; `test/vanilla-retirement.test.mjs`
      goes red on its own once the last consumer is ticked off. books switched
      2026-08-07; karagame and chatterbook's standalone `file://` bundle remain.

- [ ] **Decide React vs Preact for real.** The port ships `preact/compat`, so
      the source is idiomatic React and swapping is a build-config change in
      `audiobook/player-src/build.mjs`, not a rewrite. Measured reason to wait:
      Preact + the whole player is 16.3 KB gzip; React + ReactDOM alone is ~45.
