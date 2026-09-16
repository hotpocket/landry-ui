/**
 * remote-progress.ts — where you left off, on the other device.
 *
 * A reading position has been a fact only one browser knows since the player
 * shipped: `rs-progress-<bookId>` in localStorage, which does not survive a new
 * phone and cannot be seen from the laptop. books.landry.bot grew the server
 * half (GET/PUT `/api/me/progress/<book_id>`); this is the player half.
 *
 * THE ENGINE NEVER NAMES `fetch`. The host injects a backend, because the host
 * is the only layer that knows whether anyone is signed in, what a credential
 * is, and which transport survives a page going away. A host that injects
 * nothing gets today's behaviour exactly — a signed-out listener stays
 * localStorage-only and no anonymous id is ever minted for them.
 *
 * Two rules shape the rest, and both are about not being trusted with someone's
 * place in a book:
 *
 *   * A remote record is an OFFER, never a seek. A device that was paused for a
 *     month must not yank a listener mid-sentence because it woke up. The
 *     merge rule is last-write-wins, but the WIN is a prompt, not a jump.
 *   * A PUT costs a `readable_book()` check, which on a public book is a GSI
 *     query. So the cadence is events a person caused — a pause, a chapter
 *     change, the page going away — never a timer and never a `timeupdate`.
 *
 * The class this belongs to, named so the next one is findable: EVERY PER-USER
 * FACT THAT ONLY ONE DEVICE KNOWS. Progress is the member that hurt. The others
 * still local, enumerated and not fixed here: `rs-summary`, `rs-follow`,
 * `rs-reading`, `rs-textsize-n`, the playback speed, and `rs-diag`.
 */

import type { KeyValueStore, ProgressRecord } from './progress.ts';

/**
 * One reader's place in one book, as this module passes it around.
 *
 * On the way IN (from `list()`) `updatedAt` is the server's stamp. On the way
 * OUT (to `put()`) it is this browser's own clock, which the host sends as
 * `client_ts`; the server stamps its own `updated_at` and hands that back. The
 * two are never mixed, because a merge that trusted a client clock as the
 * ordering key would be decided by whichever device had the worst one.
 */
export interface RemoteRecord {
  bookId: string;
  /** The chapter's OWN number, never a list position. The API refuses < 1. */
  chapterN: number;
  /** Position WITHIN that chapter, in seconds — the pair `chapterN` belongs to. */
  seconds: number;
  updatedAt: string;
  device?: string;
  contentVersion?: string;
}

/** The host's half. Values and promises only; nothing about HTTP crosses here. */
export interface RemoteProgressBackend {
  list(): Promise<RemoteRecord[]>;
  put(bookId: string, rec: RemoteRecord): Promise<void>;
}

/**
 * How far apart two positions in the same chapter have to be before they are
 * different places worth asking about.
 *
 * Thirty seconds is about one paragraph read aloud. Below it the offer is
 * noise: pausing on the laptop and picking up the phone a minute later would
 * prompt every single time, and a prompt that is always there is a prompt
 * nobody reads.
 */
export const DRIFT_S = 30;

/** Which remote record the reader has already said no to, per book. */
const DISMISSED = (bookId: string) => `rs-remote-dismissed-${bookId}`;

export interface RemoteProgressDeps {
  /** Absent means the whole feature is absent. That is the signed-out path. */
  backend?: RemoteProgressBackend;
  store: KeyValueStore;
  device?: string;
  /** The manifest version for a book, when the player knows one. */
  contentVersionFor?: (bookId: string) => string | undefined;
  nowIso?: () => string;
  /** The engine's `rs-diag` ring buffer. A phone with its screen off has no console. */
  onDiag?: (ev: string, extra: Record<string, unknown>) => void;
}

/**
 * Build the body for a PUT, or null if the server would refuse it.
 *
 * The validation deliberately mirrors the API's. A 400 still costs the round
 * trip, and on a public book it costs the GSI query that runs before the body
 * is even looked at — so a chapter number the player does not have yet is a
 * reason not to ask, not a reason to ask and lose.
 */
export function remoteRecordFor(
  bookId: string,
  chapterN: number | null | undefined,
  seconds: number,
  opts: { device?: string; contentVersion?: string; nowIso: () => string },
): RemoteRecord | null {
  if (!bookId) return null;
  if (typeof chapterN !== 'number' || !Number.isInteger(chapterN) || chapterN < 1) return null;
  // isFinite, not `>= 0` alone: NaN compares false against every bound, and the
  // API had to grow the same guard for the same reason.
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const rec: RemoteRecord = {
    bookId,
    chapterN,
    // Milliseconds are more than a listener can hear and more than the row
    // needs; the round trip is cheaper for it.
    seconds: Math.round(seconds * 1000) / 1000,
    updatedAt: opts.nowIso(),
  };
  // Present-or-absent, never empty: the API bounds these strings and an empty
  // one would occupy a row field to say nothing.
  if (opts.device) rec.device = opts.device;
  if (opts.contentVersion) rec.contentVersion = opts.contentVersion;
  return rec;
}

