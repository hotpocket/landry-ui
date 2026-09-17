/**
 * storage.ts — a Storage the player can always write to.
 *
 * `localStorage` is not a property that quietly answers null when storage is
 * unavailable. iOS Safari with Settings → Safari → Advanced → "Block All
 * Cookies" throws SecurityError from the GETTER, so *naming the identifier* is
 * a throw. init() named it while constructing the engine, and a throw there is
 * a mount that never happens: books.landry.bot painted its static footer and
 * nothing else, on a phone with no console to read the reason in.
 *
 * Two failure shapes, and they are not the same one:
 *   - access refused (the getter throws) — there is no store at all;
 *   - access allowed, writes refused (quota, and older private modes) — reads
 *     work, setItem throws.
 * Both degrade to a store that works and forgets. Forgetting a preference is a
 * small loss; a player that does not appear is the whole loss.
 *
 * The fallback shadows reads too, so a value set during the session reads back
 * within it. Anything else would make a toggle silently snap back one frame
 * after it was pressed, which reads as broken rather than as unpersisted.
 */

import type { KeyValueStore } from './progress.ts';

/** Where the real thing comes from. Injected so this is testable in node. */
type StorageSource = () => KeyValueStore | undefined | null;

const defaultSource: StorageSource = () => globalThis.localStorage;

export function safeStorage(source: StorageSource = defaultSource): KeyValueStore {
  let real: KeyValueStore | null = null;
  try {
    real = source() ?? null;
  } catch {
    real = null;   // access refused outright
  }

  // Written to only when `real` cannot take a value. Kept even when `real`
  // works, because a write can start failing partway through a session (quota)
  // and the reader should not watch their settings revert.
  const shadow = new Map<string, string>();

  return {
    getItem(key: string): string | null {
      if (shadow.has(key)) return shadow.get(key) as string;
      if (!real) return null;
      try {
        return real.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      if (real) {
        try {
          real.setItem(key, value);
          // A previously shadowed key is now genuinely stored; leaving the
          // shadow entry would pin the stale value for the rest of the session.
          shadow.delete(key);
          return;
        } catch {
          /* fall through to the shadow */
        }
      }
      shadow.set(key, String(value));
    },
  };
}
