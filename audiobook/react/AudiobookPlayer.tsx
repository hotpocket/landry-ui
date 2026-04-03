"use client";

import { useRef, useState, useEffect, useCallback } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface Chapter {
  label: string;
  startSeconds: number;
}

interface Book {
  slug: string;
  file: string;
  title: string;
  duration: number;
  chapters: Chapter[];
}

interface TranscriptChunk {
  index: number;
  text: string;
  start: number;
  end: number;
}

interface TranscriptChapter {
  index: number;
  title: string;
  chunks: TranscriptChunk[];
}

interface TranscriptData {
  books: { slug: string; chapters: TranscriptChapter[] }[];
}

interface AudiobookPlayerProps {
  book: Book;
  audioSrc: string;
  transcriptUrl?: string;
  feedbackUrl?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatTime(seconds: number): string {
  if (isNaN(seconds)) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function chapterEnd(
  chapters: Chapter[],
  index: number,
  totalDuration: number
): number {
  return index < chapters.length - 1
    ? chapters[index + 1].startSeconds
    : totalDuration;
}

function getStoredProgress(bookSlug: string) {
  try {
    const val = localStorage.getItem(`rs-progress-${bookSlug}`);
    if (!val) return { time: 0, progress: 0 };
    return JSON.parse(val);
  } catch {
    return { time: 0, progress: 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Feedback helpers                                                  */
/* ------------------------------------------------------------------ */

function getFlaggedChunks(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("rs-flagged-chunks") || "{}");
  } catch {
    return {};
  }
}

function flagKey(
  bookSlug: string,
  chapterIndex: number,
  chunkIndex: number
): string {
  return `${bookSlug}:${chapterIndex}:${chunkIndex}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function AudiobookPlayer({
  book,
  audioSrc,
  transcriptUrl,
  feedbackUrl,
}: AudiobookPlayerProps) {
  const { chapters } = book;
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const chapterListRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activeChapter, setActiveChapter] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Transcript state
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [activeChunkId, setActiveChunkId] = useState(-1);
  const [userScrolledChapters, setUserScrolledChapters] = useState(false);
  const [userScrolledTranscript, setUserScrolledTranscript] = useState(false);

  // Feedback state
  const [flagged, setFlagged] = useState<Record<string, boolean>>(
    getFlaggedChunks
  );

  // Divider drag state
  const [leftPct, setLeftPct] = useState(50);
  const [dividerDragging, setDividerDragging] = useState(false);

  const totalDuration = duration || book.duration;

  // --- Load transcript ---
  useEffect(() => {
    if (!transcriptUrl) return;
    fetch(transcriptUrl)
      .then((r) => r.json())
      .then((data: TranscriptData) => setTranscript(data))
      .catch(() => {});
  }, [transcriptUrl]);

  // --- Restore progress on mount ---
  useEffect(() => {
    const stored = getStoredProgress(book.slug);
    if (stored.time > 0 && audioRef.current) {
      const audio = audioRef.current;
      const onLoaded = () => {
        audio.currentTime = stored.time;
        audio.removeEventListener("loadedmetadata", onLoaded);
      };
      if (audio.readyState >= 1) {
        audio.currentTime = stored.time;
      } else {
        audio.addEventListener("loadedmetadata", onLoaded);
      }
    }
  }, [book.slug]);

  // --- Save progress periodically + on unload ---
  const saveProgress = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const p = audio.currentTime / audio.duration;
    localStorage.setItem(
      `rs-progress-${book.slug}`,
      JSON.stringify({ time: audio.currentTime, progress: p })
    );
  }, [book.slug]);

  useEffect(() => {
    const interval = setInterval(saveProgress, 5000);
    window.addEventListener("beforeunload", saveProgress);
    return () => {
      clearInterval(interval);
      window.removeEventListener("beforeunload", saveProgress);
    };
  }, [saveProgress]);

  // --- Audio event listeners ---
  const updateTime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (audio.currentTime >= chapters[i].startSeconds) {
        setActiveChapter((prev) => {
          if (prev !== i) {
            setUserScrolledChapters(false);
            setUserScrolledTranscript(false);
            setActiveChunkId(-1);
          }
          return i;
        });
        break;
      }
    }
  }, [chapters]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onLoaded = () => setDuration(audio.duration);
    const onEnded = () => {
      setIsPlaying(false);
      saveProgress();
    };
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("timeupdate", updateTime);
      audio.removeEventListener("ended", onEnded);
    };
  }, [updateTime, saveProgress]);

  // --- Playback actions ---
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
    setIsPlaying(!isPlaying);
  };

  const seekTo = async (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.readyState < 1) {
      audio.preload = "metadata";
      audio.load();
      await new Promise<void>((resolve) => {
        audio.addEventListener("loadedmetadata", () => resolve(), {
          once: true,
        });
      });
    }
    audio.currentTime = seconds;
    if (!isPlaying) {
      audio.play();
      setIsPlaying(true);
    }
  };

  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(
      0,
      Math.min(audio.duration || totalDuration, audio.currentTime + delta)
    );
  };

  const prevChapter = () => {
    if (activeChapter === 0) {
      seekTo(0);
    } else {
      seekTo(chapters[activeChapter - 1].startSeconds);
    }
  };

  const nextChapter = () => {
    if (activeChapter < chapters.length - 1) {
      seekTo(chapters[activeChapter + 1].startSeconds);
    }
  };

  // --- Scrubber drag ---
  const seekFromEvent = useCallback(
    (clientX: number) => {
      const audio = audioRef.current;
      const bar = scrubberRef.current;
      if (!audio || !bar || !totalDuration) return;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width)
      );
      audio.currentTime = pct * totalDuration;
      setCurrentTime(pct * totalDuration);
    },
    [totalDuration]
  );

  const onScrubStart = (e: React.MouseEvent) => {
    setIsDragging(true);
    seekFromEvent(e.clientX);
  };

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => seekFromEvent(e.clientX);
    const onUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, seekFromEvent]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const audio = audioRef.current;
      if (!audio || audio.readyState < 1) return;
      if (e.key === "ArrowRight") {
        audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
      } else if (e.key === "ArrowLeft") {
        audio.currentTime = Math.max(0, audio.currentTime - 10);
      } else {
        return;
      }
      e.preventDefault();
      setCurrentTime(audio.currentTime);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- Divider drag ---
  useEffect(() => {
    if (!dividerDragging) return;
    const onMove = (e: MouseEvent) => {
      const area = contentRef.current;
      if (!area) return;
      const rect = area.getBoundingClientRect();
      const pct = Math.max(
        10,
        Math.min(90, ((e.clientX - rect.left) / rect.width) * 100)
      );
      setLeftPct(pct);
    };
    const onUp = () => setDividerDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dividerDragging]);

  // --- Transcript helpers ---
  const bookTranscript = transcript?.books.find((b) => b.slug === book.slug);

  const activeTranscriptChapter = bookTranscript?.chapters.find(
    (c) => c.index === activeChapter + 1
  );

  // Find active chunk from current time
  const chapterStart = chapters[activeChapter]?.startSeconds ?? 0;
  const timeInChapter = currentTime - chapterStart;
  let currentChunkIndex = -1;
  if (activeTranscriptChapter) {
    for (const chunk of activeTranscriptChapter.chunks) {
      if (timeInChapter >= chunk.start && timeInChapter < chunk.end) {
        currentChunkIndex = chunk.index;
        break;
      }
    }
  }

  // Update active chunk + auto-scroll transcript
  useEffect(() => {
    if (currentChunkIndex === activeChunkId) return;
    setActiveChunkId(currentChunkIndex);

    if (!userScrolledTranscript && transcriptRef.current && currentChunkIndex >= 0) {
      const el = transcriptRef.current.querySelector(
        `[data-chunk="${currentChunkIndex}"]`
      );
      if (el) {
        const container = transcriptRef.current;
        const elTop =
          (el as HTMLElement).offsetTop - container.offsetTop;
        container.scrollTop = elTop - container.clientHeight / 3;
      }
    }
  }, [currentChunkIndex, activeChunkId, userScrolledTranscript]);

  // Auto-scroll chapter list
  useEffect(() => {
    if (userScrolledChapters || !chapterListRef.current) return;
    const el = chapterListRef.current.querySelector(
      `[data-chapter="${activeChapter}"]`
    );
    if (el) {
      const container = chapterListRef.current;
      const elTop = (el as HTMLElement).offsetTop - container.offsetTop;
      const elH = (el as HTMLElement).offsetHeight;
      const visible =
        elTop >= container.scrollTop &&
        elTop + elH <= container.scrollTop + container.clientHeight;
      if (!visible) {
        container.scrollTop = elTop - container.clientHeight / 3;
      }
    }
  }, [activeChapter, userScrolledChapters]);

  // --- Feedback ---
  const toggleFlag = (chapterIndex: number, chunk: TranscriptChunk) => {
    const key = flagKey(book.slug, chapterIndex, chunk.index);
    const next = { ...flagged };
    if (next[key]) {
      delete next[key];
    } else {
      next[key] = true;
      if (feedbackUrl) {
        fetch(feedbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: "repo-story",
            type: "transcription-error",
            context: {
              bookSlug: book.slug,
              chapterIndex,
              chunkIndex: chunk.index,
              chunkText: chunk.text,
              timestamp: chapterStart + chunk.start,
            },
          }),
        }).catch(() => {});
      }
    }
    setFlagged(next);
    localStorage.setItem("rs-flagged-chunks", JSON.stringify(next));
  };

  // --- Render ---
  const progress = totalDuration ? (currentTime / totalDuration) * 100 : 0;

  return (
    <div className="bg-[#0f0f0f] border border-gray-800 rounded-lg flex flex-col h-[600px]">
      <audio ref={audioRef} preload="metadata" src={audioSrc} />

      {/* Now playing */}
      <div className="px-6 pt-5 pb-3 flex-shrink-0">
        <p className="text-white text-sm font-medium truncate">
          {isPlaying || currentTime > 0
            ? chapters[activeChapter]?.label
            : book.title}
        </p>
        <p className="text-gray-500 text-xs">
          {chapters.length} chapters &middot; {formatTime(totalDuration)}
        </p>
      </div>

      {/* Content area: chapters + transcript */}
      <div ref={contentRef} className="flex flex-1 min-h-0 mx-2">
        {/* Chapter list */}
        <div
          className="flex flex-col min-w-[80px] overflow-hidden"
          style={{ flex: `0 0 ${leftPct}%` }}
        >
          <p className="text-[10px] uppercase tracking-widest text-gray-600 px-3 py-1.5">
            Chapters
          </p>
          <div
            ref={chapterListRef}
            className="flex-1 overflow-y-auto space-y-0.5 scrollbar-thin"
            onWheel={() => setUserScrolledChapters(true)}
          >
            {chapters.map((ch, i) => {
              const end = chapterEnd(chapters, i, totalDuration);
              const chDur = end - ch.startSeconds;
              const isActive = i === activeChapter;
              let chPct = 0;
              if (isActive && chDur > 0) {
                chPct = Math.max(
                  0,
                  Math.min(
                    100,
                    ((currentTime - ch.startSeconds) / chDur) * 100
                  )
                );
              }
              return (
                <button
                  key={ch.label}
                  data-chapter={i}
                  onClick={() => seekTo(ch.startSeconds)}
                  className={`relative w-full flex items-center justify-between px-3 py-2 rounded text-left text-sm transition-colors select-none overflow-hidden ${
                    isActive
                      ? "text-blue-400"
                      : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                  }`}
                >
                  {isActive && (
                    <div
                      className="absolute inset-y-0 left-0 bg-blue-500/15 pointer-events-none"
                      style={{ width: `${chPct}%` }}
                    />
                  )}
                  <span className="flex items-center gap-2 min-w-0 relative z-10">
                    <span className="text-gray-600 text-xs w-4 text-right flex-shrink-0">
                      {i + 1}
                    </span>
                    <span className="truncate">{ch.label}</span>
                  </span>
                  <span className="text-gray-600 text-xs tabular-nums flex-shrink-0 ml-2 relative z-10">
                    {formatTime(chDur)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Draggable divider */}
        <div
          ref={dividerRef}
          className={`w-[5px] flex-shrink-0 cursor-col-resize transition-colors ${
            dividerDragging ? "bg-blue-500" : "bg-gray-800 hover:bg-blue-500"
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            setDividerDragging(true);
          }}
        />

        {/* Transcript */}
        <div
          className="flex flex-col min-w-[80px] overflow-hidden"
          style={{ flex: `0 0 calc(${100 - leftPct}% - 5px)` }}
        >
          <p className="text-[10px] uppercase tracking-widest text-gray-600 px-3 py-1.5">
            Transcript
          </p>
          <div
            ref={transcriptRef}
            className="flex-1 overflow-y-auto px-1 scrollbar-thin"
            onWheel={() => setUserScrolledTranscript(true)}
          >
            {activeTranscriptChapter ? (
              activeTranscriptChapter.chunks.map((chunk) => {
                const isChunkActive = chunk.index === activeChunkId;
                const key = flagKey(
                  book.slug,
                  activeChapter + 1,
                  chunk.index
                );
                const isFlagged = !!flagged[key];
                return (
                  <div
                    key={chunk.index}
                    data-chunk={chunk.index}
                    className={`group flex items-start gap-2 px-3 py-2 rounded cursor-pointer transition-colors ${
                      isChunkActive
                        ? "bg-blue-500/10"
                        : "hover:bg-white/5"
                    }`}
                    onClick={() =>
                      seekTo(chapterStart + chunk.start)
                    }
                  >
                    <span
                      className={`text-sm leading-relaxed flex-1 ${
                        isChunkActive
                          ? "text-gray-200"
                          : "text-gray-500"
                      }`}
                    >
                      {chunk.text}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFlag(activeChapter + 1, chunk);
                      }}
                      className={`flex-shrink-0 text-sm px-1 rounded transition-opacity ${
                        isFlagged
                          ? "text-red-500 opacity-100"
                          : "text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-500"
                      }`}
                      title="Flag transcription error"
                    >
                      &#x26A0;
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="text-gray-600 text-sm px-3 py-2">
                {transcriptUrl
                  ? "Loading transcript..."
                  : "No transcript available"}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Player controls */}
      <div className="px-6 pt-3 pb-4 flex-shrink-0 border-t border-gray-800">
        {/* Time display */}
        <div className="flex justify-between text-xs text-gray-600 mb-1.5">
          <span className="tabular-nums">{formatTime(currentTime)}</span>
          <span className="tabular-nums">{formatTime(totalDuration)}</span>
        </div>

        {/* Scrubber */}
        <div
          ref={scrubberRef}
          className="relative h-5 cursor-pointer group flex items-center mb-2"
          onMouseDown={onScrubStart}
        >
          <div className="absolute inset-x-0 h-1.5 bg-gray-700 rounded-full">
            <div
              className="h-1.5 bg-blue-500 rounded-full"
              style={{
                width: `${progress}%`,
                transition: isDragging ? "none" : "width 150ms",
              }}
            />
          </div>
          {chapters.slice(1).map((ch) => (
            <div
              key={ch.label}
              className="absolute top-0 bottom-0 flex items-center"
              style={{
                left: `${(ch.startSeconds / totalDuration) * 100}%`,
              }}
            >
              <div className="w-px h-3 bg-gray-500/50 group-hover:bg-gray-400/70 transition-colors" />
            </div>
          ))}
          <div
            className="absolute w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none -translate-x-1/2"
            style={{ left: `${progress}%` }}
          />
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-center gap-5">
          <button
            onClick={() => skip(-30)}
            className="text-gray-400 hover:text-white text-sm transition-colors"
          >
            -30s
          </button>
          <button
            onClick={prevChapter}
            className="text-gray-400 hover:text-white text-lg transition-colors"
          >
            &laquo;
          </button>
          <button
            onClick={togglePlay}
            className="w-10 h-10 rounded-full bg-blue-500 hover:bg-blue-400 flex items-center justify-center text-white text-lg flex-shrink-0 transition-colors"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? "\u275A\u275A" : "\u25B6"}
          </button>
          <button
            onClick={nextChapter}
            className="text-gray-400 hover:text-white text-lg transition-colors"
          >
            &raquo;
          </button>
          <button
            onClick={() => skip(30)}
            className="text-gray-400 hover:text-white text-sm transition-colors"
          >
            +30s
          </button>
        </div>
      </div>
    </div>
  );
}
