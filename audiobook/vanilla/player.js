/**
 * player.js — Repo Story audiobook player component (per-chapter model).
 *
 * Each book contains a list of chapter objects with per-chapter audio URLs:
 *   { id, n, title, filename, start, end, duration, size,
 *     summary?: { filename, duration, size } }
 *
 * `start`/`end` are book-relative (sum of prior chapter durations); the actual
 * <audio> element only loads one chapter at a time, so audio.currentTime is
 * chapter-local. Use bookTime() / bookDuration() for book-relative reads,
 * and seekToBookTime() / loadChapter() for navigation.
 *
 * Summary mode (#mode-full/#mode-summary): chapters may carry a condensed
 * summary track. The mode swaps the audio source, the transcript chunks
 * (transcripts.json chapter.summary_chunks), and the whole time model onto
 * the summary clock — book-relative summary starts are computed client-side
 * in openBook, so seeking/track-bar/progress all work per mode. Positions
 * don't map between the two clocks, so a mode switch restarts the chapter.
 *
 * Usage:
 *   RepoStoryPlayer.init({
 *     container: document.getElementById('app'),
 *     books: [...],
 *     audioBaseUrl: 'audio/',
 *     transcriptUrl: 'transcripts.json',
 *     feedbackUrl: 'https://bl.landry.bot/events',
 *     title: 'My Audiobooks'
 *   });
 */
