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
