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


## From 2026-08-08 (cold-agent trial findings)

- [ ] **Shell-file failures are hidden.** `downloadForOffline` demotes a failed
      transcript/shell fetch to `console.warn` and still shows "Downloaded ✓".
      The vanilla player it replaced showed "Downloaded ⚠" with the failing
      files listed — its own comment says such a book "looks, offline, exactly
      like a broken app". Lost in the port. ~1h.

- [ ] **The offline badge can mask a failed download.** `checkOfflineStatus`
      probes only the first and last FULL chapters, so a download that failed on
      a summary track has both probes cached and `refreshOfflineBadges` flips
      the book from error back to downloaded. Narrow, pre-existing. ~1h.

- [ ] **The browser suites' static server is copy-pasted ~9 times** and has
      already diverged — some copies support Range requests, some do not. A
      shared `test/serve.mjs` would stop the drift. ~1h.
      **Got worse 2026-08-12**, honestly: answering the CodeRabbit review added
      three more suites (`re-init`, `manifest-warnings`, `embed-isolation`) and
      each carries its own copy. Every one was pasted knowing this todo existed,
      which is the argument for doing it before the next suite rather than the
      estimate.

## From 2026-08-12 (the CodeRabbit review)

- [ ] **Device-test the stall-budget change.** `9334a8a` makes returning to
      visibility re-arm the stall watchdog, because `stallRecoveries` was
      otherwise cleared only by a `playing` event and a hung request produces
      none. That is the screen-off path, which no headless test reaches — the
      new `playback-recovery` case H simulates the hang and the visibility
      return, but not a real phone with a real radio.

- [ ] **Watch books.landry.bot for the embedded CSS change.** `ed8541a` stops
      `player.css` styling the host page. books embeds, so it is the one
      consumer whose appearance can move; standalone was verified byte-identical
      by screenshot but embedded was only verified by assertion.

- [ ] **Vanilla has the same silent-revert download bug** the Preact player just
      had, and its only feedback is a `title` attribute, invisible on touch.
      Deliberately NOT fixed: vanilla is frozen (see RETIREMENT.md). Listed so
      nobody rediscovers it and thinks it was missed.
