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
import type { PlayerOptions, ChapterAction, ChapterActionContext } from '../index.tsx';
import {
  type Book, type Chapter,
  chapterStart, chapterDuration, bookDuration, findChapterIdxAt, bookHasSummaries,
  nonPositionalChapterId,
} from '../core/clock.ts';
import {
  bookSlug, bookIdxFromSlug, hashForBook, hashForChapter, routeFromHash, collidingSlugs,
} from '../core/routing.ts';
import { readProgress, writeProgress, readLastBook, type KeyValueStore } from '../core/progress.ts';
import {
  bookTranscript, chapterTranscript, chunksFor, findChunkAt, shortDate,
  type TranscriptData, type Chunk, type ChapterTranscript,
} from '../core/transcript.ts';
import { isSceneBreak, crossedSceneBreak } from '../core/scene.ts';
import {
  shouldRetry, retryDelayMs, prefetchKey, shouldPrefetch,
  STALL_TIMEOUT_MS, shouldRecoverFromStall,
} from '../core/playback-policy.ts';
import { appendDiag, type DiagEntry } from '../core/diagnostics.ts';
import { longPress, longPressDrag, resizePanels, markProgrammaticScroll, exceededSlop } from './gestures.ts';
import { TranscriptLoader, wireSearch } from './search-ui.ts';
import { isRecent } from '../core/recency.ts';
import { withMediaQuery, secondsUntilExpiry, withCacheBust, withContentVersion,
  AUDIO_MANIFEST_MESSAGE } from '../core/media-url.ts';

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
  document.addEventListener('keydown', (e) => activeEngine?.onKeyDown(e));
}

/**
 * Controls the browser operates on its own when Space is pressed on them.
 * A global handler that fires here as well toggles twice, which reads as the
 * key doing nothing — and it is the state the reporter was already in, since
 * Space "worked" only while the transport had focus.
 *
 * Editable targets are the other half, and the worse one: a space typed into
 * the search box that pauses the book instead of typing a space is a bigger
 * bug than the one this fixes.
 */
