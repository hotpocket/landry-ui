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
  STALL_TIMEOUT_MS, shouldRecoverFromStall,
} from '../core/playback-policy.ts';
import { appendDiag, type DiagEntry } from '../core/diagnostics.ts';
import { longPressDrag, resizePanels, markProgrammaticScroll, exceededSlop } from './gestures.ts';
import { TranscriptLoader, wireSearch } from './search-ui.ts';
import { isRecent } from '../core/recency.ts';
import { withMediaQuery, secondsUntilExpiry, withCacheBust } from '../core/media-url.ts';

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
  /** slug → transcript, shared between playback and search so a transcript is
   *  never fetched twice or held in two shapes. */
  private transcriptsBySlug: Record<string, import('../core/transcript.ts').BookTranscript | undefined> = {};
  private loader: TranscriptLoader | null = null;
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

  // A PERSON asked for silence, as opposed to the element falling silent. Every
  // recovery path has to consult this: playIntent deliberately survives an
  // error-induced pause so recovery can play through it, and that same
  // stickiness restarted books their listener had stopped — the pending retry,
  // the retry on returning to visibility, and a pendingPlayAfterLoad landing
  // after the tap all did it. Only the transport and the lock-screen controls
  // set this; nothing about the element's own state can.
  private userPaused = false;

  // The watchdog for a failure that fires no event at all: a request that hangs
  // means no loadedmetadata, no playing, no error, and (before this) nobody
  // watching. Armed on a load that wants to play and on 'waiting'.
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private stallArmedAt = 0;
  private stallRecoveries = 0;
  private stallNonce = 0;

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

  private offlineState: Record<number, 'downloading' | 'downloaded' | 'error' | undefined> = {};
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

    // A host that re-renders constructs another engine into the same container.
    // The page-level wiring is guarded in start(), but the element and the
    // animation loop live on the INSTANCE, so an undisposed predecessor keeps a
    // rAF loop running over detached DOM and an <audio> element that can go on
    // playing underneath the new one. Vanilla never had this: it was one IIFE
    // with one element, and re-init was free.
    activeEngine?.dispose();

    this.audio = document.createElement('audio');
    this.audio.preload = 'metadata';
    opts.container.appendChild(this.audio);
    activeEngine = this;
  }

  /**
   * Give up everything this engine owns that outlives its DOM. Called only when
   * a successor replaces it — there is no restart from here.
   */
  private dispose(): void {
    this.disposed = true;          // stops the rAF loop at its next frame
    this.cancelStallWatch();
    // The scene-break hold is a pending setTimeout whose callback calls
    // audio.play(). Unsourcing below already makes that call reject harmlessly,
    // so this closes no visible hole — it stops a disposed engine holding a
    // live timer, and stops the unsourcing from being the only thing standing
    // between a scene hold and an orphan that resumes itself.
    this.cancelScenePause();
    try {
      this.audio.pause();
      // Not just pause: an element left with a src goes on buffering, which on
      // a metered connection is the part nobody sees.
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch { /* a detached element can refuse both; it is going away anyway */ }
    this.audio.remove();
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
    // Appended after the filename, not onto the base: a query on the base would
    // address a different object entirely.
    return withMediaQuery((this.opts.audioBaseUrl ?? 'audio/') + file, this.mediaQuery());
  }

  /** The signature for the open book, if the host supplied one. */
  private mediaQuery(): string {
    return (this.currentBook as { media_query?: string } | null)?.media_query ?? '';
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

  /**
   * `bust` forces a URL the network stack has not seen. Only the stall path
   * passes it, and only because reloading the identical URL while its request
   * hangs is coalesced onto the hung request — see `withCacheBust`.
   */
  private loadChapter(idx: number, timeInChapter: number, autoplay: boolean, bust = false): void {
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
    this.audio.src = withCacheBust(this.audioUrlFor(ch), bust ? ++this.stallNonce : 0);
    this.audio.load();

    // A load that means to play is watched: if the request hangs there is no
    // error, no metadata and no 'waiting' — the element never starts, so this is
    // the only place a stalled chapter boundary can be noticed.
    if (autoplay) this.armStallWatch();

    const t = Math.max(0, timeInChapter || 0);
    const onMeta = () => {
      this.audio.removeEventListener('loadedmetadata', onMeta);
      if (myGen !== this.loadGen) return;   // a newer loadChapter superseded this
      try { this.audio.currentTime = Math.min(t, this.audio.duration || t); } catch { /* ignore */ }
      if (this.pendingPlayAfterLoad) {
        this.pendingPlayAfterLoad = false;
        // A slow chapter is exactly when someone gives up and taps pause; the
        // bytes then arrived and played over them.
        if (!this.userPaused) this.audio.play().catch(() => { /* autoplay refusal is not an error */ });
      }
    };
    this.audio.addEventListener('loadedmetadata', onMeta);
  }

  /**
   * A gesture that asks for a specific place in the book, and for sound.
   *
   * Clearing `userPaused` here is load-bearing: it is the flag every recovery
   * path checks, so a chapter started by tapping the list or a transcript line
   * while the book was paused would otherwise play with "the listener wants
   * silence" still set — and the first stall or 403 after it would refuse to
   * recover, silently.
   */
  private playChapterFrom(idx: number, timeInChapter: number): void {
    this.userPaused = false;
    this.loadChapter(idx, timeInChapter, true);
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

  /**
   * Whether recovery should end up playing. `playIntent` says the element was
   * trying; `userPaused` says a person overruled it. Recovery must play through
   * an error-induced pause and must never play through a deliberate one.
   *
   * The `userPaused` term is a deliberate last line of defence rather than the
   * primary one — a stopped book is refused earlier, at the points that schedule
   * work (handleAudioError, armStallWatch, shouldRecoverFromStall). It is kept
   * because every future caller of loadChapter-with-autoplay reaches it, and
   * this is the exact defect that shipped: a recovery that played over the
   * listener.
   */
  private recoveryShouldPlay(): boolean {
    return this.playIntent && !this.userPaused;
  }

  private handleAudioError = (): void => {
    this.cancelStallWatch();     // an error is not a stall; this path owns it now
    this.diag('error', {
      code: this.audio.error?.code ?? null,
      network: this.audio.networkState,
      ready: this.audio.readyState,
    });
    if (this.userPaused) return; // stopped by hand: heal nothing, retry nothing
    if (!this.currentBook || this.retryPending) return;
    if (!shouldRetry(this.retryCount)) { this.diag('gave-up', {}); return; }   // capped: no infinite spin offline
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
        this.diag('retry', { attempt: this.retryCount, ch: this.resumePos.idx + 1 });
        this.loadChapter(this.resumePos.idx, this.resumePos.t, this.recoveryShouldPlay());
      }, delay);
    });
  };

  // ------------------------------------------------------------ stall watchdog

  private cancelStallWatch(): void {
    if (this.stallTimer !== null) { clearTimeout(this.stallTimer); this.stallTimer = null; }
  }

  /**
   * Watch for silence that reports nothing. Called when a load is asked to play
   * and when the element says it is waiting for data; either way, if the clock
   * has not moved by the timeout and the element still holds nothing, the
   * chapter is reloaded.
   *
   * Re-arming is idempotent by intent: the newest arm wins, so a burst of
   * 'waiting' events is one watch, not one per event.
   */
  private armStallWatch(): void {
    this.cancelStallWatch();
    this.stallArmedAt = this.audio.currentTime || 0;
    this.stallTimer = setTimeout(this.onStallTimeout, this.opts.stallTimeoutMs ?? STALL_TIMEOUT_MS);
  }

  private onStallTimeout = (): void => {
    this.stallTimer = null;
    if (!this.currentBook) return;
    const advanced = (this.audio.currentTime || 0) > this.stallArmedAt + 0.05;
    if (!shouldRecoverFromStall({
      playIntent: this.playIntent,
      userPaused: this.userPaused,
      scenePauseHolding: this.scenePauseHolding,
      ended: this.audio.ended,
      advanced,
      canPlayThrough: this.audio.readyState >= 3,   // HAVE_FUTURE_DATA
    })) return;
    // Capped like the retries, and for the same reason: a phone with no network
    // must give up rather than reload forever. Reset by any real progress.
    if (!shouldRetry(this.stallRecoveries)) { this.diag('gave-up', { after: 'stall' }); return; }
    this.stallRecoveries++;
    this.diag('stall', {
      ch: this.resumePos.idx + 1,
      network: this.audio.networkState,
      ready: this.audio.readyState,
    });
    // A stall leaves no error to clear, so the retry cap for errors is untouched
    // here; this reload is the stall's own attempt. Busted, because the request
    // it is replacing is still open and would otherwise swallow it.
    this.loadChapter(this.resumePos.idx, this.resumePos.t, this.recoveryShouldPlay(), true);
  };

  // ------------------------------------------------------------- diagnostics

  /**
   * One line of evidence. A phone with its screen off has no console and its
   * listener is not at the machine, so a failure that records nothing can only
   * be guessed at — which is how a 15-minute media signature went a day
   * undiagnosed, presenting as "it stutters with the screen off".
   *
   * `sigExpiresIn` is the field that would have answered it: seconds of life
   * left in the signature at the moment of failure, negative once expired. The
   * signature itself is never written down.
   */
  private diag(ev: string, extra: Record<string, unknown>): void {
    const entry: DiagEntry = {
      at: new Date().toISOString(),
      ev,
      ch: this.currentChapterIdx + 1,
      pos: Math.round(this.audio.currentTime || 0),
      sigExpiresIn: secondsUntilExpiry(this.mediaQuery(), Date.now()),
      visible: typeof document !== 'undefined' ? document.visibilityState : null,
      ...extra,
    };
    try {
      this.store.setItem('rs-diag', appendDiag(this.store.getItem('rs-diag'), entry));
    } catch { /* storage full or blocked: diagnostics never break playback */ }
  }

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
    // The lock screen is the only control a listener with the screen off has,
    // so these must be the same acts as the on-screen transport — not a bare
    // play()/pause() that leaves the recovery machinery running behind them.
    set('play', () => this.startPlayback());
    set('pause', () => this.stopPlayback());
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

  /**
   * What the transport control means right now — true when a tap should stop
   * things. NOT `!audio.paused`: an element that is retrying a failed chapter,
   * or waiting on a load that hangs, is silent while fully intending to play,
   * and a button labelled "play" there both lies and gives the listener no way
   * to call it off.
   *
   * The scene-break hold is excluded on purpose. It is brief and already yields
   * to a tap as "resume now", which is what `scene-pause` asserts.
   */
  private intendsPlayback(): boolean {
    if (!this.audio.paused) return true;
    if (this.scenePauseHolding) return false;
    return this.playIntent && !this.userPaused;
  }

  /** The listener asked for sound. */
  private startPlayback(): void {
    this.userPaused = false;
    // A fresh cap: asking again is not the same as the attempt that gave up.
    this.resetRetries();
    this.audio.play().catch(() => { /* autoplay refusal is not an error */ });
  }

  /**
   * The listener asked for silence, and everything that might override it is
   * called off — the scene-hold resume timer, a pending retry, a pending
   * autoplay-on-load, and the stall watchdog.
   */
  private stopPlayback(): void {
    // ONE authority. This deliberately does not also clear `playIntent` or
    // `pendingPlayAfterLoad`: those record what the ELEMENT was doing, they are
    // set from element events and load bookkeeping, and keeping a third copy of
    // "the listener wants silence" in sync with them is how the original bug
    // happened. Every path that could resume consults `userPaused` instead.
    this.userPaused = true;
    this.cancelScenePause();
    this.resetRetries();     // scheduled work is cancelled, not merely ignored
    this.audio.pause();
  }

  togglePlay = (): void => {
    if (this.intendsPlayback()) this.stopPlayback();
    else this.startPlayback();
  };

  skip = (s: number): void => { this.seekToBookTime(this.bookTime() + s, this.intendsPlayback()); };

  prevChapter = (): void => {
    if (!this.currentBook) return;
    this.setFollow(true, false);
    if (this.currentChapterIdx === 0) {
      try { this.audio.currentTime = 0; } catch { /* ignore */ }
      return;
    }
    this.loadChapter(this.currentChapterIdx - 1, 0, this.intendsPlayback());
  };

  nextChapter = (): void => {
    if (!this.currentBook) return;
    if (this.currentChapterIdx >= this.currentBook.chapters.length - 1) return;
    this.setFollow(true, false);
    this.loadChapter(this.currentChapterIdx + 1, 0, this.intendsPlayback());
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
      // Not unconditionally true: 'ended' can arrive after a pause the listener
      // took near the end of a chapter, and autoplaying the next one there
      // restarts a book they stopped.
      this.loadChapter(this.currentChapterIdx + 1, 0, !this.userPaused);
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
      this.playChapterFrom(this.scrubbing.idx, 0);
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
    const wasPlaying = this.intendsPlayback();
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

      // wbt lands chapters a couple at a time on an hourly sync, so "what
      // arrived since I last looked" is the most useful thing this list can
      // say. Absent for books with no date_added — which is every book
      // published before chatterbook recorded one, and they must not all light
      // up at once.
      if (isRecent((ch as { date_added?: string }).date_added)) {
        const badge = document.createElement('span');
        badge.className = 'ch-new';
        badge.textContent = 'new';
        badge.title = `Added ${(ch as { date_added?: string }).date_added}`;
        li.insertBefore(badge, durSpan);
      }

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
        this.playChapterFrom(i, 0);
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
      this.startPlayback();
    } else {
      this.playChapterFrom(chapterIdx, chunk.start);
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
    // Before the re-schedule, not after: a disposed engine must stop asking for
    // frames, not merely stop doing work in them.
    if (this.disposed) return;
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

    // Intent, not element state: a chapter being retried or waited on is silent
    // while still trying to play, and a "play" glyph there offers to start what
    // is already starting and hides the only way to call it off.
    const paused = !this.intendsPlayback();
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
    // Same number, second consumer: the reading-mode hairline. Painted here
    // rather than in its own pass so it can never disagree with the chapter
    // list about where playback is.
    const rp = this.refs.readingProgressFill.current;
    if (rp) rp.style.width = `${pct}%`;
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
        // Unsigned on purpose: the cache is keyed without the signature (see
        // sw.js), so a probe must not carry one either or it would never match.
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
          // Fetch WITH the signature, store WITHOUT it: the bytes are the same
          // object however they were authorized, so a later signature still
          // finds them and an expired one never re-downloads 141 hours.
          const r = await fetch(withMediaQuery(abs, this.mediaQuery()));
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
      // 'error', not undefined: resetting to idle made a failure look like the
      // click never happened — on a phone (expired signature, dropped radio)
      // the only evidence was a console nobody can open. The error state keeps
      // the button clickable, so the retry is the same tap.
      this.offlineState[bookIdx] = 'error';
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
        for (const b of data?.books ?? []) this.transcriptsBySlug[b.slug] = b;
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
    this.wireSearchUi();

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

  private wireSearchUi(): void {
    const input = this.refs.searchInput.current;
    const results = this.refs.searchResults.current;
    const spinner = this.refs.searchSpinner.current;
    const bookList = this.refs.bookList.current;
    if (!input || !results || !spinner || !bookList) return;

    this.loader = new TranscriptLoader({
      urlFor: (slug) => {
        const b = this.books.find((x) => bookSlug(x) === slug || x.slug === slug) as
          { transcriptUrl?: string } | undefined;
        // A per-book URL when the host provides one, else the single library
        // transcript — which, once fetched, satisfies every book at once.
        return b?.transcriptUrl ?? this.opts.transcriptUrl;
      },
      loaded: this.transcriptsBySlug,
    }, () => { /* replaced by wireSearch */ });

    wireSearch({
      input,
      results,
      spinner,
      bookList,
      books: this.books as { slug?: string; title?: string }[],
      loaded: this.transcriptsBySlug,
      summaryFor: () => {
        // Only the open book has a mode; the rest are searched as full text,
        // which is what a reader coming to them fresh would see.
        const map: Record<string, boolean> = {};
        if (this.currentBook) map[bookSlug(this.currentBook)] = this.summaryMode;
        return map;
      },
      loader: this.loader,
      formatTime,
      goTo: (slug, chapterIndex, start) => {
        const idx = bookIdxFromSlug(this.books, slug);
        if (idx < 0) return;
        if (idx !== this.currentBookIdx) this.openBook(idx);
        // Audio is only touched HERE — search itself never fetches a chapter.
        this.loadChapter(chapterIndex - 1, start, false);
      },
    });
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
    } else if (this.currentBook && this.recoveryShouldPlay() && this.audio.paused) {
      // The same fresh cap for the stall path, which the branch above cannot
      // reach: a request that hangs sets no MediaError, so a book whose stall
      // budget was spent against a dead network would stay silent forever —
      // `stallRecoveries` is otherwise cleared only by a `playing` event, and
      // there is no playing event to wait for. Re-arm rather than reload: the
      // watchdog re-checks whether it is really stalled before touching it.
      this.stallRecoveries = 0;
      this.armStallWatch();
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
      // Intent, not element state: dragging the bar during a recovery must
      // resume where it lands, not silently demote the book to paused.
      this.trackDrag = { wasPlaying: this.intendsPlayback() };
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
    a.addEventListener('playing', () => {
      this.resetRetries();
      // Real progress clears the stall history: the next hang gets a full cap.
      this.cancelStallWatch();
      this.stallRecoveries = 0;
    });
    // The element says it has run out of data. Nothing else follows on a phone
    // whose request hangs — no error, no timeout, no second event.
    a.addEventListener('waiting', () => this.armStallWatch());
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
