# The chapter list — what it is, and every state it is allowed to be in

**Status:** v1.1, 2026-08-26. Written because books.landry.bot's `docs/ui-spec-v1.md`
describes the player from the outside only and names that as an open question:

> **This document has not been checked against the player's own interior.**
> §§9.2 and 11 describe what the player presents where the shell meets it; the
> transport, chapter list and transcript are described from the outside only.

This document closes that gap for the chapter list, and only for the chapter
list. The transport and the transcript remain undescribed.

**Register.** Same as `ui-spec-v1.md`: this says what you *see* and what each
thing is *for*. It names no selectors, properties or functions. A description
written in the implementation's own vocabulary agrees with the implementation by
construction and cannot be used to judge it.

**What it is for.** The reference against which the chapter list is judged
correct or incorrect. **A state on screen that is not described here is a
finding** — a defect, or a hole in this document. Both need a decision; neither
may be waved through.

**Revision.** v1.1, 2026-08-26: the chapter menu became the home for three
actions rather than one, and the book's Download control moved into it. §6 is
rewritten accordingly; §§1–5 are unchanged.

**Provenance.** §§1–5 are *extracted*, not invented: from the commits that built
each behaviour (`b1ef5a4` chapter navigation, `554827d` long-press to drag,
`77f3fad` narrow labels, `df00047` mode-aware durations, `6dae93f` the "new"
badge, `04b5b4e` track-bar drag), from the comments those commits left in place,
and from the suites that already guard them (`touch-drag`, `reading-title`,
`scene-pause`, `keyboard`). §6 is the intent of the change made on 2026-08-26 and
was written before that change. §7 is what is genuinely unstated — listed for a
human to decide, never guessed.

---

## 1. What the chapter list is

The left pane (top pane, stacked) of an open book. One row per chapter, in the
book's order, in a pane that scrolls on its own while the page around it does
not.

It answers three questions and performs one action:

1. **What is in this book** — the titles, in order.
2. **Where am I** — one row, and only one, is the chapter being played.
3. **How long is each piece** — a duration on the right of every row.
4. **Take me there** — touching a row starts that chapter from its beginning.

Everything below serves those four. The list is not a table of contents that
happens to be clickable; **it is the primary navigation of an open book**, and on
a phone it is usually the only one on screen.

**The reader is listening, usually on a phone, often with the screen off, often
for hours.** Inherited from `ui-spec-v1.md` §1 and binding here: uninterrupted
playback beats correctness of chrome, and a mis-tap that loses someone's place
is a worse failure than a missing affordance.

---

## 2. A row, as seen

Left to right: the chapter's title, then — only when it applies — a small
uppercase **new** badge, then the duration. The title takes whatever width is
left and ellipsises; the duration never shrinks.

- **The title ellipsises rather than wraps.** A row is one line high, and the
  list's usefulness is that a dozen rows are visible at once. (Reading mode's
  chapter label is the opposite decision for the opposite reason and lives
  elsewhere — see `reading-title`.)
- **The duration is the *active* clock**, not the file's. In summary mode it is
  the summary's length. Showing full-chapter lengths beside condensed audio was
  a defect (`df00047`).
- **The "new" badge is absent, not empty, for a book that records no arrival
  date.** Every book published before the field existed would otherwise light up
  at once (`6dae93f`). Its tooltip is the date.
- **Below a narrow pane the row collapses to `Ch N`**, centred: the title and
  the duration are hidden, and the ordinal — which is never ellipsised — stands
  in for both (`77f3fad`). The threshold is the pane's width, not the window's.

## 3. Position

Exactly one row is **active**. It is tinted and its text takes the accent
colour, in both the full row and the collapsed `Ch N` form.

- **The active row alone carries a progress fill** — a faint accent wash growing
  left to right across the row as the chapter plays. Position within the
  chapter, not within the book, because the chapter is the unit the reader is
  in.
- **The active row alone carries a scrubber**: a thin accent handle sitting at
  the play position, which can be dragged to seek inside that chapter. It is
  invisible until the row is hovered (mouse) and faint but permanently present
  under a coarse pointer, where there is no hover to reveal it.
- **The list follows playback**, scrolling the active row into view when the
  chapter changes — unless the reader has scrolled it themselves, at which point
  it stops fighting them.

