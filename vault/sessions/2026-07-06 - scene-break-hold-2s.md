---
tags: [session, landry-ui, player]
type: session
concerns: [ux, ops]
audience: []
summary: "Shortened the audiobook player's scene-break hold from 3s to 2s (SCENE_PAUSE_MS in audiobook/vanilla/player.js, commit 33344e9). Surfaced a deploy-durability gap: a same-length constant edit doesn't move file size, so the karagame deploy's path+size change detector missed it (fixed deploy-side by content-hashing player/serve components). Committed, unpushed."
created: 2026-07-06
status: completed
projects: [landry-ui]
branch: main
---
# 2026-07-06 Scene-Break Hold 3s -> 2s

Small player tweak during the karalandry audiobook deploy repair (hub recap: [[karagame]]).

## Work
- `audiobook/vanilla/player.js` — `SCENE_PAUSE_MS` 3000 -> 2000. Player-side hold when playback crosses a `* * *` scene-break marker (not baked into audio/transcripts, so it applies everywhere at once). (`33344e9`)

## Discovery
- A **same-length constant edit** is invisible to size-based change detection. The karagame deploy hashed inputs by path+size, so this edit wouldn't have triggered a deploy. Fixed on the deploy side by content-hashing the player/serve components (karagame `797fe25`). Reinforces durable-over-accurate: change detection must key on content, not incidental size.
- The player is a fetched dependency in consumers — **commit + push before deploy** or the fetch overwrites local edits.

## Next Steps
None landry-ui-specific.