const SPACE_BELONGS_TO =
  'input, textarea, select, button, a[href], summary, [role="button"], '
  + '[contenteditable=""], [contenteditable="true"]';

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

  /** Which chapter row has its menu open, and the teardown that closes it. */
  private chapterMenuFor: number | null = null;
  private chapterMenuEl: HTMLElement | null = null;
  private closeChapterMenuOutside: (() => void) | null = null;
  /**
   * A hold ends in a touchend, and the browser follows it with a click on the
   * same row — which is the gesture that plays a chapter. One flag, consumed by
   * the next click, is the whole of "the menu did not also start playback".
   */
  private suppressChapterClick = false;

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
    // Document-level listeners outlive this engine's DOM by construction; a
    // successor with its own menu would otherwise be closed by the dead one's.
    this.closeChapterMenu(false);
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

  /**
   * The tracks a chapter has, as (file, content hash) pairs.
   *
   * One place that knows a track is a filename AND the hash of what that
   * filename holds. Three call sites need the pairing — playback, the offline
   * download, and the probe that decides whether the book reports itself
   * downloaded — and when they disagree the badge reports on an object nobody
   * will ever fetch.
   */
  private tracksOf(ch: Chapter, mode: 'active' | 'all'): { file: string; hash?: string }[] {
    const full = { file: ch.filename ?? '', hash: ch.content_hash };
    const summary = ch.summary?.filename
      ? { file: ch.summary.filename, hash: ch.summary.content_hash }
      : null;
    if (mode === 'all') return summary ? [full, summary] : [full];
    return [this.summaryMode && summary ? summary : full];
  }

  /**
   * The URL a chapter's bytes are CACHED under: no signature, and versioned.
   *
   * This is the cache key, in the sense sw.js means it — the worker strips the
   * signature parameters (and `rsr`) and keeps everything else, so this string
   * is what an offline download is stored under and what a "have I got this?"
   * probe has to ask for. The version is part of the key on purpose: a chapter
   * re-rendered from corrected text must not be answerable by the copy of the
   * previous render sitting in a reader's PWA.
   */
  private audioCacheUrl(track: { file: string; hash?: string }): string {
    return withContentVersion((this.opts.audioBaseUrl ?? 'audio/') + track.file, track.hash);
  }

  private audioUrlFor(ch: Chapter): string {
    // Appended after the filename, not onto the base: a query on the base would
    // address a different object entirely.
    return withMediaQuery(this.audioCacheUrl(this.tracksOf(ch, 'active')[0]),
                          this.mediaQuery());
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

  /**
   * The "Original Source" link beside the Transcript heading.
   *
   * Presence of `source_url` is the whole condition. Books transcribed from
   * something public (a YouTube episode, a talk) carry it per chapter; books of
   * original prose carry nothing and get no link. Driven from the transcript
   * rather than the manifest because the panel it sits in is the transcript's,
   * and it must change with the chapter the panel is showing.
   */
  private setSourceLink(ct: ChapterTranscript | null): void {
    const el = this.refs.sourceLink.current;
    if (!el) return;
    const url = ct?.source_url;
    const exact = shortDate(ct?.source_date);
    // '~' only ever precedes a date that exists; an empty stamp stays empty
    // rather than becoming a lone tilde.
    const stamp = exact && ct?.source_date_estimated ? `~${exact}` : exact;
    // Both, or nothing. The date is the label now, so a source whose date
    // nobody recorded has no text to click and must not render an empty
    // anchor — and a date with no url is not a link at all.
    if (url && stamp) {
      el.href = url;
      el.textContent = stamp;
      el.style.display = '';
    } else {
      el.removeAttribute('href');
      el.textContent = '';
      el.style.display = 'none';
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
    // …and the watchdog is scheduled work too. It already declines while
    // `userPaused` is set — shouldRecoverFromStall reads it, and
    // playback-recovery case D asserts no reload storm behind a stopped book —
    // so this changes no behaviour and gets no test of its own: removing it
    // cannot make anything go red. It is here because the line above claims it.
    this.cancelStallWatch();
    this.audio.pause();
  }

  togglePlay = (): void => {
    if (this.intendsPlayback()) this.stopPlayback();
    else this.startPlayback();
  };

  /**
   * Space plays and pauses, from anywhere on the page.
   *
   * Reported from books.landry.bot as "space works, but only after clicking
   * pause". That was never a shortcut: it was the browser activating a focused
   * button, so the key worked exactly while focus happened to sit on the
   * transport. A listener reading the transcript had nothing.
   *
   * Public because the document-level listener reaches it through
   * `activeEngine` — one listener for the page, whichever engine is current,
   * the same shape as the drag handlers above.
   */
  onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    // A held key repeats. One press is one toggle.
    if (e.repeat) return;
    // Chords belong to the browser and the OS.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // The library is not the player. Space on a focused book row opens that
    // book, which is book-menu's case I, and there is nothing to toggle until
    // one is open.
    if (!this.currentBook) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el && el.closest(SPACE_BELONGS_TO)) return;
    // Otherwise Space scrolls the page.
    e.preventDefault();
    this.togglePlay();
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
    // The rows are about to be destroyed and the menu lives inside one of them.
    // Closing it first is what detaches its document-level listeners; dropping
    // the node alone would leave them firing into nothing forever.
    this.closeChapterMenu(false);
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
      const play = () => {
        this.setFollow(true, false);
        this.playChapterFrom(i, 0);
      };
      li.addEventListener('click', (e) => {
        if (this.didDrag) return;
        if (e.target === scrubberEl) return;
        // The click a hold leaves behind. Consumed rather than tested for,
        // because it arrives exactly once and only after a hold.
        if (this.suppressChapterClick) { this.suppressChapterClick = false; return; }
        if (this.chapterMenuFor !== null && (e.target as Element)?.closest?.('.ch-menu-items')) return;
        play();
      });
      // The row has been the primary control of an open book since the player
      // existed, on a bare <li>: no role, no focus, no keys. The buttons around
      // it are real buttons, which is why tabbing through a book looked like it
      // worked. role+tabIndex rather than a <button> for the same reason as the
      // library row — a button resets the typography of what it contains.
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      // Moving to a row IS moving the list. The tick loop scrolls the playing
      // chapter back into view on every frame until the reader has scrolled it
      // themselves, and "themselves" meant wheel, touch-drag or the scrollbar —
      // none of which a keyboard uses. Making these rows focusable added a
      // fourth way to move the list, and without this the loop takes it
      // straight back, inside a frame.
      li.addEventListener('focus', () => { this.userScrolledChapters = true; });
      li.setAttribute('aria-label', `Chapter ${i + 1}: ${ch.title ?? ''}`);
      if (this.chapterMenuSize()) li.setAttribute('aria-haspopup', 'menu');
      li.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // Space scrolls the pane by default, which is the wrong answer for
          // something announced as a button.
          e.preventDefault();
          play();
          return;
        }
        // The keyboard's own context gesture. Chromium and Firefox synthesise a
        // contextmenu event from these; Safari does not, and a reader with no
        // mouse and no touchscreen would otherwise have no way in at all.
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          if (!this.chapterMenuSize()) return;
          e.preventDefault();
          this.openChapterMenu(i, li, true);
        }
      });
      // Right-click, and the keyboard gesture where the browser synthesises one.
      // preventDefault ONLY when there is something to show: taking the
      // browser's menu away and offering nothing is worse than leaving it.
      li.addEventListener('contextmenu', (e: MouseEvent) => {
        if (!this.chapterMenuSize()) return;
        e.preventDefault();
        this.openChapterMenu(i, li, false);
      });
      // The same gesture by touch. A hold that begins on the scrubber is a
      // seek — that control had the hold first, and it keeps it.
      longPress(li, () => {
        if (!this.chapterMenuSize()) return;
        this.suppressChapterClick = true;
        this.openChapterMenu(i, li, false);
      }, (target) => target === scrubberEl || !!(target as Element)?.closest?.('.ch-scrubber'));

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

  // -------------------------------------------------------- chapter menu

  private chapterActions(): ChapterAction[] {
    return this.opts.chapterActions ?? [];
  }

  /**
   * Whether this browser has a Cache Storage to download into or flush.
   *
   * Both of the player's own menu items are about that store, so where there
   * is none they are hidden rather than offered and failed — a file:// bundle
   * has none, and neither does iOS Safari with "Block All Cookies", which
   * throws SecurityError from the GETTER. Hence the try around what looks like
   * a plain truthiness test: `!!window.caches` is the throw, not a guard
   * against it.
   */
  private canCache(): boolean {
    try { return !!window.caches; } catch { return false; }
  }

  /**
   * How many items the menu would have. Zero means the row does NOT claim the
   * context gesture: taking the browser's own menu away and offering nothing
   * in its place is strictly worse than leaving it.
   */
  private chapterMenuSize(): number {
    return this.chapterActions().length
      + (this.currentBookIdx !== null && this.canCache() ? 2 : 0);
  }

  /** What the host is told about a chapter, including its address. */
  private chapterContext(i: number): ChapterActionContext {
    const chapters = this.currentBook?.chapters ?? [];
    return {
      book: this.currentBook,
      chapter: chapters[i],
      chapterIndex: i,
      chapterNumber: i + 1,
      hash: hashForChapter(this.books, this.currentBookIdx, i + 1),
    };
  }

  /**
   * Open the menu on one chapter row.
   *
   * Idempotent for one reason that is not hypothetical: Android Chrome fires a
   * contextmenu of its own at the end of a long press, so the hold and the
   * event both arrive for the same gesture. Opening twice must be one open.
   */
  private openChapterMenu(i: number, li: HTMLElement, fromKeyboard: boolean): void {
    if (this.chapterMenuFor === i) return;
    this.closeChapterMenu(false);

    const menu = document.createElement('div');
    menu.className = 'ch-menu-items';
    menu.setAttribute('role', 'menu');
    const ctx = this.chapterContext(i);
    const item = (id: string, label: string, own: boolean): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.className = 'ch-menu-item' + (own ? ' ch-menu-own' : '');
      btn.setAttribute('role', 'menuitem');
      btn.dataset.action = id;
      btn.textContent = label;
      menu.appendChild(btn);
      return btn;
    };

    // The host's, first: they are what this page is for. A host item hands off
    // somewhere else, so the menu goes.
    for (const a of this.chapterActions()) {
      const btn = item(a.id, typeof a.label === 'function' ? a.label(ctx) : a.label, false);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Closed BEFORE the callback: the host may open a dialog of its own,
        // and a menu left standing behind it is a second thing on screen
        // nobody asked for. It also means onSelect runs inside the click, so a
        // host may still call navigator.share, which needs the gesture.
        this.closeChapterMenu(true);
        a.onSelect(ctx);
      });
    }

    // The player's own, after. They need nothing but the browser, so unlike the
    // host's they are always here — and they REPORT IN PLACE rather than
    // closing, because both take time and can fail and the label is the only
    // place that can say so.
    const bookIdx = this.currentBookIdx;
    if (bookIdx !== null && this.canCache()) {
      const dl = item('download', this.offlineLabel(bookIdx), true);
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        const at = this.offlineState[bookIdx];
        // 'error' stays live: the failed state IS the retry button, exactly as
        // it is on the shelf.
        if (at === 'downloading' || at === 'downloaded') return;
        dl.textContent = 'Preparing…';
        void this.downloadForOffline(bookIdx).then(() => {
          // The menu may be long gone by the time a 700 MB book finishes.
          if (dl.isConnected) dl.textContent = this.offlineLabel(bookIdx);
        });
      });

      const fl = item('flush', 'Flush cached audio', true);
      fl.addEventListener('click', (e) => {
        e.stopPropagation();
        fl.textContent = 'Flushing…';
        void this.flushBookAudio(bookIdx).then((n) => {
          if (!fl.isConnected) return;
          // Three different facts, said differently. "Nothing cached" is not a
          // failure and "could not" is not an empty cache.
          fl.textContent = n === null ? 'Could not flush'
            : n === 0 ? 'Nothing cached'
            : `Cleared ${n} file${n === 1 ? '' : 's'}`;
        });
      });
    }

    li.classList.add('menu-open');
    li.setAttribute('aria-expanded', 'true');
    li.appendChild(menu);
    this.chapterMenuFor = i;
    this.chapterMenuEl = menu;

    // Positioned against the WINDOW, not against the pane.
    //
    // The pane scrolls and clips, and on a phone it is about 140px tall — less
    // than this menu — so a menu placed inside it has two of its items cut off
    // in either direction. Seen, not reasoned about: held on the last chapter
    // of a twelve-chapter book at 390x844, two items could not be pressed.
    // `position: fixed` escapes the clip while the node stays inside the row it
    // belongs to, which is what keeps the DOM honest about whose menu this is.
    //
    // Measured and placed in the SAME FRAME it was appended, so there is no
    // state where the menu is in one place and then another.
    const r = li.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.width = `${Math.round(r.width)}px`;
    menu.style.top = `${Math.round(r.bottom)}px`;
    const mh = menu.getBoundingClientRect().height;
    if (r.bottom + mh > window.innerHeight && r.top - mh >= 0) {
      menu.style.top = `${Math.round(r.top - mh)}px`;
      menu.classList.add('above');
    }

    // mousedown/touchstart rather than click: a click on a menu item must reach
    // the item, and a press anywhere else must close before it does anything
    // else. Capture, so a handler that stops propagation cannot strand it open.
    const outside = (e: Event) => {
      if ((e.target as Element)?.closest?.('.ch-menu-items')) return;
      this.closeChapterMenu(false);
    };
    // Escape is the way out of anything that floats, and the row it came from
    // is where focus belongs afterwards.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.closeChapterMenu(true);
    };
    // A fixed menu does not travel with the row it points at, so anything that
    // moves the row underneath it ends the menu rather than leaving it pointing
    // at the wrong chapter. The reader scrolling the list IS them moving on.
    const detach = () => this.closeChapterMenu(false);
    const list = this.refs.chapterList.current;
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('touchstart', outside, true);
    document.addEventListener('keydown', onKey, true);
    list?.addEventListener('scroll', detach, { passive: true });
    window.addEventListener('resize', detach);
    this.closeChapterMenuOutside = () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('touchstart', outside, true);
      document.removeEventListener('keydown', onKey, true);
      list?.removeEventListener('scroll', detach);
      window.removeEventListener('resize', detach);
    };

    if (fromKeyboard) (menu.firstElementChild as HTMLElement | null)?.focus();
  }

  /** `restoreFocus` hands the row back to a keyboard; a mouse must not be moved. */
  private closeChapterMenu(restoreFocus: boolean): void {
    this.closeChapterMenuOutside?.();
    this.closeChapterMenuOutside = null;
    const i = this.chapterMenuFor;
    this.chapterMenuFor = null;
    this.chapterMenuEl?.remove();
    this.chapterMenuEl = null;
    if (i === null) return;
    const li = this.chapterLis[i];
    if (!li) return;
    li.classList.remove('menu-open');
    li.removeAttribute('aria-expanded');
    if (restoreFocus && li.isConnected) li.focus();
  }

  // ------------------------------------------------------------ transcript

  private renderTranscriptChunks(chapterIndex: number): void {
    const box = this.refs.transcriptChunks.current;
    if (!box || !this.currentBook) return;
    const bt = bookTranscript(this.transcriptData, this.currentBook);
    if (!bt) return;
    // The chapter itself, not a synthetic { id }: chapterTranscript pairs on the
    // source chapter number where both sides publish one, and an object literal
    // carrying only a position silently opts this — the transcript pane, the
    // surface the reader actually reads — out of the fix.
    const forChapter = this.currentBook.chapters[chapterIndex - 1];
    const ct = chapterTranscript(bt, forChapter ?? { id: chapterIndex - 1 });
    box.innerHTML = '';
    this.setSourceLink(ct);
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

    // …and never while a menu is open on a row: the menu is anchored to its row,
    // so scrolling the list takes the menu off screen with it and leaves it
    // open somewhere the reader cannot see.
    if (!this.userScrolledChapters && this.chapterMenuFor === null) {
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

  /**
   * Tell the service worker which renders this book is currently made of.
   *
   * Versioned URLs stop a stale render from being SERVED; they do nothing
   * about the one already sitting in Cache Storage. Superseded entries would
   * otherwise accumulate for the life of the installation — an offline
   * download of a 1,128-chapter book that is re-rendered chapter by chapter
   * would eventually hold two copies of most of it, and the reader has no way
   * to see that, let alone clear it.
   *
   * The page is the only side that knows the answer, so it sends it: the exact
   * set of cache keys the book is made of right now. The worker drops audio
   * entries in those same directories that are not in the set — which is both
   * the superseded renders and anything left from before versioning existed.
   *
   * Everything here is best-effort and silent. `serviceWorker` is absent on
   * file:// and inside some privacy modes, `controller` is null on the very
   * first load before the worker has claimed the page (the next open sends it),
   * and none of that is worth a line in the reader's console.
   */
  private async announceAudioManifest(): Promise<void> {
    const book = this.currentBook;
    if (!book) return;
    try {
      if (!('serviceWorker' in navigator)) return;
      const keys: string[] = [];
      for (const ch of book.chapters) {
        for (const track of this.tracksOf(ch, 'all')) {
          if (!track.file) continue;
          keys.push(new URL(this.audioCacheUrl(track), location.href).href);
        }
      }
      if (!keys.length) return;
      const reg = await navigator.serviceWorker.ready;
      const worker = navigator.serviceWorker.controller ?? reg.active;
      worker?.postMessage({ type: AUDIO_MANIFEST_MESSAGE, keys });
    } catch {
      // A worker that cannot be reached is a cache that keeps a dead entry a
      // while longer. Never a reason to fail opening a book.
    }
  }

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
        // Versioned for the same reason in reverse — the key DOES carry `?v=`,
        // and a probe that omitted it would answer "not downloaded" for a book
        // that is, or worse, "downloaded" from a hit on a dead render.
        // full track, mode-independent.
        const url = this.audioCacheUrl({ file: ch.filename ?? '', hash: ch.content_hash });
        return (await cache.match(url)) ?? (await cache.match(new URL(url, location.href).href));
      }));
      return results.length > 0 && results.every(Boolean);
    } catch {
      return false;
    }
  }

  /** The one vocabulary for offline state, so the shelf and the menu agree. */
  private offlineLabel(bookIdx: number): string {
    switch (this.offlineState[bookIdx]) {
      case 'downloaded': return 'Downloaded \u2713';
      case 'downloading': return 'Preparing\u2026';
      case 'error': return 'Failed \u2014 retry \u21bb';
      default: return 'Download for offline';
    }
  }

  /**
   * Where this book's audio lives, as path prefixes.
   *
   * Derived from the chapters rather than from a configured prefix, and matched
   * by DIRECTORY rather than by filename, for one reason that decides the
   * whole feature: a stale cache entry is precisely one whose name the current
   * manifest no longer uses. Deleting the names the manifest has today would
   * miss exactly the entries a flush exists to remove — and it keeps working
   * when the audio URL becomes content-addressed, which is somebody else's
   * change in flight.
   *
   * On a single-directory site (one book, `audio/`) this is the whole library,
   * which is the honest answer there: the directory IS the book.
   */
  private audioDirsFor(book: Book): string[] {
    const base = this.opts.audioBaseUrl ?? 'audio/';
    const dirs = new Set<string>();
    for (const ch of book?.chapters ?? []) {
      const files = [ch.filename, (ch as { summary?: { filename?: string } }).summary?.filename];
      for (const file of files) {
        if (!file) continue;
        try {
          const path = new URL(base + file, location.href).pathname;
          const cut = path.lastIndexOf('/');
          if (cut > 0) dirs.add(path.slice(0, cut + 1));
        } catch { /* a filename that is not a URL is not a cache entry either */ }
      }
    }
    return [...dirs];
  }

  /**
   * Throw away this device's cached audio for one book. Returns how many
   * entries went, or null if Cache Storage could not be reached at all.
   *
   * Both caches, because a reader holding a stale chapter does not know or care
   * which one it came from: 'audiobook-audio' is what an explicit download
   * writes and 'audiobook-stream' is what listening leaves behind. The names
   * and the key shape (the signature stripped) belong to sw.js; this is the
   * page reaching into the same store the worker uses, and if that scheme
   * changes this changes with it.
   *
   * `caches` is NAMED inside the try on purpose. iOS Safari with "Block All
   * Cookies" throws SecurityError from the getter, so the usual guard —
   * `if (!window.caches)` — throws on its way to deciding rather than deciding.
   */
  private async flushBookAudio(bookIdx: number): Promise<number | null> {
    const book = this.books[bookIdx];
    const dirs = this.audioDirsFor(book);
    if (!dirs.length) return 0;
    let removed = 0;
    try {
      const store = caches;
      for (const name of ['audiobook-audio', 'audiobook-stream']) {
        const cache = await store.open(name);
        for (const req of await cache.keys()) {
          let path = '';
          try { path = new URL(req.url).pathname; } catch { continue; }
          if (!dirs.some((d) => path.startsWith(d))) continue;
          if (await cache.delete(req)) removed++;
        }
      }
    } catch {
      return null;
    }

    // The next byte has to come from the network, and two things stand between
    // it and that: the prefetch this engine may be holding, and the element's
    // own buffered copy of the chapter it is on. The reload carries the same
    // cache-busting parameter the stall recovery uses, which is what makes it
    // miss the browser's HTTP cache and the CDN edge as well as this store.
    this.prefetchedKey = null;
    if (this.currentBookIdx === bookIdx && this.currentBook) {
      const wasPlaying = !this.audio.paused;
      const at = this.audio.currentTime || 0;
      this.loadChapter(this.currentChapterIdx, at, wasPlaying, true);
    }
    // 'Downloaded \u2713' is a promise, and it has just stopped being true.
    this.offlineState[bookIdx] = undefined;
    this.renderLibrary();
    return removed;
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
        for (const track of this.tracksOf(ch, 'all')) {
          if (!track.file) continue;
          const abs = new URL(this.audioCacheUrl(track), location.href).href;
          if (await cache.match(abs)) continue;   // resume picks up cleanly
          // Fetch WITH the signature, store WITHOUT it: the bytes are the same
          // object however they were authorized, so a later signature still
          // finds them and an expired one never re-downloads 141 hours. The
          // VERSION stays on both sides — it names which render these bytes
          // are, which is the one thing an offline copy must not lose.
          const r = await fetch(withMediaQuery(abs, this.mediaQuery()));
          if (!r.ok) throw new Error(`fetch ${track.file} failed`);
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

  /**
   * The chapter a hash asks for, or null.
   *
   * Out of range answers null rather than clamping: a link to chapter 90 of an
   * 80-chapter book is a link to a book that has changed shape, and dropping
   * the reader at the end is a worse answer than dropping them where they were.
   */
  private chapterIdxFor(bookIdx: number, chapter: number | null): number | null {
    if (chapter == null) return null;
    const chapters = this.books[bookIdx]?.chapters ?? [];
    const i = chapter - 1;
    return chapters[i] ? i : null;
  }

  /**
   * Spend the chapter segment: the address goes back to naming the book.
   *
   * The segment is a doorway, not a bookmark (docs/spec-chapter-list.md §6).
   * Left in place it would survive the listen, and a reader sent to chapter 5
   * who has reached chapter 8 would be thrown back to 5 by a reload — breaking
   * the promise the hash exists to keep. replaceState, not pushState: arriving
   * by a link is one history entry, and a Back that lands on the same page is
   * a trap.
   */
  private spendChapterHash(idx: number): void {
    const target = hashForBook(this.books, idx);
    if (location.hash === target) return;
    history.replaceState(null, '', target || location.pathname + location.search);
  }

  openBook(idx: number, updateUrl = true, chapterIdx: number | null = null): void {
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

    // A chapter asked for by URL wins over the stored position, and starts at
    // the chapter's beginning: whoever sent the link meant the chapter, not
    // wherever this reader happened to stop in it. autoplay stays false either
    // way — arriving is not being played at.
    const bt = Math.max(0, Math.min(p.bookTime || 0, this.bookDur()));
    const startIdx = chapterIdx ?? findChapterIdxAt(this.currentBook, bt, this.summaryMode);
    const offset = chapterIdx == null ? bt - this.chStart(this.currentBook.chapters[startIdx]) : 0;
    this.loadChapter(startIdx, offset, false);

    // The worker cannot know which renders are current — it sees URLs, not
    // manifests — so the page that does know tells it, once per book open.
    void this.announceAudioManifest();

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
    this.closeChapterMenu(false);
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
    const route = routeFromHash(location.hash);
    if (route.slug) {
      const idx = bookIdxFromSlug(this.books, route.slug);
      if (idx >= 0) {
        const chIdx = this.chapterIdxFor(idx, route.chapter);
        if (idx !== this.currentBookIdx) this.openBook(idx, false, chIdx);
        else if (chIdx !== null) this.loadChapter(chIdx, 0, false);
        if (route.chapter !== null) this.spendChapterHash(idx);
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

  /**
   * The two library invariants the player relies on and cannot enforce.
   *
   * Warned, not repaired, and for different reasons in each case — see
   * `nonPositionalChapterId` and `collidingSlugs` in core/. console.warn rather
   * than the rs-diag ring buffer on purpose: rs-diag is for failures on a phone
   * with nobody watching, and a bad manifest is deterministic and fires on the
   * first load in any browser, where whoever built it will be looking.
   */
  private checkManifest(): void {
    for (const book of this.books) {
      const bad = nonPositionalChapterId(book);
      if (bad >= 0) {
        console.warn(
          `[player] "${book.title ?? bookSlug(book)}": chapter at position ${bad} has ` +
          `id ${book.chapters[bad]?.id}. Chapter ids are read as positions — summary ` +
          `starts, chapter rows, progress bars and transcript ids all index by them — ` +
          `so this book will seek and highlight the wrong chapter. Renumber from 0 in ` +
          `the manifest.`);
      }
    }
    for (const slug of collidingSlugs(this.books)) {
      console.warn(
        `[player] more than one book resolves to the slug "${slug}", so #/${slug} ` +
        `opens only the first and the rest are unreachable by URL. Titles longer ` +
        `than 60 characters can collide after truncation. Give them distinct ` +
        `\`slug\` values in the manifest — deriving one here would change the slug ` +
        `of every long-titled book that already exists.`);
    }
  }

  start(): void {
    const r = this.refs;
    this.checkManifest();
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

    const route = routeFromHash(location.hash);
    const hashIdx = route.slug ? bookIdxFromSlug(this.books, route.slug) : -1;
    if (hashIdx >= 0) {
      this.openBook(hashIdx, false, this.chapterIdxFor(hashIdx, route.chapter));
      if (route.chapter !== null) this.spendChapterHash(hashIdx);
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
