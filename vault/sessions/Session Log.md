---
tags: [session, index]
type: index
audience: []
summary: ""
created: 2026-07-06
---
# Session Log

Latest at the bottom.

| Date | Summary |
| ---- | ------- |
| [[2026-07-06 - scene-break-hold-2s]] | Shortened the player's scene-break hold 3s -> 2s (SCENE_PAUSE_MS). Exposed that a same-length constant edit is invisible to the karagame deploy's size-based change detection (fixed deploy-side same day). |
| [[2026-08-07 - player-port-and-the-seven]] | The 1,624-line vanilla player (68 functions over 54 mutable vars) decomposed into a framework-free TS core plus a Preact view and shipped to books.landry.bot — smaller than what it replaced (16.3 KB gzip vs 17.8), with the browser suites passing UNEDITED via a new scripts/parity.sh. Search, sharing hooks, reading-mode progress line, date-added badge. Two claims in it were later corrected: parity is 158 assertions not 183, and the signed-URL rejection was overturned the next day |
| [[2026-08-08 - visibility-became-a-row-write]] | Recap lives in the books vault; that session was mostly books. landry-ui side: the nav row and back arrow, media signatures appended after the filename with the service worker caching WITHOUT them, and parity.sh corrected — feature suites were padding the parity count. A cold agent given only books/change_request.md fixed a real regression here (a failed offline download silently reverted to the idle button) and found the parity flaw |
| [[2026-08-12 - the-review-that-earned-its-keep]] | 14 CodeRabbit findings triaged on PR #2: 13 applied or answered, 1 declined as the todo list read back as a review. The bot was right about something in 12 but right about the FIX in about half — its ch.id patch would have left clock.ts and the DOM indexing by different schemes. Four owner decisions, all taken: 416 for unsatisfiable ranges, warnings for two invariants nothing enforced, player.css scoped to stop restyling host pages. Screenshots caught a CSS regression no assertion did; the lifecycle flake was a fixed 1.5s sleep asserting a one-second display could change, and a parity suite run directly tests frozen vanilla, so mutation checks on one must go through parity.sh |
