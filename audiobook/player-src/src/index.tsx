/**
 * index.tsx — the public entry point, unchanged in shape from the vanilla
 * player: `RepoStoryPlayer.init(opts)`.
 *
 * Hosts pass values and callbacks; nothing about Preact crosses this boundary,
 * which is what lets books.landry.bot stay vanilla with no toolchain of its own.
 */

import { render, createRef } from 'preact';
import { Shell, type ShellRefs } from './view/Shell.tsx';
import { PlayerEngine } from './engine/player.ts';

export interface PlayerChrome {
  back?: boolean;
  nowPlaying?: boolean;
  libraryHeading?: boolean;
}

/** One entry in a host-supplied per-book menu. Values and callbacks only. */
export interface BookAction {
  id: string;
  label: string;
  onSelect: (book: unknown) => void;
}

export interface PlayerOptions {
  container: HTMLElement;
  books: unknown[];
  tree?: unknown;
  audioBaseUrl?: string;
  transcriptUrl?: string;
  feedbackUrl?: string;
  title?: string;
  embedded?: boolean;
  autoOpenLast?: boolean;
  scenePauseMs?: number;
  onAuthRefresh?: () => void | Promise<void>;
  chrome?: PlayerChrome;
  /** Absent means no menu is rendered at all — a static host cannot show one. */
  bookActions?: BookAction[];
}

function makeRefs(): ShellRefs {
  const keys = [
    'library', 'bookList', 'searchInput', 'searchResults', 'searchSpinner', 'playerView', 'readingProgress', 'readingProgressFill', 'backBtn', 'nowPlaying', 'bookTitle',
    'chapterTitle', 'chapterList', 'divider', 'contentArea', 'chapterPanel',
    'transcriptPanel', 'readingChapter', 'modeToggle', 'modeFull', 'modeSummary',
    'miniPrev', 'miniPlay', 'miniNext', 'tsDec', 'tsInc', 'followBtn',
    'readingBtn', 'transcriptChunks', 'currentTime', 'totalTime', 'trackBar',
    'progress', 'back30', 'prevBtn', 'playBtn', 'nextBtn', 'fwd30', 'speedBtn',
  ] as const;
  const refs = {} as Record<string, unknown>;
  for (const k of keys) refs[k] = createRef();
  return refs as unknown as ShellRefs;
}

function init(opts: PlayerOptions): void {
  const chrome = opts.chrome ?? {};

  // Marked on the container rather than on #player-view, because the library is
  // a sibling of the player view and needs to respond to embedding too.
  opts.container.classList.toggle('player-embedded-host', !!opts.embedded);
  opts.container.classList.toggle('player-no-library-heading', chrome.libraryHeading === false);

  const refs = makeRefs();
  render(
    <Shell
      title={opts.title ?? 'audiobook'}
      hideBackButton={chrome.back === false}
      hideNowPlaying={chrome.nowPlaying === false}
      refs={refs}
    />,
    opts.container,
  );

  // feedback.js is a separate artifact loaded by the host page; a site that
  // does not include it simply has no feedback link.
  const feedback = (globalThis as { RepoStoryFeedback?: { init: (url?: string) => void } })
    .RepoStoryFeedback;
  feedback?.init(opts.feedbackUrl);

  const engine = new PlayerEngine(opts, refs, localStorage);
  engine.start();
}

// Named, not default: esbuild's globalName would otherwise expose the API as
// RepoStoryPlayer.default.init and silently break every host.
export { init };
