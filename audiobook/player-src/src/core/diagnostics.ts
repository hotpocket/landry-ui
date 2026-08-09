/**
 * diagnostics.ts — a small ring buffer of what playback did when it failed.
 *
 * A phone with its screen off has no console, and the person listening is not
 * at the machine. Every screen-off failure so far was diagnosed by reading
 * code and guessing; this is the record that replaces the guess. It lives in
 * the same storage as the progress records, which is why it is capped: a long
 * listen that kept appending would eventually get the whole origin's storage
 * evicted by quota, taking the reading positions with it.
 *
 * Storage lives in the engine; only the shape and the cap are decided here, so
 * they can be tested without a browser.
 */

export interface DiagEntry {
  /** ISO timestamp. A string, not a Date: this is serialized the moment it exists. */
  at: string;
  /** What happened: 'error', 'stall', 'retry', 'recovered', 'gave-up'. */
  ev: string;
  [k: string]: unknown;
}

/** Newest-wins beyond this. Fifty entries is several failures with their retries. */
export const DIAG_MAX = 50;

export function readDiag(stored: string | null | undefined): DiagEntry[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    // Shape-checked, not just parse-checked: a JSON object here would give
    // `.length` of undefined and take the caller down with it.
    return Array.isArray(parsed) ? (parsed as DiagEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Appends one entry, returning what to store. Oldest entries are dropped past
 * the cap — the failure being reported is always the recent one.
 *
 * A corrupt buffer is replaced rather than repaired: diagnostics must never be
 * the reason a chapter does not play.
 */
export function appendDiag(stored: string | null | undefined, entry: DiagEntry,
                           cap: number = DIAG_MAX): string {
  const all = readDiag(stored);
  all.push(entry);
  return JSON.stringify(all.slice(Math.max(0, all.length - cap)));
}
