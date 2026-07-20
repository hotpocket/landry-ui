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
