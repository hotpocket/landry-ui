/**
 * book-search.ts — searching from the open book (docs/spec-book-search.md).
 *
 * The library search's scan (../core/search.ts), plus the parts only an open
 * book has: a scope (this chapter, this book, all books), a list that puts the
 * chapter playing first, a bar that steps through every match in the scope,
 * and marks on the term in the transcript on screen.
 *
 * It never fetches audio. A jump does, through the engine, and only for the
 * chapter jumped to. Other books' transcripts are fetched only once All books
 * is chosen, and their rows appear as each lands.
 */

import { MIN_QUERY, searchBooks, type SearchMatch } from '../core/search.ts';
import type { BookTranscript } from '../core/transcript.ts';

export type Scope = 'chapter' | 'book' | 'all';

interface BookInfo { slug: string; title?: string; chapters: { title?: string }[] }

export interface BookSearchHost {
  /** The open book, its slug resolved. */
  book(): BookInfo | null;
  /** Every book in the library, in library order, slugs resolved. */
  books(): BookInfo[];
  /** A book's transcript if it is on the client, else null. */
  transcriptFor(slug: string): BookTranscript | null;
  /** Fetch the named books' transcripts, calling back as each lands. */
  ensureTranscripts(slugs: string[], onEach: () => void): void;
  /** Whether any transcript is still being fetched. */
  loading(): boolean;
  /** Whether `slug` is (or will open) in summary mode — what is on screen
   *  once it is open, so the text searched and the clock jumped on agree. */
  summaryFor(slug: string): boolean;
  /** The chapter (position) of `slug` a transcript chapter index belongs to, or -1. */
  chapterIdxIn(slug: string, transcriptIndex: number): number;
  currentChapterIdx(): number;
  currentTime(): number;
  /** Move playback to `t` in chapter `idx` of `slug` (opening it if needed),
   *  keeping play/pause, and show it. */
  jump(slug: string, idx: number, t: number): void;
  /** The transcript pane's chunk container. */
  chunks(): HTMLElement | null;
}

export interface BookSearchEls {
  input: HTMLInputElement;
  results: HTMLElement;
  scope: HTMLElement;
  list: HTMLElement;
  nav: HTMLElement;
  pos: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
}

interface Hit { m: SearchMatch; slug: string; idx: number }

export class BookSearch {
  private host: BookSearchHost;
  private el: BookSearchEls;
  private query = '';
  private hits: Hit[] = [];
  private at = -1;
  private scope: Scope = 'book';
  /** Where the list was ordered from: the book and chapter playing when it ran. */
  private origin: { slug: string; idx: number } | null = null;
  /** As each other book's transcript lands: re-list if the list is up or
   *  nothing is picked yet. Never moves playback; a picked match keeps its
   *  place. One function for the instance, so the loader's waiter set holds it
   *  once however many keystrokes ask during a slow fetch. */
  private readonly onTranscript = (): void => {
    if (this.disposed || this.query.length < MIN_QUERY) return;
    // Picked: the newcomer joins navigation in the order the stepping started
    // from, and a closed list stays closed. Not picked: re-listed from here.
    this.refresh({ reorigin: this.at < 0, show: this.at < 0 || !this.el.results.hidden });
  };
  /** Every listener this instance adds, so dispose() removes them in one go. */
  private readonly ac = new AbortController();
  private disposed = false;

