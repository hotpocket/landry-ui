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