## 4. What a row does when touched

| Input | Result |
|---|---|
| Click / tap on the row | That chapter starts from its beginning, playing |
| Click / tap on the scrubber of the active row | Nothing; the scrubber is not the row |
| Mouse-down and drag on the scrubber | Seek within the active chapter, live |
| Touch and *hold* on the scrubber, then drag | The same seek |
| Touch and drag without holding | The pane scrolls; no seek, no play |

**Why the hold exists.** Both draggable controls sit inside a scrolling pane. An
immediate touch drag competes with the scroll and one of them loses — usually
the scroll, which makes the list feel stuck. Holding disambiguates. Moving more
than a finger's wobble before the hold engages is a scroll and cancels it. A
short vibration marks the moment the hold takes, because the finger is covering
the control it just grabbed (`554827d`).

**Mouse is never asked to hold.** A cursor has no such ambiguity, and requiring
a hold there would be a regression for nothing.

## 5. States the list is allowed to be in

Every state below has an author (something intends it) and a duration (something
decides when it ends), per `ui-spec-v1.md` §12.

| State | Author | Ends when |
|---|---|---|
| Rows rendered, none active | A book opening, before its position is known | The starting chapter is chosen — same frame |
| One row active, fill at rest | Position restored or chapter chosen | The chapter changes |
| Active row's fill advancing | Playback | Pause, seek, or chapter end |
| Row hovered (mouse) | The pointer | The pointer leaves |
| Scrubber revealed on the active row | Hover, or a coarse pointer | Hover ends; never, under a coarse pointer |
| Press armed (touch, held on the scrubber) | The reader's finger | The hold engages, the finger moves past slop, or it lifts |
| Scrubbing | An engaged hold, or a mouse-down | The pointer or finger releases |
| Pane scrolling under the reader | The reader | Momentum ends |
| List auto-scrolled to the active row | A chapter change | The scroll settles |

A frame showing anything else is a finding.

---

## 6. The chapter menu (change intent, 2026-08-26)

**What the change is for.** Three things a reader needs while a book is open
have no home, and inventing three controls for them would cost the phone layout
the thing the chapter list is for:

1. **Send one chapter to another person** — "listen to this bit". The book's own
   address is the finest thing they can copy out of the URL bar today.
2. **Take this book offline** — which today is a 128px pill on every row of the
   shelf, sitting beside the title and reading as the primary thing to do with a
   book. It is not: the primary thing to do with a book is open it.
3. **Throw away the audio this device is holding for this book** — because a
   cached copy can be stale, and a reader with a stale chapter has no way to
   ask for a fresh one. This is an escape hatch beside a real fix, not the fix.

**The menu is the home for all three.** One secondary gesture, one place, and
the primary gestures — tap plays, hold on the scrubber seeks — untouched.

**What is added, stated as intent rather than as mechanism:**

1. **A chapter has an address.** Any chapter of any book can be named by a URL,
   and opening that URL lands the reader in that book with that chapter loaded
   and selected. It does not start playing: arriving somewhere is not the same
   as being played at, and audio that begins on its own is the failure this
   player spends most of its code avoiding.

2. **The address is an entry parameter, and it is spent on arrival.** Once the
   chapter has been opened the URL goes back to naming the book alone. This is
   deliberate and it is the only reading that keeps two existing promises at the
   same time: *the URL is the truth* (it names what is open) and *refreshing
   keeps you where you are* (a reader who was sent to chapter 5 and has listened
   on to chapter 8 must not be thrown back to 5 by a reload). The chapter number
   is a doorway, not a bookmark.

3. **The affordance is a secondary gesture on the row**, because the row's
   primary gesture is already spoken for and playback must not be disturbed to
   reach a menu:
   - **Right-click** on a chapter row (pointer).
   - **Touch and hold** on a chapter row, away from the scrubber (touch).
   - **The keyboard's own context gesture** on a focused row — the menu key, or
     Shift+F10.

   The scrubber keeps its hold: a hold that begins on the scrubber is a seek,
   never a menu. A hold anywhere else on the row is a menu, never a seek.

