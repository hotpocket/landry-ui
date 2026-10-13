/**
 * book-search.ts — searching inside the open book (docs/spec-book-search.md).
 *
 * The open book's transcript is already in memory, so this is the library
 * search's scan (../core/search.ts) over one book, plus the parts only an open
 * book has: a list of chapters that match, a bar that steps through every match
 * in the book, and marks on the term in the transcript on screen.
 *
 * It never fetches audio. A jump does, through the engine, and only for the
 * chapter jumped to.
 */

import { MIN_QUERY, searchBooks, type SearchMatch } from '../core/search.ts';
import type { BookTranscript } from '../core/transcript.ts';

export interface BookSearchHost {
  book(): { slug?: string; title?: string; chapters: { title?: string }[] } | null;
  transcript(): BookTranscript | null;
  summary(): boolean;
  /** The book chapter (position) a transcript chapter index belongs to, or -1. */
  chapterIdxFor(transcriptIndex: number): number;
  currentChapterIdx(): number;
  currentTime(): number;
  /** Move playback to `t` in chapter `idx`, keeping play/pause, and show it. */
  jump(idx: number, t: number): void;
  /** The transcript pane's chunk container. */
  chunks(): HTMLElement | null;
}

export interface BookSearchEls {
  input: HTMLInputElement;
  results: HTMLElement;
  nav: HTMLElement;
  pos: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  close: HTMLButtonElement;
}

interface Hit { m: SearchMatch; idx: number }

export class BookSearch {
  private host: BookSearchHost;
  private el: BookSearchEls;
  private query = '';
  private hits: Hit[] = [];
  private at = -1;

  constructor(host: BookSearchHost, el: BookSearchEls) {
    this.host = host;
    this.el = el;
    el.input.addEventListener('input', () => this.run(el.input.value));
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.jumpFromHere(); }
      if (e.key === 'Escape') { e.preventDefault(); this.reset(); el.input.blur(); }
    });
    el.input.addEventListener('focus', () => { if (this.hits.length && this.at < 0) this.showList(); });
    el.prev.addEventListener('click', () => this.step(-1));
    el.next.addEventListener('click', () => this.step(1));
    el.close.addEventListener('click', () => this.reset());
    // A tap elsewhere closes the list; the bar stays until closed.
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node | null;
      if (!el.results.hidden && t && !el.results.contains(t) && t !== el.input) el.results.hidden = true;
    });
  }

  /** Clear everything: the box, the list, the bar and the marks. */
  reset(): void {
    this.query = '';
    this.hits = [];
    this.at = -1;
    this.el.input.value = '';
    this.el.results.hidden = true;
    this.el.results.replaceChildren();
    this.el.nav.hidden = true;
    this.applyMarks();
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
    const q = this.query.toLowerCase();
    if (q.length < MIN_QUERY) return;
    const cur = this.at >= 0 ? this.hits[this.at] : null;
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
      }
    }
  }

  private run(raw: string): void {
    this.query = raw.trim();
    this.at = -1;
    this.el.nav.hidden = true;
    const book = this.host.book();
    const bt = this.host.transcript();
    this.hits = [];
    if (book?.slug && bt && this.query.length >= MIN_QUERY) {
      const groups = searchBooks({
        books: [{ slug: book.slug, title: book.title }],
        transcripts: { [book.slug]: bt },
        query: this.query,
        summaryFor: { [book.slug]: this.host.summary() },
      });
      for (const m of groups[0]?.matches ?? []) {
        const idx = this.host.chapterIdxFor(m.chapterIndex);
        if (idx >= 0) this.hits.push({ m, idx });
      }
      this.hits.sort((a, b) => a.idx - b.idx || a.m.start - b.m.start);
    }
    this.renderList();
    this.applyMarks();
  }

  private renderList(): void {
    const box = this.el.results;
    box.replaceChildren();
    if (this.query.length < MIN_QUERY) { box.hidden = true; return; }
    const book = this.host.book();
    if (!this.hits.length) {
      const empty = document.createElement('div');
      empty.className = 'bs-empty';
      empty.textContent = 'No matches in this book.';
      box.append(empty);
      box.hidden = false;
      return;
    }
    const byChapter = new Map<number, Hit[]>();
    for (const h of this.hits) byChapter.set(h.idx, [...(byChapter.get(h.idx) ?? []), h]);
    for (const [idx, hs] of byChapter) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'bs-row';
      const title = document.createElement('span');
      title.className = 'bs-row-title';
      title.textContent = book?.chapters[idx]?.title ?? `Chapter ${idx + 1}`;
      const count = document.createElement('span');
      count.className = 'bs-row-count';
      count.textContent = hs.length === 1 ? '1 match' : `${hs.length} matches`;
      const snip = document.createElement('span');
      snip.className = 'bs-row-snippet';
      this.markInto(snip, hs[0].m.snippet);
      row.append(title, count, snip);
      row.addEventListener('click', () => this.go(this.hits.indexOf(hs[0])));
      box.append(row);
    }
    box.hidden = false;
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
    if (this.query.length >= MIN_QUERY) this.el.results.hidden = false;
  }

  /** Enter: the first match at or after where playback is, else the first. */
  private jumpFromHere(): void {
    if (!this.hits.length) return;
    const ci = this.host.currentChapterIdx(), t = this.host.currentTime();
    const i = this.hits.findIndex((h) => h.idx > ci || (h.idx === ci && h.m.start >= t - 0.05));
    this.go(i === -1 ? 0 : i);
  }

  private step(d: number): void {
    if (!this.hits.length) return;
    const n = this.hits.length;
    this.go(((this.at < 0 ? (d > 0 ? -1 : 0) : this.at) + d + n) % n);
  }

  private go(i: number): void {
    const h = this.hits[i];
    if (!h) return;
    this.at = i;
    this.el.results.hidden = true;
    this.el.pos.textContent = `${i + 1} of ${this.hits.length}`;
    this.el.nav.hidden = false;
    this.host.jump(h.idx, h.m.start);
    // Same chapter: the transcript is not re-rendered, so mark here. A new
    // chapter re-renders and the engine calls applyMarks after it.
    this.applyMarks();
  }
}
