# landry-ui

Reusable UI components for brandonlandry.com projects.

## Using in your project

### 1. Copy the fetch script

```bash
curl -o luinst https://raw.githubusercontent.com/hotpocket/landry-ui/main/scripts/luinst
chmod +x luinst
```

### 2. Fetch the component you need

```bash
# Static site — vanilla JS
./luinst audiobook/vanilla player/

# Next.js / React
./luinst audiobook/react src/components/audiobook/

# Dev server
./luinst serve tools/
```

### 3. Add fetched directories to .gitignore

```gitignore
# Fetched from landry-ui
player/
src/components/audiobook/
```

Fetched files are dependencies, not source. Re-run `luinst` to get the latest version.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `LANDRY_UI_REPO` | `https://github.com/hotpocket/landry-ui.git` | Override repo URL (`git@github.com:hotpocket/landry-ui.git` for SSH) |
| `LANDRY_UI_BRANCH` | `main` | Fetch from a different branch or tag |

---

## Components

### audiobook/

Audiobook player with chapter navigation, transcript sync, draggable split-pane layout, per-chapter progress, localStorage resume, and transcription error flagging.

**Platforms:**

| Path | Runtime | Styling |
|---|---|---|
| `audiobook/vanilla/` | Vanilla JS (IIFE) | CSS |
| `audiobook/react/` | React + TypeScript | Tailwind |

Both variants consume the same data formats:
- **manifest.json** — book metadata, chapter list with start times
- **transcripts.json** — per-chapter chunk text with start/end times
- **Feedback API** — `POST` to `https://bl.landry.bot/events`

#### Vanilla

```html
<link rel="stylesheet" href="player.css">
<script src="feedback.js"></script>
<script src="player.js"></script>
<script>
RepoStoryPlayer.init({
    container: document.getElementById('app'),
    books: [...],
    audioBaseUrl: 'audio/',
    transcriptUrl: 'transcripts.json',
    feedbackUrl: 'https://bl.landry.bot/events'
});
</script>
```

##### Stamp the shell version when you publish

`sw.js` ships with `SHELL_VERSION = 'dev'`, which is right for serving the
component locally but wrong for a published site. The browser only reinstalls a
service worker whose bytes changed, so with a constant version a rebuilt site
keeps serving the previous build's cached `index.html` whenever the network is
unreachable. Since the chapter list is inlined into `index.html`, that surfaces
as an old chapter list against current audio.

Stamp it with a content hash of the shell you just built, as the last step of
your build:

```bash
STAMP=$(cat site/index.html site/transcripts.json | md5sum | cut -c1-8)
sed -i "s/var SHELL_VERSION = 'dev'/var SHELL_VERSION = '$STAMP'/" site/sw.js
sed -i "s|transcriptUrl: 'transcripts.json'|transcriptUrl: 'transcripts.json?v=$STAMP'|" site/index.html
```

`sw.js` derives both its cache name and its cached transcript URL from
`SHELL_VERSION`, so stamping that one line is enough: the worker reinstalls, and
`activate()` evicts the previous build's cache. The second `sed` keeps the URL
the page requests aligned with the one the worker cached — mismatch them and
offline transcripts break while everything else appears fine.

#### React

```tsx
import AudiobookPlayer from './AudiobookPlayer';

<AudiobookPlayer
  book={manifest.books[0]}
  audioSrc="/audio/book.m4b"
  transcriptUrl="/transcripts.json"
  feedbackUrl="https://bl.landry.bot/events"
/>
```

### serve/

Threaded dev server with HTTP Range request support. Required for seeking in large audio files — Python's built-in `http.server` doesn't handle Range headers.

```bash
python3 serve.py -d output/site -p 8000
```

---

## Adding a new component

1. Create a feature directory (e.g. `timeline/`)
2. Add platform subdirectories (`vanilla/`, `react/`, `flutter/`)
3. All variants should consume the same data formats
4. Update this README