4. **It does not disturb what was already there.** A tap still plays. A drag
   still scrolls. A right-click anywhere that is not a chapter row still gets
   the browser's own menu — the page does not take the context menu away from
   the reader, only from the sixty rows that have something better to offer.

5. **A menu appears, listing the host's actions first and the player's own
   below them.** The host's half is a list, not a component: this player also
   runs on static sites with no server behind them, and an action that 404s is
   worse than no action. The player's own half is always there, because
   downloading and flushing need nothing but the browser.

   A host that offers nothing still gets the player's two, and a row on a page
   where the player has neither keeps the browser's own context menu — the same
   rule as the per-book menu.

6. **A host item hands the host the chapter and the address, and closes the
   menu.** What happens next — a share sheet, a clipboard, a dialog — is the
   host's, described in §6.1.

7. **A player item reports in place and leaves the menu open.** Downloading and
   flushing are the only two things here that take time and can fail, and both
   already have a vocabulary for saying so — *Preparing… / Downloaded ✓ /
   Failed — retry ↻*. Closing the menu on them would throw that away and leave
   the reader with nothing at all. The item's label IS the report.

8. **Download is the book's, reached from any of its chapters.** It caches every
   chapter, both tracks, exactly as the shelf's control did — it is the same
   action in a less prominent place. The shelf keeps a control for it, because a
   reader deciding what to take on a journey is on the shelf and not inside a
   book, but that control becomes an icon the size of the menu button beside it
   instead of a 128px pill: its job is to *report* offline state at a glance and
   to be available, not to compete with the title. The two are never on screen
   together, which is what §1.1's "never two ways to do one thing" asks.

9. **Flush throws away this device's cached audio for this book**, in both audio
   caches — the one explicit downloads write and the one listening fills — and
   then reloads the open chapter so the next byte comes from the network. It
   says how many entries went. It is deliberately per-book and deliberately
   manual: it is the escape hatch a reader can reach when a cached chapter is
   stale, and it stands beside the real fix (a content-addressed audio URL,
   owned elsewhere) rather than replacing it.

   Entries are matched by **where the book's audio lives**, not by the names of
   its files. A stale entry is one whose name the current manifest no longer
   uses, so a name-by-name flush would miss exactly the entries it exists to
   remove — and it keeps working when the audio URL is content-addressed.

   Every touch of Cache Storage is inside a try/catch, including the one that
   *names* it: on iOS Safari with "Block All Cookies", `caches` throws from the
   getter. Flush is not on the boot path, but the class is that every unguarded
   evaluation of a revocable global is a defect wherever it sits.

10. **The menu closes** on: choosing a host item, Escape, a click or tap outside
   it, opening another row's menu, or leaving the book. It never closes on its
   own, and nothing about its lifetime is decided by a network.

11. **A row is reachable and operable from the keyboard.** It announces itself as
   a control, Enter and Space play the chapter, and the context gesture opens
   the menu. This is a gap being closed, not a new feature: the rows have never
   been focusable, and the buttons around them are, which is exactly why nobody
   noticed — tabbing through an open book looks like it works.

**States this adds** (each with an author and a duration, per §5):

| State | Author | Ends when |
|---|---|---|
| Row focused (keyboard) | Tab, or the menu closing | Focus moves |
| Press armed (touch, held on the row body) | The reader's finger | The hold engages, the finger moves past slop, or it lifts |
| Menu open on one row | An engaged hold, a right-click, or the context key | Selection, Escape, an outside press, another row's menu, or leaving the book |
| A menu item focused | The menu opening, or arrow keys | Focus moves |
| The tap after a hold, suppressed | The hold that just fired | Immediately — it is one event, not an interval |
| A player item mid-work (*Preparing…*, *Flushing…*) | The reader choosing it | The work finishes or fails |
| A player item reporting an outcome | The work finishing | The menu closes |

**What must NOT appear**, and is a defect if it does:

- Playback starting because a menu was opened.
- The browser's context menu *and* this menu, together.
- A menu still open after the book has closed.
- A menu whose position depends on a value that arrives later.
- A row that is focusable and does nothing when Enter is pressed.
- A menu that closes while the work it started is still running.
- A flush that reports success without saying whether anything was there.
- An offline state that still says *Downloaded ✓* after a flush.

### 6.1 The host's half, on books.landry.bot

