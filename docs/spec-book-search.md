# Book search — spec

Brandon, 2026-10-10, by voice: a search at the top of the book page that searches
the open book's transcript, lists the chapters that match, and on a pick jumps
to the matching part of the transcript; with multiple matches, a way to step to
the next one. A per-chapter search was considered and dropped ("scratch the
chapter search for now").

Brandon, 2026-10-20: search should match first within the chapter playing,
then within the other chapters of the book, then in other books; three radio
options choose how far it reaches; and the current chapter must stay readable
while results cover the chapter list.

## Elements

- **Search box** — top of the book page (player view), above the chapters and
  transcript. Placeholder "Search this book…". Hidden in reading mode, which
  drops all chrome.
- **Now playing line** — "Now playing: <chapter title>", directly under the
  search box and above the chapter list, in normal view. It sits above where
  the results list drops, so the current chapter stays readable while the list
  covers the chapters. Not shown where the player's own header already names the
  chapter, nor in reading mode (which has its own chapter label).
- **Scope** — three radio options at the top of the results list: This chapter,
  This book, All books. "This chapter" is offered only while a chapter is
  loaded. Default: This chapter (Brandon, 2026-10-20), or This book while no
  chapter is loaded. The choice holds until
  the book is closed.
- **Results list** — opens under the box while typing. One row per chapter that
  matches, in this order: the chapter playing first, then the book's other
  chapters in book order, then (All books) other books in library order, each
  other-book row naming its book. A row shows the chapter's title, how many
  passages match, and a snippet of the first with the term marked. The playing
  chapter's row is labelled "Now playing". Other books' transcripts load as
  needed and their rows appear as each lands. Nothing for a query under two
  characters (the library search's MIN_QUERY). An empty result says so.
- **Match bar** — replaces the list once a match is picked: "3 of 17", previous,
  next, close. Counts passages, not occurrences: a passage is the smallest thing
  that can be jumped to (same rule as library search).
- **Marks in the transcript** — every occurrence of the term in the chapter on
  screen is marked; the occurrences in the current match's passage are marked
  more strongly. Marks are a bright orange-yellow, not a muddy tint (Brandon,
  2026-10-20).
- **Matching passages** — a passage that holds a match carries a dashed outline
  and a very slight background change, so matches read as matches. They must
  never look like the passage being played: that one alone keeps the solid
  blue, and there is only ever one (Brandon, 2026-10-20: several highlighted
  passages made the playing one confusing).

## Behaviour

- Picking a chapter row jumps to that chapter's first match; a row in another
  book opens that book there. Enter in the box jumps to the first match in the
  playing chapter at or after where playback is, else the next match in the
  list's order (wrapping to the first).
- A jump moves playback to the start of the matching passage (Brandon did not
  object to the recommendation, 2026-10-10), keeps playing if it was playing and
  stays paused if it was paused, and re-arms Follow so the passage is shown.
- Next / previous step through every match in the chosen scope, in the list's
  order, crossing chapters (and books, under All books), and wrap at the ends.
- Close (✕, Escape, or emptying the box) removes the bar, the list and the marks.
- Searching fetches no audio; only a jump does, and only for the chapter jumped to.
- In summary mode the summary text is searched, since that is what is on screen.

## Gaps (not decided — ask before building)

- Search-as-you-type vs on Enter: built as you type (the scan is ~10 ms).
- Whether the match bar should survive leaving and reopening the book: it does
  not.
