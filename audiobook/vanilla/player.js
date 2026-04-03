/**
 * player.js — Repo Story audiobook player component.
 *
 * Usage:
 *   RepoStoryPlayer.init({
 *     container: document.getElementById('app'),
 *     books: [...],
 *     audioBaseUrl: 'audio/',
 *     transcriptUrl: 'transcripts.json',
 *     feedbackUrl: 'https://bl.landry.bot/events'
 *   });
 */
var RepoStoryPlayer = (function () {
  var config = {};
  var currentBook = null;
  var currentBookIdx = null;
  var audio = null;
  var speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];
  var speedIdx = 1;
  var transcriptData = null;

  function formatTime(s) {
    if (isNaN(s)) return '0:00';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = Math.floor(s % 60);
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  }

  function getProgress(bookIdx) {
    try {
      var val = localStorage.getItem('rs-progress-' + bookIdx);
      if (!val) return { time: 0, progress: 0 };
      return JSON.parse(val);
    } catch (e) {
      return { time: 0, progress: 0 };
    }
  }

  function saveProgress() {
    if (currentBook === null || currentBookIdx === null) return;
    var p = audio.currentTime / (audio.duration || 1);
    localStorage.setItem('rs-progress-' + currentBookIdx, JSON.stringify({ time: audio.currentTime, progress: p }));
    localStorage.setItem('rs-last-book', String(currentBookIdx));
  }

  function getCurrentChapter() {
    if (!currentBook) return null;
    var t = audio.currentTime;
    return currentBook.chapters.find(function (ch) { return t >= ch.start && t < ch.end; }) || currentBook.chapters[0];
  }

  function getBookTranscript() {
    if (!transcriptData || !currentBook) return null;
    var slug = currentBook.filename.replace(/\.[^.]+$/, '');
    return transcriptData.books.find(function (b) { return b.slug === slug; }) || null;
  }

  function getCurrentChunk() {
    var bt = getBookTranscript();
    if (!bt) return null;
    var ch = getCurrentChapter();
    if (!ch) return null;
    var ct = bt.chapters.find(function (c) { return c.index === ch.id + 1; });
    if (!ct) return null;
    var timeInChapter = audio.currentTime - ch.start;
    for (var i = 0; i < ct.chunks.length; i++) {
      if (timeInChapter >= ct.chunks[i].start && timeInChapter < ct.chunks[i].end) {
        return { chapterIndex: ch.id + 1, chunk: ct.chunks[i] };
      }
    }
    return null;
  }

  // --- Rendering ---

  function checkOfflineStatus(book) {
    if (!('caches' in window)) return Promise.resolve(false);
    var audioUrl = (config.audioBaseUrl || 'audio/') + book.filename;
    // Check both relative and absolute URLs (background fetch caches absolute)
    var absoluteUrl = new URL(audioUrl, window.location.href).href;
    return caches.open('audiobook-v1').then(function (cache) {
      return cache.match(audioUrl).then(function (r) {
        if (r) return true;
        return cache.match(absoluteUrl).then(function (r2) { return !!r2; });
      });
    }).catch(function () { return false; });
  }

  function downloadForOffline(book, btn) {
    var audioUrl = (config.audioBaseUrl || 'audio/') + book.filename;
    btn.classList.add('downloading');
    btn.innerHTML = '0%';
    fetch(audioUrl).then(function (response) {
      var total = parseInt(response.headers.get('Content-Length') || '0', 10);
      var loaded = 0;
      var reader = response.body.getReader();
      var chunks = [];

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;
          chunks.push(result.value);
          loaded += result.value.length;
          if (total > 0) {
            btn.innerHTML = Math.round(loaded / total * 100) + '%';
          }
          return pump();
        });
      }

      return pump().then(function () {
        var blob = new Blob(chunks);
        var cachedResponse = new Response(blob, {
          headers: { 'Content-Type': 'audio/mp4' }
        });
        return caches.open('audiobook-v1').then(function (cache) {
          return cache.put(audioUrl, cachedResponse);
        });
      });
    }).then(function () {
      btn.classList.remove('downloading');
      btn.classList.add('downloaded');
      btn.innerHTML = '&#10003;';
      btn.title = 'Available offline';
    }).catch(function () {
      btn.classList.remove('downloading');
      btn.innerHTML = '&#8615;';
      btn.title = 'Download failed — try again';
    });
  }

  function renderLibrary() {
    var container = config.container;
    var library = container.querySelector('#library');
    var list = library.querySelector('#book-list');
    list.innerHTML = '';
    config.books.forEach(function (book, i) {
      var p = getProgress(i);
      var status = p.progress > 0.98 ? 'complete' : p.progress > 0.01 ? 'in-progress' : '';
      var div = document.createElement('div');
      div.className = 'book-item';

      var info = document.createElement('div');
      info.onclick = function () { openBook(i); };
      info.style.flex = '1';
      info.style.cursor = 'pointer';
      info.innerHTML = '<div class="title">' + book.title + '</div>' +
        '<div class="meta">' + book.chapters.length + ' chapters &middot; ' + formatTime(book.duration) + '</div>';

      var actions = document.createElement('div');
      actions.className = 'book-actions';

      var dlBtn = document.createElement('button');
      dlBtn.className = 'dl-btn';
      dlBtn.innerHTML = '&#8615;';
      dlBtn.title = 'Download for offline';
      dlBtn.onclick = function (e) {
        e.stopPropagation();
        if (dlBtn.classList.contains('downloaded') || dlBtn.classList.contains('downloading')) return;
        downloadForOffline(book, dlBtn);
      };

      // Check if already cached
      checkOfflineStatus(book).then(function (cached) {
        if (cached) {
          dlBtn.classList.add('downloaded');
          dlBtn.innerHTML = '&#10003;';
          dlBtn.title = 'Available offline';
        }
      });

      var dot = document.createElement('div');
      dot.className = 'progress-dot ' + status;

      actions.appendChild(dlBtn);
      actions.appendChild(dot);
      div.appendChild(info);
      div.appendChild(actions);
      list.appendChild(div);
    });
  }

  // --- Chapter scrubber state ---
  var scrubbing = null;
  var didDrag = false;

  function renderChapters() {
    var container = config.container;
    var list = container.querySelector('#chapter-list');
    var trackBar = container.querySelector('#track-bar');
    list.innerHTML = '';
    trackBar.querySelectorAll('.chapter-mark').forEach(function (el) { el.remove(); });

    currentBook.chapters.forEach(function (ch, i) {
      var li = document.createElement('li');
      li.id = 'ch-' + i;
      var dur = ch.end - ch.start;

      var progressEl = document.createElement('div');
      progressEl.className = 'ch-progress';

      var scrubberEl = document.createElement('div');
      scrubberEl.className = 'ch-scrubber';

      li.appendChild(progressEl);
      li.appendChild(scrubberEl);

      var titleSpan = document.createElement('span');
      titleSpan.className = 'ch-title';
      titleSpan.textContent = ch.title;
      li.appendChild(titleSpan);

      var durSpan = document.createElement('span');
      durSpan.className = 'ch-duration';
      durSpan.textContent = formatTime(dur);
      li.appendChild(durSpan);

      // Mousedown on the scrubber handle = start dragging
      scrubberEl.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        didDrag = false;
        li.classList.add('scrubbing');
        scrubbing = { li: li, ch: ch, dur: dur };
      });

      // Mousedown on the li = start potential click (not drag)
      li.addEventListener('mousedown', function (e) {
        if (e.target === scrubberEl) return;
        didDrag = false;
      });

      // Click on li = navigate to chapter (only if we didn't drag)
      li.addEventListener('click', function (e) {
        if (didDrag) return;
        if (e.target === scrubberEl) return;
        audio.currentTime = ch.start;
        audio.play();
      });

      list.appendChild(li);

      if (i > 0 && currentBook.duration > 0) {
        var mark = document.createElement('div');
        mark.className = 'chapter-mark';
        mark.style.left = (ch.start / currentBook.duration * 100) + '%';
        trackBar.appendChild(mark);
      }
    });
  }

  function handleScrubMove(e) {
    if (!scrubbing) return;
    didDrag = true;
    var rect = scrubbing.li.getBoundingClientRect();
    var pct = (e.clientX - rect.left) / rect.width;
    pct = Math.max(0, Math.min(1, pct));
    audio.currentTime = scrubbing.ch.start + pct * scrubbing.dur;
  }

  function handleScrubEnd() {
    if (!scrubbing) return;
    scrubbing.li.classList.remove('scrubbing');
    scrubbing = null;
  }

  // --- Draggable panel divider ---
  var dividerDragging = false;

  function initDivider() {
    var divider = config.container.querySelector('.panel-divider');
    var contentArea = config.container.querySelector('.content-area');
    var chapterPanel = config.container.querySelector('.chapter-panel');
    var transcriptPanel = config.container.querySelector('.transcript-panel');

    divider.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dividerDragging = true;
      divider.classList.add('dragging');
    });

    document.addEventListener('mousemove', function (e) {
      if (!dividerDragging) return;
      var rect = contentArea.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var total = rect.width - 5; // minus divider width
      var leftPct = Math.max(5, Math.min(95, (x / rect.width) * 100));
      chapterPanel.style.flex = '0 0 ' + leftPct + '%';
      transcriptPanel.style.flex = '0 0 ' + (100 - leftPct) + '%';
    });

    document.addEventListener('mouseup', function () {
      if (!dividerDragging) return;
      dividerDragging = false;
      divider.classList.remove('dragging');
    });
  }

  function renderTranscript() {
    var container = config.container;
    var chunksEl = container.querySelector('#transcript-chunks');
    if (chunksEl) chunksEl.innerHTML = '';
  }

  function renderTranscriptChunks(chapterIndex) {
    var container = config.container;
    var chunksEl = container.querySelector('#transcript-chunks');
    if (!chunksEl) return;

    var bt = getBookTranscript();
    if (!bt) return;
    var ct = bt.chapters.find(function (c) { return c.index === chapterIndex; });
    if (!ct) { chunksEl.innerHTML = ''; return; }

    var slug = currentBook.filename.replace(/\.[^.]+$/, '');
    chunksEl.innerHTML = '';

    ct.chunks.forEach(function (chunk) {
      var div = document.createElement('div');
      div.className = 'transcript-chunk';
      div.id = 'tc-' + chapterIndex + '-' + chunk.index;

      var textSpan = document.createElement('span');
      textSpan.className = 'chunk-text';
      textSpan.textContent = chunk.text;
      textSpan.onclick = function () {
        var ch = currentBook.chapters[chapterIndex - 1];
        if (ch) { audio.currentTime = ch.start + chunk.start; audio.play(); }
      };

      var flagDiv = document.createElement('span');
      flagDiv.className = 'chunk-flag';
      if (RepoStoryFeedback.isFlagged(slug, chapterIndex, chunk.index)) {
        flagDiv.classList.add('flagged');
      }

      var flagBtn = document.createElement('button');
      flagBtn.innerHTML = '&#x26A0;';
      flagBtn.title = 'Flag transcription error';
      if (RepoStoryFeedback.isFlagged(slug, chapterIndex, chunk.index)) {
        flagBtn.classList.add('flagged');
      }
      flagBtn.onclick = function () {
        var ch = currentBook.chapters[chapterIndex - 1];
        var timestamp = ch ? ch.start + chunk.start : chunk.start;
        if (flagBtn.classList.contains('flagged')) {
          RepoStoryFeedback.unflag(slug, chapterIndex, chunk.index);
          flagBtn.classList.remove('flagged');
          flagDiv.classList.remove('flagged');
        } else {
          RepoStoryFeedback.flag(slug, chapterIndex, chunk.index, chunk.text, timestamp);
          flagBtn.classList.add('flagged');
          flagDiv.classList.add('flagged');
        }
      };

      flagDiv.appendChild(flagBtn);
      div.appendChild(textSpan);
      div.appendChild(flagDiv);
      chunksEl.appendChild(div);
    });
  }

  var lastActiveChapterId = null;
  var lastActiveChunkId = null;
  var userScrolledChapters = false;
  var userScrolledTranscript = false;

  function updatePlayer() {
    requestAnimationFrame(updatePlayer);
    if (!currentBook) return;
    var container = config.container;

    var t = audio.currentTime;
    var d = audio.duration || currentBook.duration;
    container.querySelector('#current-time').textContent = formatTime(t);
    container.querySelector('#total-time').textContent = formatTime(d);
    container.querySelector('#progress').style.width = (t / d * 100) + '%';
    container.querySelector('#play-btn').innerHTML = audio.paused ? '&#9654;' : '&#9646;&#9646;';

    var ch = getCurrentChapter();
    if (ch) {
      container.querySelector('#chapter-title').textContent = ch.title;

      // Only update progress/scrubber on active chapter
      container.querySelectorAll('.chapter-list li').forEach(function (li, i) {
        var isActive = i === ch.id;
        li.classList.toggle('active', isActive);

        var prog = li.querySelector('.ch-progress');
        var scrub = li.querySelector('.ch-scrubber');
        if (!prog) return;

        if (isActive) {
          var chData = currentBook.chapters[i];
          var chDur = chData.end - chData.start;
          var pct = (t - chData.start) / chDur * 100;
          pct = Math.max(0, Math.min(100, pct));
          prog.style.width = pct + '%';
          if (scrub) scrub.style.left = 'calc(' + pct + '% - 6px)';
        } else {
          prog.style.width = '0%';
        }
      });

      // Auto-scroll active chapter into view (paused if user scrolled manually)
      if (!userScrolledChapters) {
        var activeLi = container.querySelector('#ch-' + ch.id);
        if (activeLi) {
          var chList = container.querySelector('.chapter-list');
          var liTop = activeLi.offsetTop - chList.offsetTop;
          var liH = activeLi.offsetHeight;
          var visible = liTop >= chList.scrollTop && (liTop + liH) <= (chList.scrollTop + chList.clientHeight);
          if (!visible) {
            chList.scrollTop = liTop - chList.clientHeight / 3;
          }
        }
      }

      // Update transcript when chapter changes — re-enable auto-scroll
      if (ch.id !== lastActiveChapterId) {
        lastActiveChapterId = ch.id;
        lastActiveChunkId = null;
        userScrolledChapters = false;
        userScrolledTranscript = false;
        renderTranscriptChunks(ch.id + 1);
      }

      // Update active chunk highlight
      var cur = getCurrentChunk();
      if (cur) {
        var chunkId = cur.chunk.index;
        if (chunkId !== lastActiveChunkId) {
          if (lastActiveChunkId !== null) {
            var prev = container.querySelector('#tc-' + (ch.id + 1) + '-' + lastActiveChunkId);
            if (prev) prev.classList.remove('active');
          }
          var el = container.querySelector('#tc-' + cur.chapterIndex + '-' + chunkId);
          if (el) {
            el.classList.add('active');
            // Auto-scroll transcript (paused if user scrolled manually)
            if (!userScrolledTranscript) {
              var chunksContainer = container.querySelector('#transcript-chunks');
              if (chunksContainer) {
                var elTop = el.offsetTop - chunksContainer.offsetTop;
                var scrollTarget = elTop - chunksContainer.clientHeight / 3;
                chunksContainer.scrollTop = scrollTarget;
              }
            }
          }
          lastActiveChunkId = chunkId;
        }
      }
    }
  }

  // --- Actions ---

  function openBook(idx) {
    currentBook = config.books[idx];
    currentBookIdx = idx;
    lastActiveChapterId = null;
    lastActiveChunkId = null;
    var container = config.container;

    container.querySelector('#library').style.display = 'none';
    container.querySelector('#player-view').classList.add('active');
    container.querySelector('#book-title').textContent = currentBook.title;

    audio.src = (config.audioBaseUrl || 'audio/') + currentBook.filename;
    audio.load();

    var p = getProgress(idx);
    audio.addEventListener('loadedmetadata', function onload() {
      audio.currentTime = p.time || 0;
      audio.removeEventListener('loadedmetadata', onload);
    });

    renderChapters();
    renderTranscript();
    updatePlayer();
  }

  function showLibrary() {
    saveProgress();
    audio.pause();
    localStorage.removeItem('rs-last-book');
    var container = config.container;
    container.querySelector('#player-view').classList.remove('active');
    container.querySelector('#library').style.display = 'block';
    renderLibrary();
  }

  function togglePlay() { audio.paused ? audio.play() : audio.pause(); }
  function skip(s) { audio.currentTime = Math.max(0, audio.currentTime + s); }

  function prevChapter() {
    var ch = getCurrentChapter();
    if (!ch || ch.id === 0) { audio.currentTime = 0; return; }
    audio.currentTime = currentBook.chapters[ch.id - 1].start;
  }

  function nextChapter() {
    var ch = getCurrentChapter();
    if (!ch || ch.id >= currentBook.chapters.length - 1) return;
    audio.currentTime = currentBook.chapters[ch.id + 1].start;
  }

  function seekTo(e) {
    var bar = config.container.querySelector('#track-bar');
    var pct = (e.clientX - bar.getBoundingClientRect().left) / bar.offsetWidth;
    audio.currentTime = pct * (audio.duration || currentBook.duration);
  }

  function cycleSpeed() {
    speedIdx = (speedIdx + 1) % speeds.length;
    audio.playbackRate = speeds[speedIdx];
    config.container.querySelector('#speed-btn').textContent = speeds[speedIdx] + 'x';
  }

  // --- Init ---

  function loadTranscripts(url) {
    if (!url) return;
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) { transcriptData = data; })
      .catch(function () { /* transcripts unavailable — player works without them */ });
  }

  function init(opts) {
    config = opts;

    RepoStoryFeedback.init(opts.feedbackUrl);
    loadTranscripts(opts.transcriptUrl);


    // Build DOM
    config.container.innerHTML = '' +
      '<div class="library" id="library">' +
      '  <h1>repo story</h1>' +
      '  <div class="book-list" id="book-list"></div>' +
      '</div>' +
      '<div class="player-view" id="player-view">' +
      '  <button class="back-btn" id="back-btn">&larr; Library</button>' +
      '  <div class="now-playing">' +
      '    <div class="book-title" id="book-title"></div>' +
      '    <div class="chapter-title" id="chapter-title"></div>' +
      '  </div>' +
      '  <div class="content-area">' +
      '    <div class="chapter-panel" style="flex: 0 0 50%">' +
      '      <div class="chapter-panel-header">' +
      '        <h3>Chapters</h3>' +
      '      </div>' +
      '      <ul class="chapter-list" id="chapter-list"></ul>' +
      '    </div>' +
      '    <div class="panel-divider"></div>' +
      '    <div class="transcript-panel" style="flex: 0 0 calc(50% - 5px)">' +
      '      <div class="transcript-panel-header">' +
      '        <h3>Transcript</h3>' +
      '      </div>' +
      '      <div class="transcript-chunks" id="transcript-chunks"></div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="player-controls">' +
      '    <div class="time-display">' +
      '      <span id="current-time">0:00</span>' +
      '      <span id="total-time">0:00</span>' +
      '    </div>' +
      '    <div class="track-bar" id="track-bar">' +
      '      <div class="progress" id="progress"></div>' +
      '    </div>' +
      '    <div class="controls">' +
      '      <button id="btn-back30">-30s</button>' +
      '      <button id="btn-prev">&laquo;</button>' +
      '      <button class="play-btn" id="play-btn">&#9654;</button>' +
      '      <button id="btn-next">&raquo;</button>' +
      '      <button id="btn-fwd30">+30s</button>' +
      '      <button class="speed-btn" id="speed-btn">1x</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    // Create audio element
    audio = document.createElement('audio');
    audio.preload = 'metadata';
    config.container.appendChild(audio);

    // Bind events
    config.container.querySelector('#back-btn').onclick = showLibrary;
    config.container.querySelector('#track-bar').onclick = seekTo;
    config.container.querySelector('#btn-back30').onclick = function () { skip(-30); };
    config.container.querySelector('#btn-prev').onclick = prevChapter;
    config.container.querySelector('#play-btn').onclick = togglePlay;
    config.container.querySelector('#btn-next').onclick = nextChapter;
    config.container.querySelector('#btn-fwd30').onclick = function () { skip(30); };
    config.container.querySelector('#speed-btn').onclick = cycleSpeed;

    // Global scrub drag handlers
    document.addEventListener('mousemove', handleScrubMove);
    document.addEventListener('mouseup', handleScrubEnd);

    // Detect user-initiated scrolling to pause auto-scroll
    config.container.querySelector('#chapter-list').addEventListener('wheel', function () {
      userScrolledChapters = true;
    });
    config.container.querySelector('#transcript-chunks').addEventListener('wheel', function () {
      userScrolledTranscript = true;
    });
    // Also detect scrollbar drag via pointerdown inside the scrollable areas
    config.container.querySelector('#chapter-list').addEventListener('pointerdown', function (e) {
      // Scrollbar click: pointerdown on the element itself (not a child) near the right edge
      var rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX > rect.right - 20) userScrolledChapters = true;
    });
    config.container.querySelector('#transcript-chunks').addEventListener('pointerdown', function (e) {
      var rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX > rect.right - 20) userScrolledTranscript = true;
    });

    // Draggable panel divider
    initDivider();

    // Save progress on page close/refresh
    window.addEventListener('beforeunload', saveProgress);

    // Save progress periodically
    setInterval(saveProgress, 5000);
    audio.addEventListener('ended', saveProgress);

    // Register service worker for offline support
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    renderLibrary();

    // Auto-resume last open book
    var lastBook = localStorage.getItem('rs-last-book');
    if (lastBook !== null) {
      var idx = parseInt(lastBook, 10);
      if (idx >= 0 && idx < config.books.length) {
        openBook(idx);
      }
    }
  }

  return { init: init };
})();