The player names a chapter; the site decides what a link to it *means*. Two
cases, and the difference between them is not cosmetic:

- **A public book.** Anyone may open the link. Where the device offers a share
  sheet, that is what happens; otherwise the link goes to the clipboard and the
  site says so, visibly, without a network call. This must keep working on a
  page served over plain http, where the clipboard API does not exist — the
  fallback is a selectable copy of the link and an instruction, which is what
  the playback log already does.

- **A private book.** The link is still real and still worth sending — to
  somebody the book is already shared with — but it **must not imply access the
  recipient does not have.** So a private book never reaches the device's share
  sheet, where a link travels with no room for a caveat. It gets a dialog that
  names the restriction in the same breath as it hands over the link. The menu
  item says so too, before it is chosen.

- **The address is built from the space's immutable id, not from its alias.** An
  alias is a mutable pointer released the instant its owner renames; a link
  built from one dies silently and looks like the book was deleted. This is the
  same rule that makes storage keys ids and titles display concerns.

---

## 7. Gaps — for a human, not for a guess

Listed because they are genuinely unstated. None of these were invented into the
sections above.

1. **Discoverability of the share gesture.** Nothing on screen says a chapter row
   has a menu. The per-book menu has a visible `⋯`; a chapter row deliberately
   does not, because sixty of them would cost the phone layout the thing the
   list is for. Options: leave it undiscoverable (a power gesture), reveal a
   control on hover and focus only, or say it once somewhere else. **Undecided —
   shipped as undiscoverable.**

2. **Whether the URL should track the chapter as it plays.** §6 clause 2 spends the
   chapter number on arrival. The alternative — rewriting the address as the
   reader moves through the book — was rejected because it makes a reload throw
   away position within a chapter, but it would make the address bar always
   shareable. **Decided against; recorded because it is a real trade.**

3. **Whether a chapter link should carry a time offset** ("from 12:40"), which is
   what a reader quoting a passage actually wants. Out of scope here; it is a
   different address, not a different affordance.

4. **What a link to a private book does for a signed-in recipient who has been
   granted it.** The link names the *owner's* shelf, and the owner's shelf shows
   a visitor only that owner's public books — a granted book appears on the
   *recipient's* own shelf instead. So the recipient's own shelf is where the
   book is reachable, and the link as built lands them on a shelf that does not
   list it. **This is a real limitation of the link, not of the affordance**, and
   it is why §6.1 refuses the share sheet for private books rather than papering
   over it. Fixing it means either a shelf-independent book address or a shelf
   that shows a visitor what has been shared with them; both are decisions
   someone should make on purpose.

5. **Whether the chapter rows' new focusability is too many tab stops.** A
   1,142-chapter book is one of the libraries this player serves. Nothing else on
   the page offers a way past them.

6. **Arrow-key movement inside the open menu** is not specified. Tab works
   because the items are ordinary controls.

7. **The shelf's offline indicator is now an icon**, so "which of these books do
   I have on the plane" is answered by colour and a tooltip rather than by a
   word. That is a deliberate trade for the prominence it gives back, and it is
   the clause most likely to be wrong. **Undecided whether the icon is enough.**

8. **Flush is per-book and per-device, and says so nowhere.** A reader with the
   same stale chapter on three devices has to do it three times. Naming that in
   the menu would cost a line; leaving it unnamed costs a surprise.

9. **One guard is untested.** The list scrolls the playing chapter back into
   view on every frame until the reader has scrolled it themselves, and it now
   also stands down while a menu is open — because a menu is anchored to its
   row and a scroll takes it off screen. Reaching that state needs the active
   chapter to change while a menu is open, and every way to change chapter
   closes the menu first, so no suite exercises it. The sibling case, a focused
   row being dragged away, is guarded and tested (`chapter-menu`, M) — it was
   found by looking at a screenshot, not by reasoning.

10. **Flush cannot reach the browser's own HTTP cache or a CDN edge.** It empties
   Cache Storage and reloads the chapter with a cache-busting parameter, which
   is what makes the reload miss both — but that parameter is the stall
   recovery's, borrowed. If the recovery's scheme changes, flush changes with
   it, silently. **A coupling, recorded rather than fixed.**