var RepoStoryPlayer = (function () {
  var config = {};
  var currentBook = null;
  var currentBookIdx = null;
  var currentChapterIdx = 0;
  var audio = null;
  var speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];
  var speedIdx = 1;
  var transcriptData = null;
  var pendingPlayAfterLoad = false;
  var loadGen = 0;  // monotonically-increasing id; lets us cancel stale loadedmetadata callbacks

  // Summary mode: swaps audio + transcript + time model onto the condensed
  // per-chapter summary tracks. Effective only for books that carry them.
  var summaryMode = localStorage.getItem('rs-summary') === '1';
  var summaryStarts = null;   // per-chapter book-relative starts on the summary clock
  var summaryTotal = 0;

  function bookHasSummaries(book) {
    return !!(book && book.chapters && book.chapters.some(function (c) { return c.summary; }));
  }

  function chStart(ch) {
    return (summaryMode && summaryStarts) ? summaryStarts[ch.id] : ch.start;
  }

  function chDur(ch) {
    if (summaryMode && ch.summary) return ch.summary.duration;
    return ch.duration || (ch.end - ch.start);
  }

  function chunksFor(ct) {
    return summaryMode ? (ct.summary_chunks || []) : ct.chunks;
  }

  // Cached DOM references (set once in openBook)
  var dom = {};

  function formatTime(s) {
    if (isNaN(s)) return '0:00';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = Math.floor(s % 60);
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  }

  function audioUrlFor(chapter) {
    var file = (summaryMode && chapter.summary) ? chapter.summary.filename : chapter.filename;
    return (config.audioBaseUrl || 'audio/') + file;
  }

  // --- URL routing ---
  // Hash format: '#/<slug>'. Library = empty hash.

  function slugify(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  function bookSlug(book) {
    if (book.slug && book.slug !== 'book') return book.slug;
    var s = slugify(book.title);
    return s || book.slug || 'book';
  }

  function bookIdxFromSlug(slug) {
    if (!slug) return -1;
    for (var i = 0; i < config.books.length; i++) {
      if (bookSlug(config.books[i]) === slug) return i;
    }
    return -1;
  }

  function setUrlForBook(idx) {
    var target = idx == null ? '' : '#/' + encodeURIComponent(bookSlug(config.books[idx]));
    if (window.location.hash === target) return;
    var url = target || (window.location.pathname + window.location.search);
    history.pushState(null, '', url);
  }

  function bookTime() {
    if (!currentBook) return 0;
    var ch = currentBook.chapters[currentChapterIdx];
    if (!ch) return 0;
    return chStart(ch) + (audio.currentTime || 0);
  }

  function bookDuration() {
    if (!currentBook) return 0;
    if (summaryMode && summaryStarts) return summaryTotal;
    return currentBook.duration;
  }

  function getProgress(bookIdx) {
    try {
      var val = localStorage.getItem('rs-progress-' + bookIdx);
      if (!val) return { bookTime: 0, progress: 0 };
      var p = JSON.parse(val);
      // Backward-compat: old format stored `time` (book-relative).
      if (p.time !== undefined && p.bookTime === undefined) p.bookTime = p.time;
      return p;
    } catch (e) {
      return { bookTime: 0, progress: 0 };
    }
  }

  function saveProgress() {
    if (currentBook === null || currentBookIdx === null) return;
    var bt = bookTime();
    var dur = bookDuration() || 1;
    var p = bt / dur;
    var ch = currentBook.chapters[currentChapterIdx];
    localStorage.setItem('rs-progress-' + currentBookIdx, JSON.stringify({
      bookTime: bt,
      progress: p,
      chapterIdx: currentChapterIdx,
      chapterN: ch ? ch.n : null,
      timeInChapter: audio.currentTime || 0,
      summary: summaryMode
    }));
    localStorage.setItem('rs-last-book', String(currentBookIdx));
  }

  function findChapterIdxAt(bt) {
    var chapters = currentBook.chapters;
    var lo = 0, hi = chapters.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (chStart(chapters[mid]) <= bt) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Load a chapter into the audio element. timeInChapter = seconds into chapter.
  // autoplay controls whether to .play() once metadata is ready.
  function loadChapter(idx, timeInChapter, autoplay) {
    if (!currentBook) return;
    if (idx < 0 || idx >= currentBook.chapters.length) return;
    cancelScenePause();
    currentChapterIdx = idx;
    pendingPlayAfterLoad = !!autoplay;
    var myGen = ++loadGen;

    var ch = currentBook.chapters[idx];
    audio.src = audioUrlFor(ch);
    audio.load();

    var t = Math.max(0, timeInChapter || 0);
    var onMeta = function () {
      audio.removeEventListener('loadedmetadata', onMeta);
      if (myGen !== loadGen) return;  // a newer loadChapter superseded this one
      try { audio.currentTime = Math.min(t, audio.duration || t); } catch (e) {}
      if (pendingPlayAfterLoad) {
        pendingPlayAfterLoad = false;
        audio.play().catch(function () {});
      }
    };
    audio.addEventListener('loadedmetadata', onMeta);
  }

  function seekToBookTime(bt, autoplay) {
    if (!currentBook) return;
    setFollow(true, false);  // explicit navigation re-arms following
    bt = Math.max(0, Math.min(bt, bookDuration()));
    var idx = findChapterIdxAt(bt);
    var ch = currentBook.chapters[idx];
    var timeInChapter = bt - chStart(ch);
    if (idx === currentChapterIdx) {
      try { audio.currentTime = timeInChapter; } catch (e) {}
      if (autoplay) audio.play().catch(function () {});
    } else {
      loadChapter(idx, timeInChapter, autoplay);
    }
  }

  function getCurrentChapter() {
    if (!currentBook) return null;
    return currentBook.chapters[currentChapterIdx] || null;
  }

  function getBookTranscript() {
    if (!transcriptData || !currentBook) return null;
    var slug = currentBook.slug || currentBook.filename || 'book';
    if (slug.replace) slug = slug.replace(/\.[^.]+$/, '');
    return transcriptData.books.find(function (b) { return b.slug === slug; }) || null;
  }

  // Binary search for chunk at chapter-local time
  function getCurrentChunk() {
    var bt = getBookTranscript();
    if (!bt) return null;
    var ch = getCurrentChapter();
    if (!ch) return null;
    var ct = bt.chapters.find(function (c) { return c.index === ch.id + 1; });
    if (!ct) return null;
    var chunks = chunksFor(ct);
    if (!chunks.length) return null;
    var timeInChapter = audio.currentTime || 0;
    var lo = 0, hi = chunks.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (chunks[mid].start <= timeInChapter) lo = mid;
      else hi = mid - 1;
    }
    if (timeInChapter >= chunks[lo].start && timeInChapter < chunks[lo].end) {
      return { chapterIndex: ch.id + 1, chunk: chunks[lo] };
    }
    return null;
  }

  // --- Offline download ---

  function checkOfflineStatus(book) {
    if (!('caches' in window)) return Promise.resolve(false);
    return caches.open('audiobook-audio').then(function (cache) {
      // Probe the first and last chapter URLs as a quick "fully cached" heuristic.
      // (A rigorous check would iterate all chapters; this is sufficient for the badge.)
      var probes = [];
      if (book.chapters.length) {
        probes.push(book.chapters[0]);
        if (book.chapters.length > 1) probes.push(book.chapters[book.chapters.length - 1]);
      }
      return Promise.all(probes.map(function (ch) {
        var url = (config.audioBaseUrl || 'audio/') + ch.filename;  // full track, mode-independent
        var abs = new URL(url, window.location.href).href;
        return cache.match(url).then(function (r) {
          return r || cache.match(abs);
        });
      })).then(function (results) {
        return results.length > 0 && results.every(Boolean);
      });
    }).catch(function () { return false; });
  }

  function downloadForOffline(book, btn) {
    btn.classList.add('downloading');
    btn.innerHTML = 'Preparing&hellip;';
    btn.title = 'Downloading all chapters — keep page open';

    // Keep screen on during download
    var wakeLock = null;
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
      }).catch(function () {});
    }

    function onBeforeUnload(e) { e.preventDefault(); e.returnValue = ''; }
    window.addEventListener('beforeunload', onBeforeUnload);

    function cleanup() {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (wakeLock) { wakeLock.release(); wakeLock = null; }
    }

    // Step 1: cache shell + transcripts
    var shell = ['./', 'player.css', 'player.js', 'feedback.js',
      'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
    if (config.transcriptUrl) shell.push(config.transcriptUrl);

    var total = book.chapters.length;

    caches.open('audiobook-audio').then(function (cache) {
      return Promise.all(shell.map(function (file) {
        var abs = new URL(file, window.location.href).href;
        return fetch(abs).then(function (r) {
          if (r.ok) return cache.put(abs, r);
        }).catch(function () {});
      })).then(function () { return cache; });
    }).then(function (cache) {
      // Step 2: each chapter, sequentially. Already-cached chapters are
      // skipped silently (so resume after interruption picks up cleanly,
      // and the counter only flashes on chapters that actually fetch).
      var chain = Promise.resolve();
      book.chapters.forEach(function (ch, i) {
        // Both tracks, mode-independent: offline must work in either mode.
        var files = [ch.filename];
        if (ch.summary) files.push(ch.summary.filename);
        files.forEach(function (file) {
          chain = chain.then(function () {
            var url = (config.audioBaseUrl || 'audio/') + file;
            var abs = new URL(url, window.location.href).href;
            return cache.match(abs).then(function (existing) {
              if (existing) return;  // already cached → skip, no UI flash
              btn.innerHTML = 'Ch ' + (i + 1) + '/' + total;
              return fetch(abs).then(function (r) {
                if (!r.ok) throw new Error('fetch ' + url + ' failed');
                return r.blob().then(function (blob) {
                  return cache.put(abs, new Response(blob, { headers: r.headers }));
                });
              });
            });
          });
        });
      });
      return chain;
    }).then(function () {
      cleanup();
      btn.classList.remove('downloading');
      btn.classList.add('downloaded');
      btn.innerHTML = 'Downloaded &#10003;';
      btn.title = 'Available offline';
    }).catch(function () {
      cleanup();
      btn.classList.remove('downloading');
      btn.innerHTML = 'Download &#8615;';
      btn.title = 'Download failed — try again';
    });
  }

  // --- Rendering ---

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
      dlBtn.innerHTML = 'Download &#8615;';
      dlBtn.title = 'Download all chapters for offline';
      dlBtn.onclick = function (e) {
        e.stopPropagation();
        if (dlBtn.classList.contains('downloaded') || dlBtn.classList.contains('downloading')) return;
        downloadForOffline(book, dlBtn);
      };

      checkOfflineStatus(book).then(function (cached) {
        if (cached) {
          dlBtn.classList.add('downloaded');
          dlBtn.innerHTML = 'Downloaded &#10003;';
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

  // Chapter list item references (indexed by chapter id)
  var chapterLis = [];
  var chapterProgs = [];
  var chapterScrubs = [];

  function renderChapters() {
    var list = dom.chapterList;
    list.innerHTML = '';
    chapterLis = [];
    chapterProgs = [];
    chapterScrubs = [];

    dom.trackBar.querySelectorAll('.chapter-mark').forEach(function (el) { el.remove(); });

    currentBook.chapters.forEach(function (ch, i) {
      var li = document.createElement('li');
      li.id = 'ch-' + i;
      li.setAttribute('data-ch', i + 1);
      var dur = ch.duration || (ch.end - ch.start);

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

      scrubberEl.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        didDrag = false;
        li.classList.add('scrubbing');
        scrubbing = { li: li, ch: ch, idx: i, dur: dur };
      });

      li.addEventListener('mousedown', function (e) {
        if (e.target === scrubberEl) return;
        didDrag = false;
      });

      li.addEventListener('click', function (e) {
        if (didDrag) return;
        if (e.target === scrubberEl) return;
        setFollow(true, false);
        loadChapter(i, 0, true);
      });

      list.appendChild(li);
      chapterLis.push(li);
      chapterProgs.push(progressEl);
      chapterScrubs.push(scrubberEl);

      if (i > 0 && currentBook.duration > 0) {
        var mark = document.createElement('div');
        mark.className = 'chapter-mark';
        mark.style.left = (ch.start / currentBook.duration * 100) + '%';
        dom.trackBar.appendChild(mark);
      }
    });
  }

  function handleScrubMove(e) {
    if (!scrubbing) return;
    didDrag = true;
    var rect = scrubbing.li.getBoundingClientRect();
    var pct = (e.clientX - rect.left) / rect.width;
    pct = Math.max(0, Math.min(1, pct));
    var timeInChapter = pct * scrubbing.dur;
    if (scrubbing.idx === currentChapterIdx) {
      try { audio.currentTime = timeInChapter; } catch (e) {}
    }
  }

  function handleScrubEnd() {
    if (!scrubbing) return;
    setFollow(true, false);
    if (scrubbing.idx !== currentChapterIdx) {
      // User scrubbed within a non-loaded chapter — load it at the scrub position.
      var rect = scrubbing.li.getBoundingClientRect();
      // We don't have the final pct here; use whatever the in-progress drag set.
      // Simpler: if they scrubbed, treat as a click → seek to start of that chapter.
      loadChapter(scrubbing.idx, 0, true);
    }
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

    function resizePanels(clientX) {
      var rect = contentArea.getBoundingClientRect();
      var leftPct = Math.max(5, Math.min(95, ((clientX - rect.left) / rect.width) * 100));
      chapterPanel.style.flex = '0 0 ' + leftPct + '%';
      transcriptPanel.style.flex = '0 0 ' + (100 - leftPct) + '%';
    }

    divider.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dividerDragging = true;
      divider.classList.add('dragging');
    });
    document.addEventListener('mousemove', function (e) {
      if (!dividerDragging) return;
      resizePanels(e.clientX);
    });
    document.addEventListener('mouseup', function () {
      if (!dividerDragging) return;
      dividerDragging = false;
      divider.classList.remove('dragging');
    });

    divider.addEventListener('touchstart', function (e) {
      e.preventDefault();
      dividerDragging = true;
      divider.classList.add('dragging');
    });
    document.addEventListener('touchmove', function (e) {
      if (!dividerDragging) return;
      resizePanels(e.touches[0].clientX);
    });
    document.addEventListener('touchend', function () {
      if (!dividerDragging) return;
      dividerDragging = false;
      divider.classList.remove('dragging');
    });
  }

  function renderTranscript() {
    if (dom.transcriptChunks) dom.transcriptChunks.innerHTML = '';
  }

  function renderTranscriptChunks(chapterIndex) {
    var chunksEl = dom.transcriptChunks;
    if (!chunksEl) return;

    var bt = getBookTranscript();
    if (!bt) return;
    var ct = bt.chapters.find(function (c) { return c.index === chapterIndex; });
    if (!ct) { chunksEl.innerHTML = ''; return; }

    chunksEl.innerHTML = '';

    chunksFor(ct).forEach(function (chunk) {
      var div = document.createElement('div');
      div.className = 'transcript-chunk';
      if (isSceneBreakChunk(chunk)) div.className += ' scene-break';
      div.id = 'tc-' + chapterIndex + '-' + chunk.index;

      var textSpan = document.createElement('span');
      textSpan.className = 'chunk-text';
      textSpan.textContent = chunk.text;
      div.onclick = function () {
        var ch = currentBook.chapters[chapterIndex - 1];
        if (!ch) return;
        setFollow(true, false);
        if ((chapterIndex - 1) === currentChapterIdx) {
          try { audio.currentTime = chunk.start; } catch (e) {}
          audio.play().catch(function () {});
        } else {
          loadChapter(chapterIndex - 1, chunk.start, true);
        }
      };

      div.appendChild(textSpan);
      chunksEl.appendChild(div);
    });
  }

  var lastActiveChapterId = null;
  var lastActiveChunkId = null;
  var userScrolledChapters = false;
  // Transcript follow: explicit, user-visible state (#follow-btn) instead of
  // the old hidden scroll heuristic. Manual scroll gestures turn it off;
  // explicit navigation (chunk/chapter click, seek, skip, prev/next) re-arms.
  var followTranscript = localStorage.getItem('rs-follow') !== '0';

  // Programmatic scrolls (follow, chapter auto-scroll) fire the same scroll
  // events as user scrolling; mark them so the auto-hiding scrollbar only
  // wakes for real user scrolls. The window covers the smooth-scroll animation.
  function markProgrammaticScroll(el) {
    el._sbQuietUntil = Date.now() + 700;
  }

  function scrollToActiveChunk() {
    var box = dom.transcriptChunks;
    if (!box) return;
    var el = box.querySelector('.transcript-chunk.active');
    if (!el) return;
    // Rect-based: offsetTop is offsetParent-relative (the box itself), so the
    // old `offsetTop - box.offsetTop` double-subtracted and parked the active
    // chunk below the fold.
    var er = el.getBoundingClientRect(), br = box.getBoundingClientRect();
    markProgrammaticScroll(box);
    box.scrollTop += (er.top - br.top) - box.clientHeight / 3;
  }

  function setFollow(on, snap) {
    followTranscript = on;
    localStorage.setItem('rs-follow', on ? '1' : '0');
    var btn = config.container && config.container.querySelector('#follow-btn');
    if (btn) btn.classList.toggle('on', on);
    if (on && snap !== false) scrollToActiveChunk();
  }

  // Transcript text size: A−/A+ stepper setting --ts-scale = RATIO^n,
  // n in [MIN, MAX], persisted as the exponent (rs-textsize-n).
  var TS_RATIO = 1.25, TS_MIN = -2, TS_MAX = 3;
  var textSize = parseInt(localStorage.getItem('rs-textsize-n') || '0', 10);
  if (isNaN(textSize) || textSize < TS_MIN || textSize > TS_MAX) textSize = 0;

  function applyTextSize() {
    var box = config.container.querySelector('#transcript-chunks');
    if (!box) return;
    box.style.setProperty('--ts-scale', Math.pow(TS_RATIO, textSize).toFixed(4));
    var dec = config.container.querySelector('#ts-dec');
    var inc = config.container.querySelector('#ts-inc');
    if (dec) dec.disabled = textSize === TS_MIN;
    if (inc) inc.disabled = textSize === TS_MAX;
  }

  function stepTextSize(delta) {
    var next = Math.max(TS_MIN, Math.min(TS_MAX, textSize + delta));
    if (next === textSize) return;
    textSize = next;
    localStorage.setItem('rs-textsize-n', String(textSize));
    applyTextSize();
    if (followTranscript) scrollToActiveChunk();  // reflow moved the text
  }


  // Summary-clock cumulative starts for the open book; chapters lacking a
  // summary track fall back to their full audio + duration in summary mode.
  function computeSummaryTimeline(book) {
    if (!bookHasSummaries(book)) { summaryStarts = null; summaryTotal = 0; return; }
    summaryStarts = [];
    var t = 0;
    book.chapters.forEach(function (ch) {
      summaryStarts.push(t);
      t += (ch.summary ? ch.summary.duration : ch.duration) || 0;
    });
    summaryTotal = t;
  }

  function setSummaryMode(on, opts) {
    if (on && !bookHasSummaries(currentBook)) on = false;
    var changed = on !== summaryMode;
    summaryMode = on;
    localStorage.setItem('rs-summary', on ? '1' : '0');
    var fullBtn = config.container.querySelector('#mode-full');
    var sumBtn = config.container.querySelector('#mode-summary');
    if (fullBtn) fullBtn.classList.toggle('on', !on);
    if (sumBtn) sumBtn.classList.toggle('on', on);
    if (!currentBook || (!changed && !(opts && opts.force))) return;
    // The two clocks don't map onto each other — restart the chapter.
    var wasPlaying = !audio.paused;
    lastFormattedTime = '';
    lastPlayState = null;      // forces the total-time refresh next frame
    lastActiveChunkId = null;
    renderTranscriptChunks(currentChapterIdx + 1);
    loadChapter(currentChapterIdx, 0, wasPlaying);
  }

  // Reading mode: transcript-only view — chapter panel and header chrome
  // hidden, controls compacted (see .reading-mode rules in player.css).
  var readingMode = localStorage.getItem('rs-reading') === '1';

  function setReadingMode(on) {
    readingMode = on;
    localStorage.setItem('rs-reading', on ? '1' : '0');
    var view = config.container.querySelector('#player-view');
    if (view) view.classList.toggle('reading-mode', on);
    var btn = config.container.querySelector('#reading-btn');
    if (btn) btn.classList.toggle('on', on);
    if (followTranscript) scrollToActiveChunk();  // layout change moved things
  }
  var lastFormattedTime = '';
  var lastPlayState = null;

  // Scene-transition pause. The source marks scene changes with a "* * *"
  // divider that the audio does NOT speak; we hold playback briefly when
  // crossing one (detected via the transcript) so scenes feel separated.
  var SCENE_PAUSE_MS = 2000;
  var lastTickTime = 0;
  var lastTickChapterId = null;
  var scenePauseTimer = null;

  function isSceneBreakChunk(chunk) {
    if (!chunk) return false;
    if (chunk.scene_break) return true;
    var t = chunk.text || '';
    return /^[\s*]+$/.test(t) && (t.match(/\*/g) || []).length >= 2;
  }

  function cancelScenePause() {
    if (scenePauseTimer !== null) { clearTimeout(scenePauseTimer); scenePauseTimer = null; }
  }

  // Called each frame: if normal playback just crossed a scene-break marker,
  // pause for SCENE_PAUSE_MS then resume. Big time jumps (seeks) and chapter
  // changes re-arm without triggering.
  function checkSceneBreakPause(ch, t) {
    var lt = lastTickTime, lc = lastTickChapterId;
    lastTickTime = t;
    lastTickChapterId = ch.id;
    if (scenePauseTimer !== null || audio.paused) return;  // mid-pause or stopped
    if (ch.id !== lc) return;                               // chapter just changed
    if (t <= lt || t - lt > 1.5) return;                    // no progress, or a seek
    var bt = getBookTranscript();
    var ct = bt && bt.chapters.find(function (c) { return c.index === ch.id + 1; });
    if (!ct) return;
    for (var i = 0; i < ct.chunks.length; i++) {
      var c = ct.chunks[i];
      if (isSceneBreakChunk(c) && c.start > lt && c.start <= t) {
        audio.pause();
        scenePauseTimer = setTimeout(function () {
          scenePauseTimer = null;
          if (currentBook && audio.paused) audio.play().catch(function () {});
        }, SCENE_PAUSE_MS);
        return;
      }
    }
  }

  function updatePlayer() {
    requestAnimationFrame(updatePlayer);
    if (!currentBook) return;

    var bt = bookTime();
    var d = bookDuration();

    if (!trackDrag) {
      var ft = formatTime(bt);
      if (ft !== lastFormattedTime) {
        lastFormattedTime = ft;
        dom.currentTime.textContent = ft;
      }
      dom.progress.style.width = (d > 0 ? (bt / d * 100) : 0) + '%';
    }

    var paused = audio.paused;
    if (paused !== lastPlayState) {
      lastPlayState = paused;
      dom.playBtn.innerHTML = paused ? '&#9654;' : '&#9646;&#9646;';
      if (dom.miniPlayBtn) dom.miniPlayBtn.innerHTML = paused ? '&#9654;' : '&#9646;&#9646;';
      dom.totalTime.textContent = formatTime(d);
    }

    var ch = getCurrentChapter();
    if (!ch) return;

    checkSceneBreakPause(ch, audio.currentTime || 0);

    if (ch.id !== lastActiveChapterId) {
      if (lastActiveChapterId !== null && chapterLis[lastActiveChapterId]) {
        chapterLis[lastActiveChapterId].classList.remove('active');
        chapterProgs[lastActiveChapterId].style.width = '0%';
      }
      chapterLis[ch.id].classList.add('active');

      dom.chapterTitle.textContent = ch.title;

      lastActiveChapterId = ch.id;
      lastActiveChunkId = null;
      userScrolledChapters = false;
      renderTranscriptChunks(ch.id + 1);
    }

    var pct = Math.max(0, Math.min(100, ((audio.currentTime || 0) / chDur(ch)) * 100));
    chapterProgs[ch.id].style.width = pct + '%';
    if (chapterScrubs[ch.id]) {
      chapterScrubs[ch.id].style.left = 'calc(' + pct + '% - 6px)';
    }

    if (!userScrolledChapters) {
      var activeLi = chapterLis[ch.id];
      var chList = dom.chapterList;
      var ar = activeLi.getBoundingClientRect(), lr = chList.getBoundingClientRect();
      if (ar.top < lr.top || ar.bottom > lr.bottom) {
        markProgrammaticScroll(chList);
        chList.scrollTop += (ar.top - lr.top) - chList.clientHeight / 3;
      }
    }

    var cur = getCurrentChunk();
    if (cur) {
      var chunkId = cur.chunk.index;
      if (chunkId !== lastActiveChunkId) {
        if (lastActiveChunkId !== null) {
          var prev = dom.transcriptChunks.querySelector('#tc-' + (ch.id + 1) + '-' + lastActiveChunkId);
          if (prev) prev.classList.remove('active');
        }
        var el = dom.transcriptChunks.querySelector('#tc-' + cur.chapterIndex + '-' + chunkId);
        if (el) {
          el.classList.add('active');
          if (followTranscript) scrollToActiveChunk();
        }
        lastActiveChunkId = chunkId;
      }
    }
  }

  // --- Actions ---

  function openBook(idx, opts) {
    currentBook = config.books[idx];
    currentBookIdx = idx;
    lastActiveChapterId = null;
    lastActiveChunkId = null;
    lastFormattedTime = '';
    lastPlayState = null;
    if (!opts || opts.updateUrl !== false) setUrlForBook(idx);
    var container = config.container;

    container.querySelector('#library').style.display = 'none';
    container.querySelector('#player-view').classList.add('active');

    dom.currentTime = container.querySelector('#current-time');
    dom.totalTime = container.querySelector('#total-time');
    dom.progress = container.querySelector('#progress');
    dom.playBtn = container.querySelector('#play-btn');
    dom.chapterTitle = container.querySelector('#chapter-title');
    dom.bookTitle = container.querySelector('#book-title');
    dom.chapterList = container.querySelector('#chapter-list');
    dom.trackBar = container.querySelector('#track-bar');
    dom.transcriptChunks = container.querySelector('#transcript-chunks');
    dom.miniPlayBtn = container.querySelector('#mini-play-btn');

    dom.bookTitle.textContent = currentBook.title;

    // Summary toggle: timeline + visibility + effective mode for this book.
    computeSummaryTimeline(currentBook);
    var hasSummaries = bookHasSummaries(currentBook);
    var toggle = container.querySelector('#mode-toggle');
    if (toggle) toggle.style.display = hasSummaries ? '' : 'none';
    var p = getProgress(idx);
    summaryMode = hasSummaries &&
      (p.summary !== undefined ? !!p.summary : localStorage.getItem('rs-summary') === '1');
    var fullBtn = container.querySelector('#mode-full');
    var sumBtn = container.querySelector('#mode-summary');
    if (fullBtn) fullBtn.classList.toggle('on', !summaryMode);
    if (sumBtn) sumBtn.classList.toggle('on', summaryMode);

    renderChapters();
    renderTranscript();

    var bt = Math.max(0, Math.min(p.bookTime || 0, bookDuration()));
    var startIdx = findChapterIdxAt(bt);
    var startTimeInChapter = bt - chStart(currentBook.chapters[startIdx]);
    loadChapter(startIdx, startTimeInChapter, false);

    updatePlayer();
  }

  function showLibrary(opts) {
    saveProgress();
    audio.pause();
    currentBook = null;
    currentBookIdx = null;
    localStorage.removeItem('rs-last-book');
    if (!opts || opts.updateUrl !== false) setUrlForBook(null);
    var container = config.container;
    container.querySelector('#player-view').classList.remove('active');
    container.querySelector('#library').style.display = 'block';
    renderLibrary();
  }

  function applyUrlState() {
    var m = window.location.hash.match(/^#\/(.+)$/);
    if (m) {
      var idx = bookIdxFromSlug(decodeURIComponent(m[1]));
      if (idx >= 0) {
        if (idx !== currentBookIdx) openBook(idx, { updateUrl: false });
        return;
      }
    }
    if (currentBook !== null) showLibrary({ updateUrl: false });
  }

  function togglePlay() { audio.paused ? audio.play() : audio.pause(); }
  function skip(s) { seekToBookTime(bookTime() + s, !audio.paused); }

  function prevChapter() {
    if (!currentBook) return;
    setFollow(true, false);
    if (currentChapterIdx === 0) {
      try { audio.currentTime = 0; } catch (e) {}
      return;
    }
    loadChapter(currentChapterIdx - 1, 0, !audio.paused);
  }

  function nextChapter() {
    if (!currentBook) return;
    if (currentChapterIdx >= currentBook.chapters.length - 1) return;
    setFollow(true, false);
    loadChapter(currentChapterIdx + 1, 0, !audio.paused);
  }

  // Track-bar drag-to-seek, mirroring the chapter scrubber: pointer capture
  // so the gesture survives leaving the (thin) bar; audio follows LIVE while
  // the target is inside the loaded chapter, and a release in another chapter
  // loads it at that offset (loading per-move would thrash audio loads).
  var trackDrag = null;

  function trackPct(e) {
    var rect = dom.trackBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function trackDragStart(e) {
    if (!currentBook) return;
    trackDrag = { wasPlaying: !audio.paused };
    dom.trackBar.classList.add('dragging');
    dom.trackBar.setPointerCapture(e.pointerId);
    trackDragMove(e);
    e.preventDefault();
  }

  function trackDragMove(e) {
    if (!trackDrag) return;
    var pct = trackPct(e);
    var bt = pct * (currentBook.duration || 0);
    dom.progress.style.width = (pct * 100) + '%';
    dom.currentTime.textContent = formatTime(bt);
    var idx = findChapterIdxAt(bt);
    if (idx === currentChapterIdx) {
      try { audio.currentTime = bt - currentBook.chapters[idx].start; } catch (err) {}
    }
  }

  function trackDragEnd(e) {
    if (!trackDrag) return;
    var wasPlaying = trackDrag.wasPlaying;
    trackDrag = null;
    dom.trackBar.classList.remove('dragging');
    seekToBookTime(trackPct(e) * (currentBook.duration || 0), wasPlaying);
  }

  function cycleSpeed() {
    speedIdx = (speedIdx + 1) % speeds.length;
    audio.playbackRate = speeds[speedIdx];
    config.container.querySelector('#speed-btn').textContent = speeds[speedIdx] + 'x';
  }

  function onChapterEnded() {
    saveProgress();
    if (!currentBook) return;
    if (currentChapterIdx < currentBook.chapters.length - 1) {
      loadChapter(currentChapterIdx + 1, 0, true);
    }
  }

  // --- Init ---

  function loadTranscripts(url) {
    if (!url) return;
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        transcriptData = data;
        // The data often arrives after the first chapter has already rendered.
        // The tick loop marked that chapter as active (lastActiveChapterId) and
        // won't re-render it, so the transcript would stay blank until the user
        // switches chapters. Render the current chapter now that we have data.
        if (currentBook) renderTranscriptChunks(currentChapterIdx + 1);
      })
      .catch(function () {});
  }

  function init(opts) {
    config = opts;

    RepoStoryFeedback.init(opts.feedbackUrl);
    loadTranscripts(opts.transcriptUrl);

    config.container.innerHTML = '' +
      '<div class="library" id="library">' +
      '  <h1>' + (config.title || 'audiobook') + '</h1>' +
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
      '        <span class="mode-toggle" id="mode-toggle" style="display:none">' +
      '          <button class="mode-btn" id="mode-full" title="Full chapter audio + transcript">Full</button>' +
      '          <button class="mode-btn" id="mode-summary" title="Condensed summary audio + transcript">Summary</button>' +
      '        </span>' +
      '        <span class="th-spacer"></span>' +
      '        <button class="mini-play-btn" id="mini-play-btn" title="Play/pause">&#9654;</button>' +
      '        <button class="ts-btn ts-dec" id="ts-dec" title="Smaller text">A&#8722;</button>' +
      '        <button class="ts-btn ts-inc" id="ts-inc" title="Larger text">A+</button>' +
      '        <button class="follow-btn" id="follow-btn" title="Follow along with playback">&#8982; follow</button>' +
      '        <button class="reading-btn" id="reading-btn" title="Reading mode — transcript only">&#9707; read</button>' +
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

    audio = document.createElement('audio');
    audio.preload = 'metadata';
    config.container.appendChild(audio);

    config.container.querySelector('#back-btn').onclick = showLibrary;
    var trackBarEl = config.container.querySelector('#track-bar');
    trackBarEl.addEventListener('pointerdown', trackDragStart);
    trackBarEl.addEventListener('pointermove', trackDragMove);
    trackBarEl.addEventListener('pointerup', trackDragEnd);
    trackBarEl.addEventListener('pointercancel', function () {
      trackDrag = null;
      trackBarEl.classList.remove('dragging');
    });
    config.container.querySelector('#btn-back30').onclick = function () { skip(-30); };
    config.container.querySelector('#btn-prev').onclick = prevChapter;
    config.container.querySelector('#play-btn').onclick = togglePlay;
    config.container.querySelector('#btn-next').onclick = nextChapter;
    config.container.querySelector('#btn-fwd30').onclick = function () { skip(30); };
    config.container.querySelector('#speed-btn').onclick = cycleSpeed;
    var followBtn = config.container.querySelector('#follow-btn');
    followBtn.classList.toggle('on', followTranscript);
    followBtn.onclick = function () { setFollow(!followTranscript); };
    config.container.querySelector('#reading-btn').onclick = function () { setReadingMode(!readingMode); };
    config.container.querySelector('#mode-full').onclick = function () { setSummaryMode(false); };
    config.container.querySelector('#mode-summary').onclick = function () { setSummaryMode(true); };
    config.container.querySelector('#mini-play-btn').onclick = togglePlay;
    config.container.querySelector('#ts-dec').onclick = function () { stepTextSize(-1); };
    config.container.querySelector('#ts-inc').onclick = function () { stepTextSize(1); };
    applyTextSize();
    if (readingMode) setReadingMode(true);

    // Scrollbars are hidden at rest; show while scrolling, hide after idle.
    ['#chapter-list', '#transcript-chunks'].forEach(function (sel) {
      var el = config.container.querySelector(sel);
      var timer = null;
      el.addEventListener('scroll', function () {
        if (el._sbQuietUntil && Date.now() < el._sbQuietUntil) {
          // Still the programmatic smooth-scroll: slide the window so long
          // animations stay quiet end to end.
          el._sbQuietUntil = Date.now() + 200;
          return;
        }
        el.classList.add('scrolling');
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { el.classList.remove('scrolling'); }, 800);
      });
    });

    config.container.querySelector('#chapter-list').addEventListener('wheel', function () {
      userScrolledChapters = true;
    });
    config.container.querySelector('#transcript-chunks').addEventListener('wheel', function () {
      if (followTranscript) setFollow(false);
    });
    config.container.querySelector('#chapter-list').addEventListener('pointerdown', function (e) {
      var rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX > rect.right - 20) userScrolledChapters = true;
    });
    config.container.querySelector('#transcript-chunks').addEventListener('pointerdown', function (e) {
      var rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX > rect.right - 20 && followTranscript) setFollow(false);
    });

    config.container.querySelector('#chapter-list').addEventListener('touchmove', function () {
      userScrolledChapters = true;
    });
    config.container.querySelector('#transcript-chunks').addEventListener('touchmove', function () {
      if (followTranscript) setFollow(false);
    });

    document.addEventListener('mousemove', handleScrubMove);
    document.addEventListener('mouseup', handleScrubEnd);

    initDivider();

    window.addEventListener('beforeunload', saveProgress);
    setInterval(saveProgress, 5000);
    audio.addEventListener('ended', onChapterEnded);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    renderLibrary();

    window.addEventListener('popstate', applyUrlState);

    var hashMatch = window.location.hash.match(/^#\/(.+)$/);
    var hashIdx = hashMatch ? bookIdxFromSlug(decodeURIComponent(hashMatch[1])) : -1;
    if (hashIdx >= 0) {
      openBook(hashIdx, { updateUrl: false });
    } else {
      var lastBook = localStorage.getItem('rs-last-book');
      if (lastBook !== null) {
        var idx = parseInt(lastBook, 10);
        if (idx >= 0 && idx < config.books.length) {
          openBook(idx);
        }
      }
    }
  }

  return { init: init };
})();