/** What the offer says. One sentence, and it names the device when it can. */
export function offerText(rec: RemoteRecord, fmt: (s: number) => string): string {
  const where = `Continue from Ch ${rec.chapterN} · ${fmt(rec.seconds)}`;
  return rec.device ? `${where} on ${rec.device}?` : `${where}?`;
}

/** ISO to epoch ms, or NaN. The server's microseconds parse; a lexical compare
 *  of its stamp against the client's milliseconds would not. */
function ms(iso: string | null | undefined): number {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? t : NaN;
}

export class RemoteProgress {
  /** True once a `list()` has come back. Never true when there is no backend. */
  ready = false;

  private backend?: RemoteProgressBackend;
  private store: KeyValueStore;
  private device?: string;
  private contentVersionFor: (bookId: string) => string | undefined;
  private nowIso: () => string;
  private onDiag: (ev: string, extra: Record<string, unknown>) => void;

  private byBook = new Map<string, RemoteRecord>();
  /** At most one put per book is in flight; the newest loser waits in `queued`. */
  private inflight = new Set<string>();
  private queued = new Map<string, RemoteRecord>();

  constructor(deps: RemoteProgressDeps) {
    this.backend = deps.backend;
    this.store = deps.store;
    this.device = deps.device;
    this.contentVersionFor = deps.contentVersionFor ?? (() => undefined);
    this.nowIso = deps.nowIso ?? (() => {
      try { return new Date().toISOString(); } catch { return ''; }
    });
    this.onDiag = deps.onDiag ?? (() => { /* a host that wants no log gets none */ });
  }

  enabled(): boolean {
    return !!this.backend;
  }

  /**
   * Fetch every position this reader has, once, in the background.
   *
   * ALWAYS resolves. The engine awaits nothing and renders from local first, so
   * a rejection here must cost the offer and nothing else: an unhandled one on
   * the boot path is a blank page for a reader with no console to say why.
   * Recorded once, not per book — a log that repeats the same outage per record
   * evicts the diagnostics that came before it.
   */
  start(): Promise<void> {
    if (!this.backend) return Promise.resolve();
    let p: Promise<RemoteRecord[]>;
    try {
      p = this.backend.list();
    } catch (e) {
      this.note('remote-list', e);
      return Promise.resolve();
    }
    return Promise.resolve(p).then((records) => {
      for (const r of records ?? []) {
        if (r && r.bookId) this.byBook.set(String(r.bookId), r);
      }
      this.ready = true;
    }).catch((e) => {
      this.note('remote-list', e);
    });
  }

  /**
   * The record to prompt with for this book, or null.
   *
   * Three gates, in the order that costs least: already answered, not newer,
   * not different. Any one of them missing turns the offer into a nag or into
   * a lie about where the other device is.
   */
  offer(bookId: string, local: ProgressRecord | null | undefined): RemoteRecord | null {
    const rec = this.byBook.get(bookId);
    if (!rec) return null;
    if (this.dismissedAt(bookId) === rec.updatedAt) return null;
    if (!this.isNewer(rec, local)) return null;
    if (!differs(rec, local)) return null;
    return rec;
  }

  /**
   * The reader said no. Remembered against that record's stamp, not against the
   * book: keyed on the book alone it would silence every future device forever,
   * which is the same defect as never offering at all.
   */
  dismiss(rec: RemoteRecord | null | undefined): void {
    if (!rec) return;
    try {
      this.store.setItem(DISMISSED(rec.bookId), rec.updatedAt);
    } catch { /* blocked storage: the offer comes back, which is the safe way to fail */ }
  }

  /**
   * The reader accepted, or moved on their own: this browser is now the newest
   * writer, so the record that was offered stops being an offer. Without this
   * the same prompt returns the next time the book is opened.
   */
  accept(rec: RemoteRecord | null | undefined): void {
    this.dismiss(rec);
  }

  /**
   * Record a position. Fire-and-forget by design — nothing waits on it and
   * nothing is told when it fails.
   *
   * Coalesced per book: one request in flight, and a put that arrives while one
   * is open replaces whatever was waiting. A listener tapping pause three times
   * in two seconds is two requests, not three, and the second one carries where
   * they actually are rather than where they were in the middle.
   */
  put(bookId: string, chapterN: number | null | undefined, seconds: number,
      contentVersion?: string): void {
    if (!this.backend) return;
    const rec = remoteRecordFor(bookId, chapterN, seconds, {
      device: this.device,
      contentVersion: contentVersion ?? this.contentVersionFor(bookId),
      nowIso: this.nowIso,
    });
    if (!rec) return;
    // This browser has just written the newest position it knows about, so
    // whatever the other device left is no longer worth asking about.
    this.byBook.delete(bookId);
    if (this.inflight.has(bookId)) { this.queued.set(bookId, rec); return; }
    this.send(bookId, rec);
  }

