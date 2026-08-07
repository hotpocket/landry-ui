/**
 * recency.ts — which chapters count as new.
 *
 * The date comes from chatterbook's manifest, recorded when a chapter is first
 * seen and carried forward on every later build. That makes it stable: a
 * re-encode does not make a chapter new again, which is exactly what keying on
 * file mtime would have done.
 */

/** Long enough to still be there after a weekend away. */
export const NEW_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isRecent(dateAdded: string | null | undefined, now: number = Date.now()): boolean {
  // Predates the field: not new, just unknown. Mutation cannot distinguish this
  // from the NaN path below (Date.parse(undefined) is also NaN), but it stays:
  // "no date" is the normal case for every book published before the field
  // existed, and normal cases should read explicitly rather than depend on the
  // semantics of comparing against NaN.
  if (!dateAdded) return false;

  // One comparison carries three cases, which is worth spelling out because
  // mutation showed the explicit guards for two of them were unreachable:
  //   - a normal age is compared to the window, as written;
  //   - an unparseable date gives NaN, and every NaN comparison is false, so
  //     it reads as not-new;
  //   - a future date (clock skew on a build machine) gives a negative age,
  //     which is less than the window, so it stays new rather than being
  //     silently hidden.
  return now - Date.parse(dateAdded) < NEW_WINDOW_DAYS * DAY_MS;
}
