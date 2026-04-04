---
name: 2026-04-02/04 session — audiobook player extraction and deployment
description: Full session log covering player component extraction, landry-ui repo creation, PWA offline support, performance optimization, and multi-repo deployment pipeline
type: project
---

## What was accomplished

### New repos created
- **landry-ui** (`github.com/hotpocket/landry-ui`) — reusable UI component library
  - `audiobook/vanilla/` — vanilla JS player (player.js, player.css, sw.js, manifest.webmanifest, icons/)
  - `audiobook/react/` — React/TypeScript player (AudiobookPlayer.tsx) — feature-complete but not yet optimized like vanilla
  - `serve/` — threaded dev server with HTTP Range support
  - `scripts/luinst` — fetch script for consumers (uses shallow clone over SSH)
  - `scripts/check-m4b` — M4B validation (moov atom, chapters, codec, duration)
- **landry-ui-playground** — demo/testing ground for components
  - `audiobook/` demo with wbt chapters (full 908 range, 907 present — ch 884 missing from source)
  - `run.sh` — one command to fetch deps, rebuild, serve
  - `index.html` — landing page listing all component demos
  - `lui-deps/` — fetched components (gitignored)

### Player features built
- Chapter navigation with per-chapter progress overlay (active chapter only)
- Draggable split pane: chapters (left) + transcript (right) with touch support
- CSS container query: chapters show short labels ("Ch 134") when panel narrowed below 150px
- Transcript sync — paragraphs highlight as audio plays, click to seek
- Download for offline — streams M4B into service worker cache with progress (ReadableStream wrapper)
- PWA — installable to home screen with custom icon ("Audiobooks for Kara"), works fully offline
- Download button caches ALL assets (audio + transcripts + HTML/CSS/JS/icons) in one tap
- Progress persistence — localStorage, auto-resume on reload, beforeunload save
- User scroll override — auto-scroll pauses when user scrolls manually, resumes on chapter change (wheel + touchmove detection)
- Themed scrollbars, hover highlights on controls
- Wake lock during download to prevent screen timeout
- beforeunload guard during download (works on desktop, not mobile Chrome)
- Speed cycling (0.75x to 2x)

### Deployment
- Deployed to `https://karalandry.com/books/` via unified `deploy.sh`
- deploy.sh handles: fetch components → validate M4B → build site → customize for kara → upload to S3 → invalidate CloudFront
- Consumer customization (title, manifest name) done via sed/jq patches after copy, not modifying upstream
- Transcript URL cache-busted with content hash (`transcripts.json?v=a1b2c3d4`)
- `check-m4b` validation runs before every deploy

### Full book: 907 chapters, 115 hours, 4.7GB M4B

## Performance lessons (critical)

### Blob.slice not ArrayBuffer for service worker Range requests
`cached.arrayBuffer()` reads the ENTIRE file (700MB+) into memory on every seek — causes 20s+ delays. `cached.blob()` then `Blob.slice(start, end)` returns a lightweight reference with zero memory copy.

### M4B moov atom must be at front
Always encode with `-movflags +faststart`. Without it, the browser must read to the end of the file before it can seek. Use `check-m4b` script to validate before deploy. Fix existing files with `ffmpeg -i input.m4b -c copy -movflags +faststart output.m4b`.

### DOM optimization in requestAnimationFrame loop
- Cache DOM refs once in `openBook()` — never querySelector per frame
- Store chapter elements in indexed arrays (`chapterLis[i]`, `chapterProgs[i]`)
- Only update the active chapter's progress bar (1 element, not 907)
- Only toggle active class on chapter *change*
- Binary search for chapter/chunk lookup
- Skip DOM writes when value unchanged (formatTime, play state)

### Download: stream directly to cache, no memory accumulation
- `response.clone()` does NOT help — Chrome buffers both streams internally, same OOM
- Accumulating chunks in a JS array OOMs at ~4.6GB on tablets
- Solution: wrap fetch body in a ReadableStream that counts bytes, pass wrapped Response to `cache.put()`. Single stream, progress tracking, zero memory overhead.

### Background Fetch API is unreliable
Tried for Android (survives app switching). Unreliable — partial downloads, no resume, stale state. Removed entirely.

## Service worker architecture

### Two separate caches
- `audiobook-shell` — HTML, CSS, JS, transcripts, icons. Rebuilt on every sw install.
- `audiobook-audio` — M4B audio. Persists across sw updates. Never wiped by code updates.

