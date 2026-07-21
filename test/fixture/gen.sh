#!/usr/bin/env bash
# gen.sh — generate the browser-test fixture into test/fixture/out/ (gitignored).
# Two chapters of silent audio + a synthetic transcript long enough to overflow
# the transcript pane, wired up exactly like a build_site.py standalone page
# (inline books JSON, transcripts as a data: URI, file://-compatible).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"
mkdir -p "$OUT/audio"

for n in 1 2; do
  m4a="$OUT/audio/chapter_000${n}.m4a"
  if [[ ! -f $m4a ]]; then
    ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t 30 -c:a aac -b:a 32k \
      -movflags +faststart "$m4a" -loglevel error
  fi
  summ="$OUT/audio/chapter_000${n}.summary.m4a"
  if [[ ! -f $summ ]]; then
    ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t 6 -c:a aac -b:a 32k \
      -movflags +faststart "$summ" -loglevel error
  fi
done

python3 - "$OUT" <<'EOF'
import base64, json, sys
from pathlib import Path

out = Path(sys.argv[1])

def chunks(count, dur):
    return [{"index": i, "text": f"Chunk {i} text, spoken words for testing scroll behaviour.",
             "start": round(i * dur, 3), "end": round((i + 1) * dur, 3)}
            for i in range(count)]

def sum_chunks(count, dur, tag):
    return [{"index": i, "text": f"Summary {tag} chunk {i} condensed for testing.",
             "start": round(i * dur, 3), "end": round((i + 1) * dur, 3)}
            for i in range(count)]

transcripts = {"books": [
    {"slug": "test-book", "chapters": [
        {"index": 1, "title": "One", "chunks": chunks(40, 0.7),
         "summary_chunks": sum_chunks(4, 1.5, "one")},
        {"index": 2, "title": "Two", "chunks": chunks(10, 0.7),
         "summary_chunks": sum_chunks(4, 1.5, "two")},
    ]},
    {"slug": "plain-book", "chapters": [
        {"index": 1, "title": "Only", "chunks": chunks(10, 0.7)},
    ]},
]}

books = [
    {"slug": "test-book", "title": "Test Book", "artist": "Fixture", "duration": 60.0,
     "chapters": [
        {"id": 0, "n": 1, "title": "Chapter 1: One", "filename": "chapter_0001.m4a",
         "start": 0.0, "end": 30.0, "duration": 30.0, "size": 1,
         "summary": {"filename": "chapter_0001.summary.m4a", "duration": 6.0, "size": 1}},
        {"id": 1, "n": 2, "title": "Chapter 2: Two", "filename": "chapter_0002.m4a",
         "start": 30.0, "end": 60.0, "duration": 30.0, "size": 1,
         "summary": {"filename": "chapter_0002.summary.m4a", "duration": 6.0, "size": 1}},
    ]},
    {"slug": "plain-book", "title": "Plain Book", "artist": "Fixture", "duration": 30.0,
     "chapters": [
        {"id": 0, "n": 1, "title": "Chapter 1: Only", "filename": "chapter_0001.m4a",
         "start": 0.0, "end": 30.0, "duration": 30.0, "size": 1},
    ]},
]

tr_uri = "data:application/json;base64," + base64.b64encode(
    json.dumps(transcripts).encode()).decode()

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fixture</title>
<link rel="stylesheet" href="../../../audiobook/vanilla/player.css">
</head>
<body>
<div id="app"></div>
<script>var RepoStoryFeedback = {{ init: function () {{}}, send: function () {{}} }};</script>
<script src="../../../audiobook/vanilla/player.js"></script>
<script>
RepoStoryPlayer.init({{
    container: document.getElementById('app'),
    books: {json.dumps(books)},
    audioBaseUrl: 'audio/',
    transcriptUrl: {json.dumps(tr_uri)}
}});
</script>
</body>
</html>"""
(out / "index.html").write_text(html)
print(f"fixture ready: {out}/index.html")
EOF
