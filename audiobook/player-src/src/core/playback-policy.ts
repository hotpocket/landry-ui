/**
 * playback-policy.ts — retry and prefetch, as decisions rather than timers.
 *
 * Both encode fixes from 2026-08-03, when a book would silently stop with the
 * screen off. The audio element holds one chapter at a time, so every chapter
 * boundary is a fresh network fetch at the exact moment a phone is most willing
 * to suspend the page and least willing to do work.
 *
 * The timers, fetches and element handling stay in the view; only the decisions
 * live here, where they can be tested without a browser or a clock.
 */

/** Capped so an offline phone gives up instead of spinning forever. */
export const RETRY_MAX = 3;

const RETRY_DELAYS_MS = [800, 2500, 8000];

export function shouldRetry(attemptsSoFar: number): boolean {
  return attemptsSoFar < RETRY_MAX;
}

/** Backs off. Past the table, the last delay repeats rather than yielding undefined. */
export function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

/** How far before the end of a chapter the next one is fetched. */
export const PREFETCH_LEAD_S = 45;

/**
 * Identifies what has already been prefetched.
 *
 * The mode is part of the key because summary and full are different files: a
 * key without it would treat the full track as already fetched after a switch
 * to summary, and the boundary would stall exactly as it did before.
 */
export function prefetchKey(bookIdx: number, chapterIdx: number, summary: boolean): string {
  return `${bookIdx}:${chapterIdx}:${summary ? 's' : 'f'}`;
}

export interface PrefetchQuery {
  paused: boolean;
  chapterIdx: number;
  chapterCount: number;
  chapterDuration: number;
  currentTime: number;
  key: string;
  lastKey: string | null;
}

export function shouldPrefetch(q: PrefetchQuery): boolean {
  if (q.paused) return false;
  if (q.chapterIdx + 1 >= q.chapterCount) return false;
  if (q.chapterDuration - q.currentTime > PREFETCH_LEAD_S) return false;
  return q.key !== q.lastKey;
}

/**
 * How long a wanted chapter may produce nothing before it counts as stalled.
 *
 * Patient on purpose: a phone on a dozing radio can take many seconds to answer,
 * and recovering early costs a reload and an audible jump for a chapter that was
 * about to arrive.
 */
export const STALL_TIMEOUT_MS = 15000;

export interface StallQuery {
  /** Playback was asked for and has not been given up on. */
  playIntent: boolean;
  /** A person asked for silence. Outranks everything else here. */
  userPaused: boolean;
  /** The scene-break hold — silent, not advancing, and perfectly healthy. */
  scenePauseHolding: boolean;
  ended: boolean;
  /** The clock moved since the watchdog armed. */
  advanced: boolean;
  /** readyState says the element holds enough data to keep playing. */
  canPlayThrough: boolean;
}

/**
 * Whether a silent, non-advancing element should be reloaded.
 *
 * This exists because the only recovery trigger used to be the `error` event,
 * and the common screen-off failure fires no error at all: the request for the
 * next chapter simply hangs, so the element never reaches `loadedmetadata`,
 * never plays, never errors, and nothing was watching. The book just stopped.
 *
 * Every guard below is a case that looks identical from the element's state and
 * must NOT be reloaded — a hold mid-scene, a book someone paused, a chapter that
 * ended, a slow-but-moving stream, and an element that already holds its data.
 */
export function shouldRecoverFromStall(q: StallQuery): boolean {
  if (!q.playIntent) return false;
  if (q.userPaused) return false;
  if (q.scenePauseHolding) return false;
  if (q.ended) return false;
  if (q.advanced) return false;
  if (q.canPlayThrough) return false;
  return true;
}