### Caching strategies
- **Audio**: cache-first with Blob.slice Range support. Falls back to network if not cached.
- **Shell**: network-first. Always fetches latest when online, serves from cache when offline.
- **Download button**: caches EVERYTHING (audio + all shell files) into `audiobook-audio` with absolute URLs as keys.
- **Offline fallback**: checks `audiobook-shell` first, then `audiobook-audio`, then returns 503.

### Cache key lesson
Always use **absolute URLs** as cache keys. The service worker resolves `e.request.url` to absolute, but `cache.put('transcripts.json', response)` stores with a relative key. The sw can't find it offline. Use `new URL(file, window.location.href).href`.

## Viewport units on mobile

- **`vh`** — largest viewport (URL bar hidden). Content taller than visible area when URL bar shows.
- **`dvh`** — dynamic, resizes as browser UI shows/hides. Causes layout shifts.
- **`svh`** — smallest viewport (all browser UI visible). Guarantees content fits. **Use this for fixed layouts.**
- Android's system navigation bar (back/home/recent) is NOT accounted for by `dvh`. Only `svh` handles it.

## Transcript indexing

Transcript `index` must match M4B chapter position sequentially (1, 2, 3... 907), NOT chapter numbers (1, 2... 883, 885... 908). The player maps `ch.id + 1` (0-based M4B position + 1) to transcript index. If a chapter number is missing (884), using chapter numbers as indices causes misalignment from that point onward. Fix: `"index": len(chapters) + 1` not `n - args.start + 1`.

## CloudFront / browser caching

- `max-age=31536000` (1 year) on transcripts means browsers cache aggressively. Even after CloudFront invalidation, the browser serves from its own HTTP cache. "Clear site data" on Android does NOT always clear the HTTP cache.
- Fix: use short TTL (`max-age=300`) for files that change, and cache-bust with content hash in the URL (`transcripts.json?v=hash`). CloudFront ignores query strings (QueryString forwarding = false) but the browser treats each `?v=` as a different resource.

## Outstanding TODOs

### Player improvements
- [ ] Mobile responsiveness — needs more work for phone layouts
- [ ] Virtual scrolling for chapter list when approaching 908+ chapters
- [ ] React version needs same performance optimizations
- [ ] Feedback flagging UI removed — re-add when bl.landry.bot is deployed

### Infrastructure
- [ ] Deploy SAM feedback stack (bl.landry.bot)
- [ ] Set proper M4B metadata (title, album, artist, date) per episode

### Integration
- [ ] Replace RepoStoryPlayer.tsx on brandonlandry.com with landry-ui react version

## Key decisions made
- **Vanilla JS over React** for the canonical player — more portable, no build step
- **Single M4B file** rather than per-chapter files — Blob.slice handles large files fine
- **landry-ui as a component repo** with platform subdirectories (vanilla/react/flutter)
- **luinst** fetches via shallow clone, consumers gitignore fetched dirs
- **No git submodules** — explicit fetch script avoids git entanglement
- **landry.bot** is the API domain, **landry-ui** is the component repo
- **Consumer customization via post-copy patches** (sed for HTML, jq for JSON) — don't modify upstream
- **Separate shell and audio caches** — code updates don't wipe audio
- **svh not dvh** for fixed layouts on mobile
- **Cache-bust with content hash** for files that change but need CDN caching
- **check-m4b validation** before every deploy

## Mistakes to avoid
- Never use `git archive --remote` with GitHub — not supported over SSH. Use shallow clone.
- Never use `ArrayBuffer` for Range requests on large cached files — use `Blob.slice`.
- Never use `response.clone()` to track download progress — Chrome buffers both streams, same OOM.
- Always add `-movflags +faststart` when encoding M4B/M4A.
- Don't copy raw component files over a generated site — always rebuild via build_site.py.
- Python's `http.server` doesn't support Range requests — use threaded serve.py.
- `100vh` and `100dvh` don't account for Android system nav bar — use `100svh`.
- Service workers require HTTPS (except localhost) — PWA features won't work on LAN IP.
- Background Fetch API is unreliable for large files on Android.
- When clearing `rs-last-book` in `showLibrary()`, must also clear `currentBook` or periodic `saveProgress` re-sets it.
- Cache keys must be absolute URLs — service worker resolves requests to absolute but relative cache keys won't match.
- Long cache TTL on transcripts causes stale data even after CDN invalidation — use short TTL + hash-busted URL.
- `beforeunload` confirmation dialog does not work on mobile Chrome — cannot prevent accidental refresh.
- Never run SSH commands (git clone, luinst) from Claude — triggers auth prompts. User runs these manually.
