/**
 * Shell.tsx — the player's DOM contract.
 *
 * Every id and class here is asserted by the Playwright suites, and by three
 * host stylesheets. The port reproduces the structure exactly: this is the
 * parity bar, so idiomatic-but-different markup would be a regression even
 * where it looked better.
 *
 * Preact owns structure only. The 60 fps updates — progress widths, active
 * chunk classes, the clock — stay imperative through refs, because re-rendering
 * a component tree every frame to move one CSS width is the wrong tool, not a
 * concession.
 */

import type { RefObject } from 'preact';

export interface ShellProps {
  title: string;
  hideBackButton: boolean;
  hideNowPlaying: boolean;
  refs: ShellRefs;
}

/** Every node the engine mutates directly, collected in one place. */
export interface ShellRefs {
  library: RefObject<HTMLDivElement>;
  bookList: RefObject<HTMLDivElement>;
  playerView: RefObject<HTMLDivElement>;
  readingProgress: RefObject<HTMLDivElement>;
  readingProgressFill: RefObject<HTMLDivElement>;
  backBtn: RefObject<HTMLButtonElement>;
  nowPlaying: RefObject<HTMLDivElement>;
  bookTitle: RefObject<HTMLDivElement>;
  chapterTitle: RefObject<HTMLDivElement>;
  chapterList: RefObject<HTMLUListElement>;
  divider: RefObject<HTMLDivElement>;
  contentArea: RefObject<HTMLDivElement>;
  chapterPanel: RefObject<HTMLDivElement>;
  transcriptPanel: RefObject<HTMLDivElement>;
  readingChapter: RefObject<HTMLDivElement>;
  modeToggle: RefObject<HTMLSpanElement>;
  modeFull: RefObject<HTMLButtonElement>;
  modeSummary: RefObject<HTMLButtonElement>;
  miniPrev: RefObject<HTMLButtonElement>;
  miniPlay: RefObject<HTMLButtonElement>;
  miniNext: RefObject<HTMLButtonElement>;
  tsDec: RefObject<HTMLButtonElement>;
  tsInc: RefObject<HTMLButtonElement>;
  followBtn: RefObject<HTMLButtonElement>;
  readingBtn: RefObject<HTMLButtonElement>;
  transcriptChunks: RefObject<HTMLDivElement>;
  currentTime: RefObject<HTMLSpanElement>;
  totalTime: RefObject<HTMLSpanElement>;
  trackBar: RefObject<HTMLDivElement>;
  progress: RefObject<HTMLDivElement>;
  back30: RefObject<HTMLButtonElement>;
  prevBtn: RefObject<HTMLButtonElement>;
  playBtn: RefObject<HTMLButtonElement>;
  nextBtn: RefObject<HTMLButtonElement>;
  fwd30: RefObject<HTMLButtonElement>;
  speedBtn: RefObject<HTMLButtonElement>;
}

export function Shell({ title, hideBackButton, hideNowPlaying, refs }: ShellProps) {
  return (
    <>
      <div class="library" id="library" ref={refs.library}>
        <h1>{title}</h1>
        <div class="book-list" id="book-list" ref={refs.bookList} />
      </div>
      <div class="player-view" id="player-view" ref={refs.playerView}>
        {/* Reading mode hides the transport, the track bar and the chapter
            list, and every indication of position goes with them. This says
            how far through the CURRENT CHAPTER playback is — the unit a reader
            is actually in — without giving the chrome back. Hidden by CSS
            outside reading mode. */}
        <div class="reading-progress" id="reading-progress" ref={refs.readingProgress}>
          <div class="reading-progress-fill" id="reading-progress-fill" ref={refs.readingProgressFill} />
        </div>
        <button
          class="back-btn"
          id="back-btn"
          ref={refs.backBtn}
          style={hideBackButton ? 'display:none' : undefined}
        >
          &larr; Library
        </button>
        <div
          class="now-playing"
          ref={refs.nowPlaying}
          style={hideNowPlaying ? 'display:none' : undefined}
        >
          <div class="book-title" id="book-title" ref={refs.bookTitle} />
          <div class="chapter-title" id="chapter-title" ref={refs.chapterTitle} />
        </div>
        <div class="content-area" ref={refs.contentArea}>
          <div class="chapter-panel" style="flex: 0 0 50%" ref={refs.chapterPanel}>
            <div class="chapter-panel-header">
              <h3>Chapters</h3>
            </div>
            <ul class="chapter-list" id="chapter-list" ref={refs.chapterList} />
          </div>
          <div class="panel-divider" ref={refs.divider} />
          <div
            class="transcript-panel"
            style="flex: 0 0 calc(50% - 5px)"
            ref={refs.transcriptPanel}
          >
            {/* Reading mode only. The chapter list normally says which chapter
                this is, and reading mode hides it — so the label moves here,
                above the row whose buttons change it. */}
            <div class="reading-chapter" id="reading-chapter" ref={refs.readingChapter} />
            <div class="transcript-panel-header">
              <h3>Transcript</h3>
              <span class="mode-toggle" id="mode-toggle" style="display:none" ref={refs.modeToggle}>
                <button class="mode-btn" id="mode-full" title="Full chapter audio + transcript" ref={refs.modeFull}>
                  Full
                </button>
                <button class="mode-btn" id="mode-summary" title="Condensed summary audio + transcript" ref={refs.modeSummary}>
                  Summary
                </button>
              </span>
              <span class="th-spacer" />
              {/* Reading mode drops the transport and the chapter list, which
                  between them were the only ways to change chapter — so
                  prev/next join the one row that survives. */}
              <button class="mini-nav-btn" id="mini-prev-btn" title="Previous chapter" ref={refs.miniPrev}>
                &laquo;
              </button>
              <button class="mini-play-btn" id="mini-play-btn" title="Play/pause" ref={refs.miniPlay}>
                &#9654;
              </button>
              <button class="mini-nav-btn mini-next" id="mini-next-btn" title="Next chapter" ref={refs.miniNext}>
                &raquo;
              </button>
              <button class="ts-btn ts-dec" id="ts-dec" title="Smaller text" ref={refs.tsDec}>
                A&#8722;
              </button>
              <button class="ts-btn ts-inc" id="ts-inc" title="Larger text" ref={refs.tsInc}>
                A+
              </button>
              <button class="follow-btn" id="follow-btn" title="Follow along with playback" ref={refs.followBtn}>
                &#8982; follow
              </button>
              <button class="reading-btn" id="reading-btn" title="Reading mode — transcript only" ref={refs.readingBtn}>
                &#9707; read
              </button>
            </div>
            <div class="transcript-chunks" id="transcript-chunks" ref={refs.transcriptChunks} />
          </div>
        </div>
        <div class="player-controls">
          <div class="time-display">
            <span id="current-time" ref={refs.currentTime}>0:00</span>
            <span id="total-time" ref={refs.totalTime}>0:00</span>
          </div>
          <div class="track-bar" id="track-bar" ref={refs.trackBar}>
            <div class="progress" id="progress" ref={refs.progress} />
          </div>
          <div class="controls">
            <button id="btn-back30" ref={refs.back30}>-30s</button>
            <button id="btn-prev" ref={refs.prevBtn}>&laquo;</button>
            <button class="play-btn" id="play-btn" ref={refs.playBtn}>&#9654;</button>
            <button id="btn-next" ref={refs.nextBtn}>&raquo;</button>
            <button id="btn-fwd30" ref={refs.fwd30}>+30s</button>
            <button class="speed-btn" id="speed-btn" ref={refs.speedBtn}>1x</button>
          </div>
        </div>
      </div>
    </>
  );
}
