/**
 * scene.ts — the hold between scenes.
 *
 * A "* * *" divider in the source marks a scene change the narrator does not
 * read aloud. Playback pauses briefly when it crosses one, so scenes feel
 * separated rather than running together.
 *
 * Every guard below exists because without it the hold fires when nothing
 * changed scene — and a two-second silence mid-sentence is worse than not
 * having the feature. The decision is a pure function of two adjacent tick
 * times so it can be tested without a clock.
 */

import type { Chunk } from './transcript.ts';

/**
 * Above this, a time step is a seek rather than playback. A frame advances by
 * milliseconds; a scrub advances by seconds.
 */
export const SEEK_THRESHOLD_S = 1.5;

export function isSceneBreak(chunk: Partial<Chunk> & { scene_break?: boolean } | null | undefined): boolean {
  if (!chunk) return false;
  if (chunk.scene_break) return true;
  const t = chunk.text ?? '';
  // Asterisks and whitespace only, and at least two of them: a lone asterisk is
  // emphasis that lost its markup, not a divider.
  return /^[\s*]+$/.test(t) && (t.match(/\*/g) ?? []).length >= 2;
}

export interface CrossingQuery {
  chunks: Chunk[] | null | undefined;
  /** Chapter-local time at the previous tick. */
  from: number;
  /** Chapter-local time now. */
  to: number;
  /** Whether the chapter changed between the two ticks. */
  chapterChanged: boolean;
}

/**
 * Whether normal playback just crossed a scene divider.
 *
 * The window is (from, to] — start-exclusive so the same divider cannot fire on
 * two consecutive frames, end-inclusive so landing exactly on it still counts.
 */
export function crossedSceneBreak({ chunks, from, to, chapterChanged }: CrossingQuery): boolean {
  if (chapterChanged) return false;
  if (!chunks?.length) return false;
  // Too far to be a frame: that is a scrub, not reading.
  //
  // No explicit guard for zero or backwards progress: the window below is
  // (from, to], which is already empty in both cases. Mutation proved the extra
  // check could be deleted with nothing going red.
  if (to - from > SEEK_THRESHOLD_S) return false;
  return chunks.some((c) => isSceneBreak(c) && c.start > from && c.start <= to);
}
