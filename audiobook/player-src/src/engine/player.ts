/**
 * player.ts — the imperative half.
 *
 * Everything here touches the DOM, the audio element, or a timer. The decisions
 * it makes live in ../core/, tested without a browser; this file is the wiring
 * that was tangled through 54 module-level variables in the vanilla player.
 *
 * Preact renders the library and owns structure. The 60 fps updates — progress
 * widths, active classes, the clock — stay imperative through the Shell refs,
 * because re-rendering a component tree every frame to move one CSS width is
 * the wrong tool.
 */

import { render } from 'preact';
import type { ShellRefs } from '../view/Shell.tsx';
import { Library, type LibraryBook, type TreeNode } from '../view/Library.tsx';
import type { PlayerOptions } from '../index.tsx';
import {
  type Book, type Chapter,
  chapterStart, chapterDuration, bookDuration, findChapterIdxAt, bookHasSummaries,
} from '../core/clock.ts';
import { bookSlug, bookIdxFromSlug, hashForBook, slugFromHash } from '../core/routing.ts';
import { readProgress, writeProgress, readLastBook, type KeyValueStore } from '../core/progress.ts';
import {
  bookTranscript, chapterTranscript, chunksFor, findChunkAt,
  type TranscriptData, type Chunk,
} from '../core/transcript.ts';
import { isSceneBreak, crossedSceneBreak } from '../core/scene.ts';
import {
  shouldRetry, retryDelayMs, prefetchKey, shouldPrefetch,
} from '../core/playback-policy.ts';
import { longPressDrag, resizePanels, markProgrammaticScroll, exceededSlop } from './gestures.ts';

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const TS_RATIO = 1.25;
const TS_MIN = -2;
const TS_MAX = 3;
const SCENE_PAUSE_MS = 2000;