  constructor(host: BookSearchHost, el: BookSearchEls) {
    this.host = host;
    this.el = el;
    const signal = this.ac.signal;
    el.input.addEventListener('input', () => this.run(el.input.value), { signal });
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.jumpFromHere(); }
      if (e.key === 'Escape') { e.preventDefault(); this.reset(); el.input.blur(); }
    }, { signal });
    el.input.addEventListener('focus', () => { if (this.query.length >= MIN_QUERY) this.showList(); }, { signal });
    el.scope.addEventListener('change', (e) => {
      const v = (e.target as HTMLInputElement).value as Scope;
      if (v !== 'chapter' && v !== 'book' && v !== 'all') return;
      this.scope = v;
      this.run(this.el.input.value);
    }, { signal });
    el.prev.addEventListener('click', () => this.step(-1), { signal });
    el.next.addEventListener('click', () => this.step(1), { signal });
    el.close.addEventListener('click', () => this.reset(), { signal });
    // A tap elsewhere closes the list; the bar stays until closed.
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node | null;
      if (!el.results.hidden && t && !el.results.contains(t) && t !== el.input) el.results.hidden = true;
    }, { signal });
  }

  /** The engine is being replaced (re-init): drop every listener, and make any
   *  transcript callback still queued in the shared loader a no-op. */
  dispose(): void {
    this.disposed = true;
    this.ac.abort();
  }

  /** The engine loaded another chapter. `bySearch`: the load is the one a jump
   *  of ours caused (the engine numbers loads, so a pre-empted jump or a later
   *  manual or natural change cannot pass for one) — stepping put playback
   *  there and the order stays. Otherwise playback moved on, or the reader
   *  moved it, and an active search re-scopes and re-orders from there. */
  chapterChanged(bySearch: boolean): void {
    if (this.disposed || bySearch || this.query.length < MIN_QUERY) return;
    this.refresh({ reorigin: true, show: !this.el.results.hidden });
  }

  /** Clear everything: the box, the list, the bar and the marks. The scope is
   *  the reader's choice and outlives a query; closing the book resets it. */
  reset(scopeToo = false): void {
    this.query = '';
    this.hits = [];
    this.at = -1;
    this.origin = null;
    if (scopeToo) this.setScope('book');
    this.el.input.value = '';
    this.el.results.hidden = true;
    this.el.list.replaceChildren();
    this.el.nav.hidden = true;
    this.applyMarks();
  }

  /** The current match, if it is in the book on screen. */
  private currentHere(): Hit | null {
    const cur = this.at >= 0 ? this.hits[this.at] : null;
    return cur && cur.slug === this.host.book()?.slug ? cur : null;
  }

  /** Re-mark the transcript after the engine re-renders it (a chapter change). */
  applyMarks(): void {
    const box = this.host.chunks();
    if (!box) return;
    for (const m of [...box.querySelectorAll('mark.bs-hit')]) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
      parent.normalize();
    }
    for (const c of [...box.querySelectorAll('.transcript-chunk.bs-match')]) c.classList.remove('bs-match');
    const q = this.query.toLowerCase();
    if (q.length < MIN_QUERY) return;
    const cur = this.currentHere();
    const curEl = cur && cur.idx === this.host.currentChapterIdx()
      ? box.querySelector(`#tc-${cur.idx + 1}-${cur.m.chunkIndex}`) : null;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    for (const node of nodes) {
      let rest: Text = node;
      for (let i = rest.data.toLowerCase().indexOf(q); i !== -1; i = rest.data.toLowerCase().indexOf(q)) {
        const hit = rest.splitText(i);
        rest = hit.splitText(q.length);
        const mark = document.createElement('mark');
        mark.className = 'bs-hit' + (curEl?.contains(hit) ? ' bs-current' : '');
        hit.replaceWith(mark);
        mark.appendChild(hit);
        // The passage, so a match reads as a match from across the pane and
        // never as the passage being played (docs/spec-book-search.md).
        mark.closest('.transcript-chunk')?.classList.add('bs-match');
      }
    }
  }

  private setScope(s: Scope): void {
    this.scope = s;
    for (const r of [...this.el.scope.querySelectorAll('input[type=radio]')] as HTMLInputElement[]) {
      r.checked = r.value === s;
    }
  }

  /** "This chapter" is offered only while a chapter is loaded. */
  private syncScopeOptions(): void {
    const has = this.host.currentChapterIdx() >= 0;
    const opt = this.el.scope.querySelector('input[value=chapter]')?.closest('label') as HTMLElement | null;
    if (opt) opt.hidden = !has;
    if (!has && this.scope === 'chapter') this.setScope('book');
  }

  private run(raw: string): void {
    this.query = raw.trim();
    this.at = -1;
    this.el.nav.hidden = true;
    this.syncScopeOptions();
    this.collect();
    if (this.scope === 'all' && this.query.length >= MIN_QUERY) {
      const missing = this.host.books().map((b) => b.slug).filter((s) => !this.host.transcriptFor(s));
      if (missing.length) this.host.ensureTranscripts(missing, this.onTranscript);
    }
    this.renderList();
    this.applyMarks();
  }

  /** Every match in the scope, in list order: the chapter playing, the rest of
   *  this book in book order, then (All books) the others in library order. */
  private collect(reorigin = true): void {
    this.hits = [];
    const open = this.host.book();
    if (!open || this.query.length < MIN_QUERY) { this.origin = null; return; }
    if (reorigin || !this.origin) this.origin = { slug: open.slug, idx: this.host.currentChapterIdx() };
    const { slug: os, idx: ci } = this.origin;
    const book = os === open.slug ? open : this.host.books().find((b) => b.slug === os) ?? open;
    const others = this.scope === 'all' ? this.host.books().filter((b) => b.slug !== book.slug) : [];
    for (const [rank, b] of [book, ...others].entries()) {
      const bt = this.host.transcriptFor(b.slug);
      if (!bt) continue;
      const groups = searchBooks({
        books: [{ slug: b.slug, title: b.title }],
        transcripts: { [b.slug]: bt },
        query: this.query,
        summaryFor: { [b.slug]: this.host.summaryFor(b.slug) },
      });
      const found: Hit[] = [];
      for (const m of groups[0]?.matches ?? []) {
        const idx = this.host.chapterIdxIn(b.slug, m.chapterIndex);
        if (idx < 0) continue;
        if (this.scope === 'chapter' && (rank > 0 || idx !== ci)) continue;
        found.push({ m, slug: b.slug, idx });
      }
      const first = (h: Hit) => (rank === 0 && h.idx === ci ? 0 : 1);
      found.sort((x, y) => first(x) - first(y) || x.idx - y.idx || x.m.start - y.m.start);
      this.hits.push(...found);
    }
  }

  private renderList(): void {
    const box = this.el.list;
    box.replaceChildren();
    if (this.query.length < MIN_QUERY) { this.el.results.hidden = true; return; }
    if (!this.hits.length) {
      const empty = document.createElement('div');
      empty.className = 'bs-empty';
      const where = this.scope === 'chapter' ? 'this chapter' : this.scope === 'book' ? 'this book' : 'any book';
      empty.textContent = this.scope === 'all' && this.host.loading()
        ? 'No matches yet — still loading transcripts…' : `No matches in ${where}.`;
      box.append(empty);
      this.el.results.hidden = false;
      return;
    }
    const books = new Map(this.host.books().map((b) => [b.slug, b]));
    const open = this.host.book();
    const groups = new Map<string, Hit[]>();
    for (const h of this.hits) {
      const k = `${h.slug}\u0000${h.idx}`;
      groups.set(k, [...(groups.get(k) ?? []), h]);
    }
    for (const hs of groups.values()) {
      const { slug, idx } = hs[0];
      const b = slug === open?.slug ? open : books.get(slug);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'bs-row';
      const title = document.createElement('span');
      title.className = 'bs-row-title';
      title.textContent = b?.chapters[idx]?.title ?? `Chapter ${idx + 1}`;
      const count = document.createElement('span');
      count.className = 'bs-row-count';
      count.textContent = hs.length === 1 ? '1 match' : `${hs.length} matches`;
      row.append(title, count);
      if (slug !== open?.slug) {
        const name = document.createElement('span');
        name.className = 'bs-row-book';
        name.textContent = b?.title ?? slug;
        row.append(name);
      } else if (idx === this.host.currentChapterIdx()) {
        const now = document.createElement('span');
        now.className = 'bs-row-now';
        now.textContent = 'Now playing';
        row.append(now);
      }
      const snip = document.createElement('span');
      snip.className = 'bs-row-snippet';
      this.markInto(snip, hs[0].m.snippet);
      row.append(snip);
      row.addEventListener('click', () => this.go(this.hits.indexOf(hs[0])), { signal: this.ac.signal });
      box.append(row);
    }
    this.el.results.hidden = false;
  }

  /** Text into `el`, with every occurrence of the query wrapped in <mark>. */
  private markInto(el: HTMLElement, text: string): void {
    const q = this.query.toLowerCase();
    const low = text.toLowerCase();
    let from = 0;
    for (let i = low.indexOf(q); i !== -1; i = low.indexOf(q, from)) {
      el.append(text.slice(from, i));
      const m = document.createElement('mark');
      m.textContent = text.slice(i, i + q.length);
      el.append(m);
      from = i + q.length;
    }
    el.append(text.slice(from));
  }

  private showList(): void {
    if (this.query.length < MIN_QUERY) return;
    // Reopened after a pick: the list is ordered from where playback is now.
    if (this.at >= 0 || this.origin?.idx !== this.host.currentChapterIdx()
        || this.origin?.slug !== this.host.book()?.slug) this.refresh({ reorigin: true, show: true });
    this.el.results.hidden = false;
  }

  /** Re-collect and re-list, keeping a picked match picked: its index and the
   *  bar's "k of N" follow it into the new order. */
  private refresh({ reorigin, show }: { reorigin: boolean; show: boolean }): void {
    const keep = this.at >= 0 ? this.hits[this.at] : null;
    this.syncScopeOptions();
    this.collect(reorigin);
    if (keep) {
      this.at = this.hits.findIndex((h) => h.slug === keep.slug && h.idx === keep.idx
        && h.m.chunkIndex === keep.m.chunkIndex);
      if (this.at >= 0) this.el.pos.textContent = `${this.at + 1} of ${this.hits.length}`;
      else this.el.nav.hidden = true;
    }
    this.renderList();
    if (!show) this.el.results.hidden = true;
  }

  /** Enter: the first match in the chapter playing at or after where playback
   *  is, else the next one in the list's order, else the first. */
  private jumpFromHere(): void {
    if (!this.hits.length) return;
    const slug = this.host.book()?.slug, ci = this.host.currentChapterIdx(), t = this.host.currentTime();
    const here = this.hits.findIndex((h) => h.slug === slug && h.idx === ci && h.m.start >= t - 0.05);
    if (here !== -1) { this.go(here); return; }
    const after = this.hits.findIndex((h) => !(h.slug === slug && h.idx === ci));
    this.go(after === -1 ? 0 : after);
  }

  private step(d: number): void {
    if (!this.hits.length) return;
    const n = this.hits.length;
    this.go(((this.at < 0 ? (d > 0 ? -1 : 0) : this.at) + d + n) % n);
  }

  private go(i: number): void {
    const h = this.hits[i];
    if (!h || this.disposed) return;
    this.at = i;
    this.el.results.hidden = true;
    this.el.pos.textContent = `${i + 1} of ${this.hits.length}`;
    this.el.nav.hidden = false;
    this.host.jump(h.slug, h.idx, h.m.start);
    // Same chapter: the transcript is not re-rendered, so mark here. A new
    // chapter re-renders and the engine calls applyMarks after it.
    this.applyMarks();
  }
}