  private send(bookId: string, rec: RemoteRecord): void {
    this.inflight.add(bookId);
    let p: Promise<void>;
    try {
      p = this.backend!.put(bookId, rec);
    } catch (e) {
      // A host whose transport throws synchronously — `sendBeacon` refusing a
      // body, a blocked fetch — must still release the book.
      p = Promise.reject(e);
    }
    Promise.resolve(p)
      .catch((e) => { this.note('remote-put', e); })
      .then(() => {
        // In the `then`, not only in the success path: a failed put that left
        // the book marked in flight would strand every later position silently.
        this.inflight.delete(bookId);
        const next = this.queued.get(bookId);
        if (next) { this.queued.delete(bookId); this.send(bookId, next); }
      })
      // A terminal catch on every chain. There is nothing above this to report
      // to, and an unhandled rejection on a boot path is the shape that blanks
      // a page on a browser with no console.
      .catch(() => { /* nothing left to do about it */ });
  }

  private dismissedAt(bookId: string): string | null {
    try {
      return this.store.getItem(DISMISSED(bookId));
    } catch {
      return null;
    }
  }

  /**
   * Is the other device's record newer than this browser's own save?
   *
   * A local record with no `savedAt` predates this feature, so it cannot be
   * shown to be newer than anything and the remote wins — which is the same
   * answer as "no local record", and for the same reason. A REMOTE stamp that
   * will not parse loses instead: an offer is an interruption, and one that
   * cannot say when it happened has not earned it.
   */
  private isNewer(rec: RemoteRecord, local: ProgressRecord | null | undefined): boolean {
    const r = ms(rec.updatedAt);
    if (!Number.isFinite(r)) return false;
    if (!local) return true;
    const l = ms(local.savedAt);
    if (!Number.isFinite(l)) return true;
    return r > l;
  }

  private note(ev: string, e: unknown): void {
    try {
      this.onDiag(ev, { err: e instanceof Error ? e.message : String(e) });
    } catch { /* the log is never the reason a chapter does not play */ }
  }
}

/**
 * Is the remote record somewhere ELSE, as opposed to the same place said twice?
 *
 * A different chapter always is. Within one chapter it takes more than
 * `DRIFT_S`, because the two devices drift by a few seconds every time one of
 * them saves on pause and the other on a chapter boundary, and prompting for
 * that is prompting always.
 */
function differs(rec: RemoteRecord, local: ProgressRecord | null | undefined): boolean {
  if (!local) return true;
  if (local.chapterN !== rec.chapterN) return true;
  return Math.abs((local.timeInChapter ?? 0) - rec.seconds) > DRIFT_S;
}

// --------------------------------------------------------------- landing

/**
 * Which chapter of which book the audio element is currently holding.
 *
 * `bookIdx: null` is "nothing loaded yet", which is a session's first chapter
 * and is not a departure from anything.
 */
export interface ChapterSlot {
  bookIdx: number | null;
  chapterIdx: number;
}

/**
 * Is loading `next` a departure from `loaded` worth recording?
 *
 * The position of a chapter exists for exactly as long as the element holds
 * it: the clock resets the instant a new `src` lands, so the put has to happen
 * on the way out or not at all. Three things are NOT departures, and each of
 * them cost something real:
 *
 *   * nothing was loaded — a session's first chapter leaves no position.
 *   * a reload in place — recovery and the stall watchdog both reload the same
 *     chapter, and a PUT each time is a GSI query per retry for a position
 *     that has not moved.
 *   * the book changed — `openBook` retargets `currentBookIdx` BEFORE it loads
 *     the incoming book's first chapter, so the loaded chapter's own book is
 *     the only thing that can say whose offset this is. Without it, opening a
 *     second book files the first book's position under the second. `openBook`
 *     records the outgoing book itself, under the outgoing id.
 */
export function leavesAChapter(loaded: ChapterSlot, next: ChapterSlot): boolean {
  if (loaded.bookIdx === null) return false;
  if (loaded.bookIdx !== next.bookIdx) return false;
  return loaded.chapterIdx !== next.chapterIdx;
}

/**
 * Where the chapter with this NUMBER sits in this build of the book, or -1.
 *
 * Never `n - 1`. The number is the chapter's own — a book may start at 3, or
 * skip one — and a record written before the book was republished may name a
 * chapter that is no longer here at all. -1 is an answer, not a failure: the
 * offer is still answered, the listener simply is not moved.
 */
export function chapterIdxForN(
  chapters: { n?: number | null }[],
  n: number | null | undefined,
): number {
  if (typeof n !== 'number') return -1;
  return chapters.findIndex((c) => c.n === n);
}

/**
 * The position to land on, clamped into the chapter that is receiving it.
 *
 * `chapterDur` of 0 means the player does not know the length yet, and
 * clamping against an unknown length would land every offer at 0:00 — the one
 * place the listener certainly was not. So an unknown duration clamps nothing.
 */
export function landingSeconds(seconds: number, chapterDur: number): number {
  return Math.max(0, Math.min(seconds, chapterDur || seconds));
}
