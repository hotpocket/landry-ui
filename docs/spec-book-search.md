# Book search — spec

Brandon, 2026-10-10, by voice: a search at the top of the book page that searches
the open book's transcript, lists the chapters that match, and on a pick jumps
to the matching part of the transcript; with multiple matches, a way to step to
the next one. A per-chapter search was considered and dropped ("scratch the
chapter search for now").

## Elements

- **Search box** — top of the book page (player view), above the chapters and
  transcript. Placeholder "Search this book…". Hidden in reading mode, which
  drops all chrome.
- **Results list** — opens under the box while typing. One row per chapter that
  matches, in book order: the chapter's title, how many passages match, and a
  snippet of the first with the term marked. Nothing for a query under two
  characters (the library search's MIN_QUERY). An empty result says so.
- **Match bar** — replaces the list once a match is picked: "3 of 17", previous,
  next, close. Counts passages, not occurrences: a passage is the smallest thing
  that can be jumped to (same rule as library search).
- **Marks in the transcript** — every occurrence of the term in the chapter on
  screen is marked; the occurrences in the current match's passage are marked
  more strongly.

## Behaviour

- Picking a chapter row jumps to that chapter's first match. Enter in the box
  jumps to the first match at or after where playback is (wrapping to the first).
- A jump moves playback to the start of the matching passage (Brandon did not
  object to the recommendation, 2026-10-10), keeps playing if it was playing and
  stays paused if it was paused, and re-arms Follow so the passage is shown.
- Next / previous step through every match in the book in order, crossing
  chapters, and wrap at the ends.
- Close (✕, Escape, or emptying the box) removes the bar, the list and the marks.
- Searching fetches no audio; only a jump does, and only for the chapter jumped to.
- In summary mode the summary text is searched, since that is what is on screen.

## Gaps (not decided — ask before building)

- Search-as-you-type vs on Enter: built as you type (the scan is ~10 ms).
- Whether the match bar should survive leaving and reopening the book: it does
  not.