export function formatTime(s: number): string {
  if (isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Page-level wiring that must happen exactly once, however often a host re-inits. */
let pageWired = false;
let urlWired = false;
let saveProgressTimer: ReturnType<typeof setInterval> | null = null;
let activeEngine: PlayerEngine | null = null;

if (typeof document !== 'undefined') {
  // The document-level move/up listeners act on whatever drag is current;
  // wiring them per init() stacked a fresh pair — each closing over a dead
  // container — on every host re-render.
  document.addEventListener('mousemove', (e) => activeEngine?.onDocumentMouseMove(e));
  document.addEventListener('mouseup', () => activeEngine?.onDocumentMouseUp());
}

interface DividerDrag { resize: (x: number, y: number) => void; el: HTMLElement }
interface Scrubbing { li: HTMLLIElement; idx: number; dur: number }

export class PlayerEngine {
  private opts: PlayerOptions;
  private refs: ShellRefs;
  private store: KeyValueStore;
  private audio: HTMLAudioElement;

  private books: Book[];
  private currentBook: Book | null = null;
  private currentBookIdx: number | null = null;
  private currentChapterIdx = 0;

  private transcriptData: TranscriptData | null = null;
  private loadedTranscriptUrl: string | null = null;

  private speedIdx = 1;
  private pendingPlayAfterLoad = false;
  private loadGen = 0;
  private playerLoopRunning = false;

  private summaryMode: boolean;
  private followTranscript: boolean;
  private readingMode: boolean;
  private textSize: number;

  // Recovery state. audio.paused is unreliable around an error and
  // pendingPlayAfterLoad is consumed on success, so intent is tracked apart.
  private resumePos = { idx: 0, t: 0 };
  private playIntent = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryPending = false;
  private retryGen = 0;

  private prefetchedKey: string | null = null;

  private scenePauseTimer: ReturnType<typeof setTimeout> | null = null;
  private scenePauseHolding = false;
  private lastTickTime = 0;
  private lastTickChapterId: number | null = null;

  private lastFormattedTime = '';
  private lastPlayState: boolean | null = null;
  private lastActiveChapterId: number | null = null;
  private lastActiveChunkId: number | null = null;
  private userScrolledChapters = false;

  private chapterLis: HTMLLIElement[] = [];
  private chapterProgs: HTMLElement[] = [];
  private chapterScrubs: HTMLElement[] = [];

  private scrubbing: Scrubbing | null = null;
  private didDrag = false;
  private dividerDrag: DividerDrag | null = null;
  private trackDrag: { wasPlaying: boolean } | null = null;

  private offlineState: Record<number, 'downloading' | 'downloaded' | undefined> = {};
  private openMenuFor: number | null = null;

  constructor(opts: PlayerOptions, refs: ShellRefs, store: KeyValueStore) {
    this.opts = opts;
    this.refs = refs;
    this.store = store;
    this.books = opts.books as Book[];

    this.summaryMode = store.getItem('rs-summary') === '1';
    this.followTranscript = store.getItem('rs-follow') !== '0';
    this.readingMode = store.getItem('rs-reading') === '1';
    const n = parseInt(store.getItem('rs-textsize-n') ?? '0', 10);
    this.textSize = Number.isNaN(n) || n < TS_MIN || n > TS_MAX ? 0 : n;

    this.audio = document.createElement('audio');
    this.audio.preload = 'metadata';
    opts.container.appendChild(this.audio);
    activeEngine = this;
  }

  // ---------------------------------------------------------------- clock

  private el<K extends keyof ShellRefs>(k: K): HTMLElement {
    return this.refs[k].current as unknown as HTMLElement;
  }

  private chStart(ch: Chapter): number {
    return chapterStart(this.currentBook!, ch, this.summaryMode);
  }

  private chDur(ch: Chapter): number {
    return chapterDuration(ch, this.summaryMode);
  }

  private bookTime(): number {
    if (!this.currentBook) return 0;
    const ch = this.currentBook.chapters[this.currentChapterIdx];
    if (!ch) return 0;
    return this.chStart(ch) + (this.audio.currentTime || 0);
  }

  private bookDur(): number {
    if (!this.currentBook) return 0;
    return bookDuration(this.currentBook, this.summaryMode);
  }

  private currentChapter(): Chapter | null {
    return this.currentBook?.chapters[this.currentChapterIdx] ?? null;
  }

  private audioUrlFor(ch: Chapter): string {
    const file = this.summaryMode && ch.summary?.filename ? ch.summary.filename : ch.filename;
    return (this.opts.audioBaseUrl ?? 'audio/') + file;
  }

  // ------------------------------------------------------------- progress

  private saveProgress = (): void => {
    if (!this.currentBook || this.currentBookIdx === null) return;
    const ch = this.currentChapter();
    writeProgress(this.store, this.currentBookIdx, {
      bookTime: this.bookTime(),
      duration: this.bookDur(),
      chapterIdx: this.currentChapterIdx,
      chapterN: ch?.n ?? null,
      timeInChapter: this.audio.currentTime || 0,
      summary: this.summaryMode,
    });
  };

  // ------------------------------------------------------------ chapters

  private loadChapter(idx: number, timeInChapter: number, autoplay: boolean): void {
    if (!this.currentBook) return;
    if (idx < 0 || idx >= this.currentBook.chapters.length) return;
    this.cancelScenePause();
    this.currentChapterIdx = idx;
    this.pendingPlayAfterLoad = autoplay;
    const myGen = ++this.loadGen;

    const ch = this.currentBook.chapters[idx];
    // Where to come back to if this load errors: the element itself is blank
    // after a failed load, so recovery needs its own record of the target.
    this.resumePos = { idx, t: Math.max(0, timeInChapter || 0) };
    // Now, not on the next tick: a chapter change the reader asked for must
    // show immediately even if the file is slow (or missing).
    this.setReadingChapterLabel(ch);
    this.updateMediaSessionMetadata();
    this.audio.src = this.audioUrlFor(ch);
    this.audio.load();

    const t = Math.max(0, timeInChapter || 0);
    const onMeta = () => {
      this.audio.removeEventListener('loadedmetadata', onMeta);
      if (myGen !== this.loadGen) return;   // a newer loadChapter superseded this
      try { this.audio.currentTime = Math.min(t, this.audio.duration || t); } catch { /* ignore */ }
      if (this.pendingPlayAfterLoad) {
        this.pendingPlayAfterLoad = false;
        this.audio.play().catch(() => { /* autoplay refusal is not an error */ });
      }
    };
    this.audio.addEventListener('loadedmetadata', onMeta);
  }

  private seekToBookTime(bt: number, autoplay: boolean): void {
    if (!this.currentBook) return;
    this.setFollow(true, false);   // explicit navigation re-arms following
    bt = Math.max(0, Math.min(bt, this.bookDur()));
    const idx = findChapterIdxAt(this.currentBook, bt, this.summaryMode);
    const ch = this.currentBook.chapters[idx];
    const timeInChapter = bt - this.chStart(ch);
    if (idx === this.currentChapterIdx) {
      try { this.audio.currentTime = timeInChapter; } catch { /* ignore */ }
      if (autoplay) this.audio.play().catch(() => { /* ignore */ });
    } else {
      this.loadChapter(idx, timeInChapter, autoplay);
    }
  }

  private setReadingChapterLabel(ch: Chapter | null): void {
    const el = this.refs.readingChapter.current;
    if (el && ch) el.textContent = ch.title ?? '';
  }

  // ------------------------------------------------------------- recovery

  private resetRetries = (): void => {
    this.retryCount = 0;
    this.retryGen++;
    this.retryPending = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  };

  private handleAudioError = (): void => {
    if (!this.currentBook || this.retryPending) return;
    if (!shouldRetry(this.retryCount)) return;   // capped: no infinite spin offline
    this.retryPending = true;
    const myGen = this.retryGen;
    const delay = retryDelayMs(this.retryCount);
    this.retryCount++;
    // Give the host a chance to repair entitlement first (refresh signed
    // cookies, re-auth) — that is the common cause on a private library.
    const refreshed = this.opts.onAuthRefresh
      ? Promise.resolve().then(this.opts.onAuthRefresh).catch(() => { /* ignore */ })
      : Promise.resolve();
    refreshed.then(() => {
      if (myGen !== this.retryGen) return;       // superseded while refreshing
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryPending = false;
        if (myGen !== this.retryGen || !this.currentBook) return;
        // Only a still-errored element gets reloaded: if playback recovered
        // this timer is stale and a reload would audibly yank them backwards.
        if (!this.audio.error) return;
        this.loadChapter(this.resumePos.idx, this.resumePos.t, this.playIntent);
      }, delay);
    });
  };

  // --------------------------------------------------------- MediaSession

  private updateMediaSessionMetadata(): void {
    if (!('mediaSession' in navigator) || !this.currentBook) return;
    const ch = this.currentChapter();
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ch?.title || this.currentBook.title || '',
        artist: (this.currentBook as { artist?: string }).artist ?? '',
        album: this.currentBook.title ?? '',
      });
    } catch { /* MediaMetadata is absent on some browsers */ }
  }

  private updatePositionState = (): void => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const ch = this.currentChapter();
    if (!ch) return;
    const dur = this.chDur(ch) || 0;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: this.audio.playbackRate || 1,
        position: Math.max(0, Math.min(this.audio.currentTime || 0, dur)),
      });
    } catch { /* a position outside duration throws; not worth failing over */ }
  };

  private wireMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    };
    set('play', () => { this.audio.play().catch(() => { /* ignore */ }); });
    set('pause', () => { this.cancelScenePause(); this.audio.pause(); });
    set('previoustrack', () => this.prevChapter());
    set('nexttrack', () => this.nextChapter());
    set('seekbackward', (d) => this.skip(-(d?.seekOffset ?? 30)));
    set('seekforward', (d) => this.skip(d?.seekOffset ?? 30));
    set('seekto', (d) => {
      if (d?.seekTime == null) return;
      try { this.audio.currentTime = d.seekTime; } catch { /* ignore */ }
      this.updatePositionState();
    });
  }

  // ------------------------------------------------------------- prefetch

  private maybePrefetchNext = (): void => {
    if (!this.currentBook || this.currentBookIdx === null) return;
    const ch = this.currentChapter();
    if (!ch) return;
    const key = prefetchKey(this.currentBookIdx, this.currentChapterIdx + 1, this.summaryMode);
    const go = shouldPrefetch({
      paused: this.audio.paused,
      chapterIdx: this.currentChapterIdx,
      chapterCount: this.currentBook.chapters.length,
      chapterDuration: this.chDur(ch),
      currentTime: this.audio.currentTime || 0,
      key,
      lastKey: this.prefetchedKey,
    });
    if (!go) return;
    this.prefetchedKey = key;
    try {
      // The body is drained on purpose: an unread Response can be aborted on
      // GC, and without a service worker it is the HTTP cache (fed by the
      // completed transfer) that makes the boundary instant.
      fetch(this.audioUrlFor(this.currentBook.chapters[this.currentChapterIdx + 1]))
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => { /* prefetch is best-effort by definition */ });
    } catch { /* ignore */ }
  };

  // ---------------------------------------------------------- scene pause

  private cancelScenePause(): void {
    if (this.scenePauseTimer !== null) { clearTimeout(this.scenePauseTimer); this.scenePauseTimer = null; }
    this.scenePauseHolding = false;
  }

  private checkSceneBreakPause(ch: Chapter, t: number): void {
    const lastT = this.lastTickTime;
    const lastCh = this.lastTickChapterId;
    this.lastTickTime = t;
    this.lastTickChapterId = ch.id;
    if (this.scenePauseTimer !== null || this.audio.paused) return;
    const ct = chapterTranscript(bookTranscript(this.transcriptData, this.currentBook!), ch);
    if (!ct) return;
    const crossed = crossedSceneBreak({
      chunks: chunksFor(ct, this.summaryMode),
      from: lastT,
      to: t,
      chapterChanged: ch.id !== lastCh,
    });
    if (!crossed) return;
    this.scenePauseHolding = true;
    this.audio.pause();
    this.scenePauseTimer = setTimeout(() => {
      this.scenePauseTimer = null;
      this.scenePauseHolding = false;
      if (this.currentBook && this.audio.paused) this.audio.play().catch(() => { /* ignore */ });
    }, this.opts.scenePauseMs ?? SCENE_PAUSE_MS);
  }

  // ------------------------------------------------------------ transport

  togglePlay = (): void => {
    if (this.audio.paused) {
      this.audio.play().catch(() => { /* ignore */ });
    } else {
      // An explicit pause must stick: the scene-hold resume timer would
      // otherwise fire moments later and override the user.
      this.cancelScenePause();
      this.audio.pause();
    }
  };

  skip = (s: number): void => { this.seekToBookTime(this.bookTime() + s, !this.audio.paused); };

  prevChapter = (): void => {
    if (!this.currentBook) return;
    this.setFollow(true, false);
    if (this.currentChapterIdx === 0) {
      try { this.audio.currentTime = 0; } catch { /* ignore */ }
      return;
    }
    this.loadChapter(this.currentChapterIdx - 1, 0, !this.audio.paused);
  };

  nextChapter = (): void => {
    if (!this.currentBook) return;
    if (this.currentChapterIdx >= this.currentBook.chapters.length - 1) return;
    this.setFollow(true, false);
    this.loadChapter(this.currentChapterIdx + 1, 0, !this.audio.paused);
  };

  private cycleSpeed = (): void => {
    this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
    this.audio.playbackRate = SPEEDS[this.speedIdx];
    const btn = this.refs.speedBtn.current;
    if (btn) btn.textContent = `${SPEEDS[this.speedIdx]}x`;
  };

  private onChapterEnded = (): void => {
    this.saveProgress();
    if (!this.currentBook) return;
    if (this.currentChapterIdx < this.currentBook.chapters.length - 1) {
      this.loadChapter(this.currentChapterIdx + 1, 0, true);
    }
  };

  // --------------------------------------------------------- document drags

  onDocumentMouseMove(e: MouseEvent): void {
    if (this.dividerDrag) this.dividerDrag.resize(e.clientX, e.clientY);
    if (this.scrubbing) this.handleScrubMove(e);
  }

  onDocumentMouseUp(): void {
    if (this.dividerDrag) {
      this.dividerDrag.el.classList.remove('dragging');
      this.dividerDrag = null;
    }
    if (this.scrubbing) this.handleScrubEnd();
  }

  private handleScrubMove(e: { clientX: number }): void {
    if (!this.scrubbing) return;
    this.didDrag = true;
    const rect = this.scrubbing.li.getBoundingClientRect();
    let pct = (e.clientX - rect.left) / rect.width;
    pct = Math.max(0, Math.min(1, pct));
    if (this.scrubbing.idx === this.currentChapterIdx) {
      try { this.audio.currentTime = pct * this.scrubbing.dur; } catch { /* ignore */ }
    }
  }

  private handleScrubEnd(): void {
    if (!this.scrubbing) return;
    this.setFollow(true, false);
    if (this.scrubbing.idx !== this.currentChapterIdx) {
      // Scrubbed within a chapter that is not loaded: treat it as a request for
      // that chapter rather than guessing an offset from a stale rect.
      this.loadChapter(this.scrubbing.idx, 0, true);
    }
    this.scrubbing.li.classList.remove('scrubbing');
    this.scrubbing = null;
  }

  // ---------------------------------------------------------------- prefs

  private setFollow(on: boolean, snap = true, persist = true): void {
    this.followTranscript = on;
    // Gesture paths pass persist:false — a stray swipe should disarm following
    // for this session, not disable it forever on every future visit.
    if (persist) this.store.setItem('rs-follow', on ? '1' : '0');
    this.refs.followBtn.current?.classList.toggle('on', on);
    if (on && snap) this.scrollToActiveChunk();
  }

  private setReadingMode(on: boolean): void {
    this.readingMode = on;
    this.store.setItem('rs-reading', on ? '1' : '0');
    this.refs.playerView.current?.classList.toggle('reading-mode', on);
    this.refs.readingBtn.current?.classList.toggle('on', on);
    if (this.followTranscript) this.scrollToActiveChunk();  // layout moved things
  }

  private applyTextSize(): void {
    const box = this.refs.transcriptChunks.current;
    if (!box) return;
    box.style.setProperty('--ts-scale', Math.pow(TS_RATIO, this.textSize).toFixed(4));
    const dec = this.refs.tsDec.current;
    const inc = this.refs.tsInc.current;
    if (dec) dec.disabled = this.textSize === TS_MIN;
    if (inc) inc.disabled = this.textSize === TS_MAX;
  }

  private stepTextSize(delta: number): void {
    const next = Math.max(TS_MIN, Math.min(TS_MAX, this.textSize + delta));
    if (next === this.textSize) return;
    this.textSize = next;
    this.store.setItem('rs-textsize-n', String(this.textSize));
    this.applyTextSize();
    if (this.followTranscript) this.scrollToActiveChunk();  // reflow moved the text
  }

  private setSummaryMode(on: boolean, force = false): void {
    if (on && !bookHasSummaries(this.currentBook)) on = false;
    const changed = on !== this.summaryMode;
    this.summaryMode = on;
    this.store.setItem('rs-summary', on ? '1' : '0');
    this.refs.modeFull.current?.classList.toggle('on', !on);
    this.refs.modeSummary.current?.classList.toggle('on', on);
    if (!this.currentBook || (!changed && !force)) return;
    // The two clocks do not map onto each other — restart the chapter.
    const wasPlaying = !this.audio.paused;
    this.lastFormattedTime = '';
    this.lastPlayState = null;
    this.lastActiveChunkId = null;
    this.lastActiveChapterId = null;
    this.renderChapters();
    this.renderTranscriptChunks(this.currentChapterIdx + 1);
    this.loadChapter(this.currentChapterIdx, 0, wasPlaying);
  }

  // -------------------------------------------------------------- library

  renderLibrary = (): void => {
    const host = this.refs.bookList.current;
    if (!host) return;
    render(
      Library({
        books: this.books as unknown as LibraryBook[],
        tree: this.opts.tree as TreeNode | undefined,
        formatTime,
        progressStatus: (i) => {
          const p = readProgress(this.store, i).progress;
          return p > 0.98 ? 'complete' : p > 0.01 ? 'in-progress' : '';
        },
        offlineState: this.offlineState,
        onOpen: (i) => this.openBook(i),
        onDownload: (i) => this.downloadForOffline(i),
        bookActions: this.opts.bookActions,
        openMenuFor: this.openMenuFor,
        onToggleMenu: (i) => { this.openMenuFor = i; this.renderLibrary(); },
      }),
      host,
    );
  };

  // ------------------------------------------------------------- chapters

  private renderChapters(): void {
    const list = this.refs.chapterList.current;
    const trackBar = this.refs.trackBar.current;
    if (!list || !this.currentBook || !trackBar) return;
    list.innerHTML = '';
    this.chapterLis = [];
    this.chapterProgs = [];
    this.chapterScrubs = [];
    trackBar.querySelectorAll('.chapter-mark').forEach((el) => el.remove());

    const total = this.bookDur();
    this.currentBook.chapters.forEach((ch, i) => {
      const dur = this.chDur(ch);
      const li = document.createElement('li');
      li.id = `ch-${i}`;
      li.setAttribute('data-ch', String(i + 1));

      const progressEl = document.createElement('div');
      progressEl.className = 'ch-progress';
      const scrubberEl = document.createElement('div');
      scrubberEl.className = 'ch-scrubber';
      li.append(progressEl, scrubberEl);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'ch-title';
      titleSpan.textContent = ch.title ?? '';
      const durSpan = document.createElement('span');
      durSpan.className = 'ch-duration';
      durSpan.textContent = formatTime(dur);
      li.append(titleSpan, durSpan);

      const beginScrub = () => {
        this.didDrag = false;
        li.classList.add('scrubbing');
        this.scrubbing = { li, idx: i, dur };
      };
      scrubberEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginScrub();
      });
      // Same control by touch. The chapter list scrolls, so this needs the long
      // press even more than the divider does.
      longPressDrag(scrubberEl, {
        start: beginScrub,
        move: (t) => this.handleScrubMove(t),
        end: () => this.handleScrubEnd(),
      });

      li.addEventListener('mousedown', (e) => {
        if (e.target === scrubberEl) return;
        this.didDrag = false;
      });
      li.addEventListener('click', (e) => {
        if (this.didDrag) return;
        if (e.target === scrubberEl) return;
        this.setFollow(true, false);
        this.loadChapter(i, 0, true);
      });

      list.appendChild(li);
      this.chapterLis.push(li);
      this.chapterProgs.push(progressEl);
      this.chapterScrubs.push(scrubberEl);

      if (i > 0 && total > 0) {
        const mark = document.createElement('div');
        mark.className = 'chapter-mark';
        mark.style.left = `${(this.chStart(ch) / total) * 100}%`;
        trackBar.appendChild(mark);
      }
    });
  }

  // ------------------------------------------------------------ transcript

  private renderTranscriptChunks(chapterIndex: number): void {
    const box = this.refs.transcriptChunks.current;
    if (!box || !this.currentBook) return;
    const bt = bookTranscript(this.transcriptData, this.currentBook);
    if (!bt) return;
    const ct = chapterTranscript(bt, { id: chapterIndex - 1 });
    box.innerHTML = '';
    if (!ct) return;

    for (const chunk of chunksFor(ct, this.summaryMode)) {
      const div = document.createElement('div');
      div.className = 'transcript-chunk' + (isSceneBreak(chunk) ? ' scene-break' : '');
      div.id = `tc-${chapterIndex}-${chunk.index}`;
      const span = document.createElement('span');
      span.className = 'chunk-text';
      span.textContent = chunk.text;
      div.appendChild(span);
      div.addEventListener('click', () => this.onChunkClick(chapterIndex - 1, chunk));
      box.appendChild(div);
    }
  }

  private onChunkClick(chapterIdx: number, chunk: Chunk): void {
    if (!this.currentBook?.chapters[chapterIdx]) return;
    this.setFollow(true, false);
    if (chapterIdx === this.currentChapterIdx) {
      try { this.audio.currentTime = chunk.start; } catch { /* ignore */ }
      this.audio.play().catch(() => { /* ignore */ });
    } else {
      this.loadChapter(chapterIdx, chunk.start, true);
    }
  }

  private scrollToActiveChunk(): void {
    const box = this.refs.transcriptChunks.current;
    if (!box) return;
    const el = box.querySelector('.transcript-chunk.active');
    if (!el) return;
    // Rect-based: offsetTop is offsetParent-relative (the box itself), so
    // `offsetTop - box.offsetTop` double-subtracted and parked the active chunk
    // below the fold.
    const er = el.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    markProgrammaticScroll(box);
    box.scrollTop += (er.top - br.top) - box.clientHeight / 3;
  }

  // ------------------------------------------------------------- the loop

  private tick = (): void => {
    requestAnimationFrame(this.tick);
    if (!this.currentBook) return;

    const bt = this.bookTime();
    const d = this.bookDur();

    if (!this.trackDrag) {
      const ft = formatTime(bt);
      if (ft !== this.lastFormattedTime) {
        this.lastFormattedTime = ft;
        const el = this.refs.currentTime.current;
        if (el) el.textContent = ft;
      }
      const prog = this.refs.progress.current;
      if (prog) prog.style.width = `${d > 0 ? (bt / d) * 100 : 0}%`;
    }

    const paused = this.audio.paused;
    if (paused !== this.lastPlayState) {
      this.lastPlayState = paused;
      const glyph = paused ? '&#9654;' : '&#9646;&#9646;';
      const play = this.refs.playBtn.current;
      const mini = this.refs.miniPlay.current;
      if (play) play.innerHTML = glyph;
      if (mini) mini.innerHTML = glyph;
      const total = this.refs.totalTime.current;
      if (total) total.textContent = formatTime(d);
    }

    const ch = this.currentChapter();
    if (!ch) return;

    this.checkSceneBreakPause(ch, this.audio.currentTime || 0);

    if (ch.id !== this.lastActiveChapterId) {
      if (this.lastActiveChapterId !== null && this.chapterLis[this.lastActiveChapterId]) {
        this.chapterLis[this.lastActiveChapterId].classList.remove('active');
        this.chapterProgs[this.lastActiveChapterId].style.width = '0%';
      }
      this.chapterLis[ch.id]?.classList.add('active');
      const title = this.refs.chapterTitle.current;
      if (title) title.textContent = ch.title ?? '';
      this.setReadingChapterLabel(ch);
      this.lastActiveChapterId = ch.id;
      this.lastActiveChunkId = null;
      this.userScrolledChapters = false;
      this.renderTranscriptChunks(ch.id + 1);
    }

    const pct = Math.max(0, Math.min(100, ((this.audio.currentTime || 0) / this.chDur(ch)) * 100));
    if (this.chapterProgs[ch.id]) this.chapterProgs[ch.id].style.width = `${pct}%`;
    if (this.chapterScrubs[ch.id]) this.chapterScrubs[ch.id].style.left = `calc(${pct}% - 6px)`;

    if (!this.userScrolledChapters) {
      const activeLi = this.chapterLis[ch.id];
      const chList = this.refs.chapterList.current;
      if (activeLi && chList) {
        const ar = activeLi.getBoundingClientRect();
        const lr = chList.getBoundingClientRect();
        if (ar.top < lr.top || ar.bottom > lr.bottom) {
          markProgrammaticScroll(chList);
          chList.scrollTop += (ar.top - lr.top) - chList.clientHeight / 3;
        }
      }
    }

    this.updateActiveChunk(ch);
  };

  private updateActiveChunk(ch: Chapter): void {
    const box = this.refs.transcriptChunks.current;
    if (!box) return;
    const ct = chapterTranscript(bookTranscript(this.transcriptData, this.currentBook!), ch);
    const chunk = findChunkAt(chunksFor(ct, this.summaryMode), this.audio.currentTime || 0);
    if (!chunk) return;
    if (chunk.index === this.lastActiveChunkId) return;
    if (this.lastActiveChunkId !== null) {
      box.querySelector(`#tc-${ch.id + 1}-${this.lastActiveChunkId}`)?.classList.remove('active');
    }
    const el = box.querySelector(`#tc-${ch.id + 1}-${chunk.index}`);
    if (el) {
      el.classList.add('active');
      if (this.followTranscript) this.scrollToActiveChunk();
    }
    this.lastActiveChunkId = chunk.index;
  }

  // --------------------------------------------------------------- offline

  private async checkOfflineStatus(book: Book): Promise<boolean> {
    if (!('caches' in window)) return false;
    try {
      const cache = await caches.open('audiobook-audio');
      // Probe the first and last chapter as a "fully cached" heuristic; a
      // rigorous check would iterate every chapter, which the badge does not
      // warrant.
      const probes = book.chapters.length
        ? [book.chapters[0], book.chapters[book.chapters.length - 1]]
        : [];
      const results = await Promise.all(probes.map(async (ch) => {
        const url = (this.opts.audioBaseUrl ?? 'audio/') + ch.filename;  // full track, mode-independent
        return (await cache.match(url)) ?? (await cache.match(new URL(url, location.href).href));
      }));
      return results.length > 0 && results.every(Boolean);
    } catch {
      return false;
    }
  }

  private async downloadForOffline(bookIdx: number): Promise<void> {
    const book = this.books[bookIdx];
    this.offlineState[bookIdx] = 'downloading';
    this.renderLibrary();

    let wakeLock: { release: () => void } | null = null;
    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    const cleanup = () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      wakeLock?.release();
    };

    // Shell failures are recorded rather than swallowed: audio caching can
    // succeed while transcripts.json 404s, and a "Downloaded ✓" on a shell
    // missing its transcripts looks, offline, exactly like a broken app.
    const shellFailures: string[] = [];
    const shell = ['./', 'player.css', 'player.js', 'feedback.js',
      'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
    if (this.opts.transcriptUrl) shell.push(this.opts.transcriptUrl);

    try {
      const cache = await caches.open('audiobook-audio');
      await Promise.all(shell.map(async (file) => {
        const abs = new URL(file, location.href).href;
        try {
          const r = await fetch(abs);
          if (!r.ok) { shellFailures.push(file); return; }
          await cache.put(abs, r);
        } catch { shellFailures.push(file); }
      }));

      for (const ch of book.chapters) {
        // Both tracks, mode-independent: offline must work in either mode.
        const files = [ch.filename, ch.summary?.filename].filter(Boolean) as string[];
        for (const file of files) {
          const abs = new URL((this.opts.audioBaseUrl ?? 'audio/') + file, location.href).href;
          if (await cache.match(abs)) continue;   // resume picks up cleanly
          const r = await fetch(abs);
          if (!r.ok) throw new Error(`fetch ${file} failed`);
          const blob = await r.blob();
          await cache.put(abs, new Response(blob, { headers: r.headers }));
        }
      }
      this.offlineState[bookIdx] = 'downloaded';
      if (shellFailures.length) {
        console.warn('offline shell incomplete:', shellFailures.join(', '));
      }
    } catch {
      this.offlineState[bookIdx] = undefined;
    } finally {
      cleanup();
      this.renderLibrary();
    }
  }

  // ------------------------------------------------------------------ nav

  openBook(idx: number, updateUrl = true): void {
    this.currentBook = this.books[idx];
    this.currentBookIdx = idx;
    this.lastActiveChapterId = null;
    this.lastActiveChunkId = null;
    this.lastFormattedTime = '';
    this.lastPlayState = null;
    if (updateUrl) this.setUrl(idx);

    const lib = this.refs.library.current;
    const view = this.refs.playerView.current;
    if (lib) lib.style.display = 'none';
    view?.classList.add('active');
    if (this.opts.embedded) view?.classList.add('player-embedded');

    const bookTitle = this.refs.bookTitle.current;
    if (bookTitle) bookTitle.textContent = this.currentBook.title ?? '';

    const hasSummaries = bookHasSummaries(this.currentBook);
    const toggle = this.refs.modeToggle.current;
    if (toggle) toggle.style.display = hasSummaries ? '' : 'none';
    const p = readProgress(this.store, idx);
    this.summaryMode = hasSummaries &&
      (p.summary !== undefined ? !!p.summary : this.store.getItem('rs-summary') === '1');
    this.refs.modeFull.current?.classList.toggle('on', !this.summaryMode);
    this.refs.modeSummary.current?.classList.toggle('on', this.summaryMode);

    this.renderChapters();
    const box = this.refs.transcriptChunks.current;
    if (box) box.innerHTML = '';

    const bt = Math.max(0, Math.min(p.bookTime || 0, this.bookDur()));
    const startIdx = findChapterIdxAt(this.currentBook, bt, this.summaryMode);
    this.loadChapter(startIdx, bt - this.chStart(this.currentBook.chapters[startIdx]), false);

    // Guarded: openBook runs per book and per host re-render, and each
    // unguarded call would stack another rAF loop forever.
    if (!this.playerLoopRunning) {
      this.playerLoopRunning = true;
      this.tick();
    }

    // Fetched last, deliberately. A multi-book site keeps each book's transcript
    // beside its audio, so it can only be requested once we know which book
    // opened — and it must come after the refs above are live, because a warm
    // cache resolves the fetch before them.
    const url = (this.currentBook as { transcriptUrl?: string }).transcriptUrl;
    if (url && this.loadedTranscriptUrl !== url) {
      this.loadedTranscriptUrl = url;
      this.loadTranscripts(url);
    } else {
      this.renderTranscriptChunks(this.currentChapterIdx + 1);
    }
  }

  showLibrary(updateUrl = true): void {
    this.saveProgress();
    this.audio.pause();
    this.currentBook = null;
    this.currentBookIdx = null;
    this.store.setItem('rs-last-book', '');
    if (updateUrl) this.setUrl(null);
    this.refs.playerView.current?.classList.remove('active');
    const lib = this.refs.library.current;
    if (lib) lib.style.display = 'block';
    this.renderLibrary();
  }

  private setUrl(idx: number | null): void {
    const target = hashForBook(this.books, idx);
    if (location.hash === target) return;
    history.pushState(null, '', target || location.pathname + location.search);
  }

  private applyUrlState = (): void => {
    const slug = slugFromHash(location.hash);
    if (slug) {
      const idx = bookIdxFromSlug(this.books, slug);
      if (idx >= 0) {
        if (idx !== this.currentBookIdx) this.openBook(idx, false);
        return;
      }
    }
    if (this.currentBook !== null) this.showLibrary(false);
  };

  private loadTranscripts(url: string | undefined): void {
    if (!url) return;
    fetch(url)
      .then((r) => r.json())
      .then((data: TranscriptData) => {
        this.transcriptData = data;
        // The data often arrives after the first chapter has rendered; the tick
        // loop has already marked it active and will not re-render it, so the
        // transcript would stay blank until the reader switched chapters.
        if (this.currentBook) this.renderTranscriptChunks(this.currentChapterIdx + 1);
      })
      .catch(() => { /* a site with no transcripts is a valid site */ });
  }

  // ----------------------------------------------------------------- wire

  start(): void {
    const r = this.refs;
    this.loadTranscripts(this.opts.transcriptUrl);

    r.backBtn.current?.addEventListener('click', () => this.showLibrary());
    r.back30.current?.addEventListener('click', () => this.skip(-30));
    r.fwd30.current?.addEventListener('click', () => this.skip(30));
    r.prevBtn.current?.addEventListener('click', this.prevChapter);
    r.nextBtn.current?.addEventListener('click', this.nextChapter);
    r.playBtn.current?.addEventListener('click', this.togglePlay);
    r.speedBtn.current?.addEventListener('click', this.cycleSpeed);
    r.miniPlay.current?.addEventListener('click', this.togglePlay);
    r.miniPrev.current?.addEventListener('click', this.prevChapter);
    r.miniNext.current?.addEventListener('click', this.nextChapter);
    r.tsDec.current?.addEventListener('click', () => this.stepTextSize(-1));
    r.tsInc.current?.addEventListener('click', () => this.stepTextSize(1));
    r.followBtn.current?.addEventListener('click', () => this.setFollow(!this.followTranscript));
    r.readingBtn.current?.addEventListener('click', () => this.setReadingMode(!this.readingMode));
    r.modeFull.current?.addEventListener('click', () => this.setSummaryMode(false));
    r.modeSummary.current?.addEventListener('click', () => this.setSummaryMode(true));

    r.followBtn.current?.classList.toggle('on', this.followTranscript);
    this.applyTextSize();
    if (this.readingMode) this.setReadingMode(true);

    this.wireTrackBar();
    this.wireDivider();
    this.wireScrollPanes();
    this.wireAudio();

    // Host re-inits replace the container; page-level wiring must happen once
    // or every re-render stacks another interval and another listener set.
    if (saveProgressTimer) clearInterval(saveProgressTimer);
    saveProgressTimer = setInterval(this.saveProgress, 5000);
    if (!pageWired) {
      pageWired = true;
      window.addEventListener('beforeunload', () => activeEngine?.saveProgress());
      // beforeunload does not fire on mobile tab discard; pagehide does.
      window.addEventListener('pagehide', () => activeEngine?.saveProgress());
      document.addEventListener('visibilitychange', () => activeEngine?.onVisibilityChange());
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* file:// has none */ });
    }

    this.renderLibrary();
    void this.refreshOfflineBadges();

    if (!urlWired) {
      urlWired = true;
      window.addEventListener('popstate', () => activeEngine?.applyUrlState());
    }

    const slug = slugFromHash(location.hash);
    const hashIdx = slug ? bookIdxFromSlug(this.books, slug) : -1;
    if (hashIdx >= 0) {
      this.openBook(hashIdx, false);
    } else if (this.opts.autoOpenLast !== false) {
      // Resuming is right on a cold load and wrong when a host has just routed
      // the reader to the library on purpose. Hosts that route for themselves
      // pass autoOpenLast:false; the stored position is left alone either way.
      const last = readLastBook(this.store);
      if (last !== null && last < this.books.length) this.openBook(last);
    }
  }

  /** Public so the visibility handler can reach it through activeEngine. */
  onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      this.saveProgress();
    } else if (this.currentBook && this.audio.error) {
      // Coming back to a dead element: retry immediately with a fresh cap —
      // whatever starved it (frozen page, lapsed cookies) has had its chance.
      this.resetRetries();
      this.handleAudioError();
    }
  }

  private async refreshOfflineBadges(): Promise<void> {
    const states = await Promise.all(this.books.map((b) => this.checkOfflineStatus(b)));
    let changed = false;
    states.forEach((cached, i) => {
      if (cached && this.offlineState[i] !== 'downloaded') {
        this.offlineState[i] = 'downloaded';
        changed = true;
      }
    });
    if (changed) this.renderLibrary();
  }

  private wireTrackBar(): void {
    const bar = this.refs.trackBar.current;
    if (!bar) return;
    const pctAt = (e: { clientX: number }) => {
      const rect = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    };
    bar.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.currentBook) return;
      this.trackDrag = { wasPlaying: !this.audio.paused };
      bar.classList.add('dragging');
      bar.setPointerCapture(e.pointerId);
      this.onTrackMove(pctAt(e));
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.trackDrag) this.onTrackMove(pctAt(e));
    });
    bar.addEventListener('pointerup', (e: PointerEvent) => {
      if (!this.trackDrag) return;
      const wasPlaying = this.trackDrag.wasPlaying;
      this.trackDrag = null;
      bar.classList.remove('dragging');
      this.seekToBookTime(pctAt(e) * this.bookDur(), wasPlaying);
    });
    bar.addEventListener('pointercancel', () => {
      this.trackDrag = null;
      bar.classList.remove('dragging');
    });
  }

  private onTrackMove(pct: number): void {
    if (!this.currentBook) return;
    // The active clock: in summary mode the bar spans the summary timeline, and
    // full-clock arithmetic here seeked past the end of it.
    const bt = pct * this.bookDur();
    const prog = this.refs.progress.current;
    const cur = this.refs.currentTime.current;
    if (prog) prog.style.width = `${pct * 100}%`;
    if (cur) cur.textContent = formatTime(bt);
    const idx = findChapterIdxAt(this.currentBook, bt, this.summaryMode);
    if (idx === this.currentChapterIdx) {
      try {
        this.audio.currentTime = bt - this.chStart(this.currentBook.chapters[idx]);
      } catch { /* ignore */ }
    }
  }

  private wireDivider(): void {
    const divider = this.refs.divider.current;
    const area = this.refs.contentArea.current;
    const chapterPanel = this.refs.chapterPanel.current;
    const transcriptPanel = this.refs.transcriptPanel.current;
    if (!divider || !area || !chapterPanel || !transcriptPanel) return;
    const resize = (x: number, y: number) => resizePanels(area, chapterPanel, transcriptPanel, x, y);

    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.dividerDrag = { resize, el: divider };
      divider.classList.add('dragging');
    });
    longPressDrag(divider, {
      start: () => { this.dividerDrag = { resize, el: divider }; divider.classList.add('dragging'); },
      move: (t) => resize(t.clientX, t.clientY),
      end: () => { this.dividerDrag = null; divider.classList.remove('dragging'); },
    });
  }

  private wireScrollPanes(): void {
    const chList = this.refs.chapterList.current;
    const pane = this.refs.transcriptChunks.current;
    if (!chList || !pane) return;

    // Scrollbars are hidden at rest; show while scrolling, hide after idle.
    for (const el of [chList, pane] as (HTMLElement & { _sbQuietUntil?: number })[]) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      el.addEventListener('scroll', () => {
        if (el._sbQuietUntil && Date.now() < el._sbQuietUntil) {
          // Still the programmatic smooth-scroll: slide the window so long
          // animations stay quiet end to end.
          el._sbQuietUntil = Date.now() + 200;
          return;
        }
        el.classList.add('scrolling');
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => el.classList.remove('scrolling'), 800);
      });
    }

    chList.addEventListener('wheel', () => { this.userScrolledChapters = true; });
    chList.addEventListener('touchmove', () => { this.userScrolledChapters = true; });
    chList.addEventListener('pointerdown', (e: PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (e.clientX > rect.right - 20) this.userScrolledChapters = true;
    });

    // Gesture disarms are session-only: a scroll is a glance away, not a setting.
    pane.addEventListener('wheel', () => {
      if (this.followTranscript) this.setFollow(false, true, false);
    });
    pane.addEventListener('pointerdown', (e: PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (e.clientX > rect.right - 20 && this.followTranscript) this.setFollow(false, true, false);
    });

    let sx = 0;
    let sy = 0;
    pane.addEventListener('touchstart', (e: TouchEvent) => {
      if (!e.touches.length) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    }, { passive: true });
    pane.addEventListener('touchmove', (e: TouchEvent) => {
      if (!this.followTranscript || !e.touches.length) return;
      if (exceededSlop(e.touches[0], sx, sy)) this.setFollow(false, true, false);
    }, { passive: true });
  }

  private wireAudio(): void {
    const a = this.audio;
    a.addEventListener('ended', this.onChapterEnded);
    a.addEventListener('error', this.handleAudioError);
    a.addEventListener('playing', this.resetRetries);
    a.addEventListener('play', () => { this.playIntent = true; });
    a.addEventListener('pause', () => {
      // Not on error, chapter end, or a scene hold: all three fire 'pause'
      // without the listener asking for silence, and recovery must play through.
      if (!a.error && !a.ended && !this.scenePauseHolding) this.playIntent = false;
    });
    let lastPositionStateAt = 0;
    a.addEventListener('timeupdate', () => {
      if (!a.error && (a.currentTime || 0) > 0) {
        this.resumePos = { idx: this.currentChapterIdx, t: a.currentTime };
      }
      this.maybePrefetchNext();
      // Keep the lock-screen scrubber moving, at ~1Hz rather than per event.
      const now = Date.now();
      if (now - lastPositionStateAt > 1000) {
        lastPositionStateAt = now;
        this.updatePositionState();
      }
    });
    a.addEventListener('loadedmetadata', this.updatePositionState);
    a.addEventListener('seeked', this.updatePositionState);
    a.addEventListener('ratechange', this.updatePositionState);
    this.wireMediaSession();
  }
}
