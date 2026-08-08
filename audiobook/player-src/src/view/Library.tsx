/**
 * Library.tsx — the book list, flat or nested.
 *
 * Nested when the payload carries a tree, flat otherwise. karagame and
 * brandonlandry.com send no tree at all and must keep rendering exactly as they
 * did, so the flat array stays the fallback rather than a legacy path.
 *
 * The per-book menu is the one deliberate seam for hosts. It is absent unless
 * the host passes `bookActions`, so a static site cannot render a menu whose
 * every action would 404. Items cross the boundary as values and callbacks —
 * never as components — which is what lets books.landry.bot supply a menu while
 * staying vanilla with no toolchain.
 */

import type { BookAction } from '../index.tsx';

export interface LibraryBook {
  book_id?: string;
  slug?: string;
  title?: string;
  description?: string;
  duration: number;
  chapters: unknown[];
}

export interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
  books?: LibraryBook[];
}

export interface LibraryProps {
  books: LibraryBook[];
  tree?: TreeNode | null;
  formatTime: (s: number) => string;
  progressStatus: (bookIdx: number) => '' | 'in-progress' | 'complete';
  offlineState: Record<number, 'downloading' | 'downloaded' | 'error' | undefined>;
  onOpen: (bookIdx: number) => void;
  onDownload: (bookIdx: number) => void;
  bookActions?: BookAction[];
  openMenuFor: number | null;
  onToggleMenu: (bookIdx: number | null) => void;
}

/**
 * The flat books array is the index space for progress and routing, so a book
 * rendered from the tree has to resolve back to its position in it. Identity
 * comparison is not enough: tree and books arrive as separate JSON objects
 * describing the same book.
 */
export function bookIndex(books: LibraryBook[], book: LibraryBook): number {
  const key = book.book_id ?? book.slug;
  return books.findIndex((b) => (b.book_id ?? b.slug) === key);
}

function hasContent(tree: TreeNode | null | undefined): boolean {
  return !!tree && ((tree.children?.length ?? 0) > 0 || (tree.books?.length ?? 0) > 0);
}

export function Library(props: LibraryProps) {
  return hasContent(props.tree)
    ? <TreeLevel node={props.tree!} {...props} />
    : <>{props.books.map((b, i) => <BookItem key={i} book={b} idx={i} {...props} />)}</>;
}

function TreeLevel({ node, ...props }: { node: TreeNode } & LibraryProps) {
  return (
    <>
      {(node.books ?? []).map((book) => {
        const idx = bookIndex(props.books, book);
        return idx >= 0
          ? <BookItem key={idx} book={props.books[idx]} idx={idx} {...props} />
          : null;
      })}
      {(node.children ?? []).map((child) => (
        <div class="lib-group" data-path={child.path} key={child.path}>
          <div class="lib-group-name">{child.name}</div>
          <div class="lib-group-body">
            <TreeLevel node={child} {...props} />
          </div>
        </div>
      ))}
    </>
  );
}

function BookItem({ book, idx, ...p }: { book: LibraryBook; idx: number } & LibraryProps) {
  const offline = p.offlineState[idx];
  const dlLabel = offline === 'downloaded' ? 'Downloaded ✓'
    : offline === 'downloading' ? 'Preparing…'
    : offline === 'error' ? 'Failed — retry ↻'
    : 'Download ⇣';
  const menuOpen = p.openMenuFor === idx;

  return (
    <div class="book-item">
      <div
        style="flex: 1; cursor: pointer"
        onClick={() => p.onOpen(idx)}
      >
        <div class="title">{book.title}</div>
        <div class="meta">
          {book.chapters.length} chapters &middot; {p.formatTime(book.duration)}
        </div>
        {book.description ? <div class="book-desc">{book.description}</div> : null}
      </div>
      <div class="book-actions">
        <button
          class={'dl-btn' + (offline ? ' ' + offline : '')}
          title={offline === 'downloaded' ? 'Available offline'
            : offline === 'error' ? 'Download failed — tap to retry'
            : 'Download all chapters for offline'}
          onClick={(e) => {
            e.stopPropagation();
            // 'error' stays clickable: the failed state IS the retry button.
            if (offline === 'downloading' || offline === 'downloaded') return;
            p.onDownload(idx);
          }}
          dangerouslySetInnerHTML={{ __html: dlLabel }}
        />
        {p.bookActions?.length ? (
          <div class="book-menu">
            <button
              class="book-menu-btn"
              id={`book-menu-btn-${idx}`}
              title="More"
              aria-haspopup="menu"
              aria-expanded={menuOpen ? 'true' : 'false'}
              onClick={(e) => {
                e.stopPropagation();
                p.onToggleMenu(menuOpen ? null : idx);
              }}
            >
              &#8943;
            </button>
            {menuOpen ? (
              <div class="book-menu-items" role="menu">
                {p.bookActions.map((a) => (
                  <button
                    class="book-menu-item"
                    role="menuitem"
                    key={a.id}
                    data-action={a.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onToggleMenu(null);
                      a.onSelect(book);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div class={'progress-dot ' + p.progressStatus(idx)} />
      </div>
    </div>
  );
}
