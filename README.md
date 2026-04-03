# landry-ui

Reusable UI components for brandonlandry.com projects.

## Components

### player/

Audiobook player with chapter navigation, transcript display, and transcription error flagging.

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

**Files**: `player.js`, `player.css`, `feedback.js`

### serve/

Dev server with HTTP Range request support (required for audio seeking in large files).

```bash
python3 serve/serve.py -d output/site
```
