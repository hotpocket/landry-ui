---
tags: [session, landry-ui, reading-mode, css, flexbox]
type: session
date: 2026-08-24
projects: [landry-ui]
concern: audiobooks
summary: "A long chapter title broke reading mode on a phone: nowrap gave the row a min-content width as long as the title, and #player-view is a flex item embedded, so it was laid out 605px wide inside a 379px mount and the host's overflow-x clipped the controls away. Fixed by wrapping the title, clamped to two lines, plus overflow-wrap for the single-token case. The new suite has to mount the player the way books.landry.bot does — a standalone page CANNOT exhibit this, which is why every existing suite missed it. Three instruments produced green before one could see the defect: document scrollWidth (the host clips, so it never changes), player-vs-mount (the mount blows out alongside it, 637 vs 637 on a 412px screen), and Range line counting (counts the line boxes a clamp hides). A min-width:0 that looked obviously right was removed — nothing could make it fail."
status: complete
---

# The title that sized the player

## For humans

A phone screenshot: reading mode, the chapter title running off the right edge
mid-word, the transcript text cut off with it, and of the control row only
`« ▶ » A− A+` visible with A+ half gone. Follow and read — the way *out* of
reading mode — were off screen entirely.

The row had `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`,
which is a rule that says "clip me". It clips nothing, and the reason is the
whole finding:

**nowrap gives an element a min-content width as long as its longest line, and
a flex item is never laid out narrower than its min-content — whatever its
container says.** Embedded, `#player-view` is a flex item. So one unbreakable
line inside it sized the entire player. Measured live on books.landry.bot: a
412px screen, a 379px mount, a **605px** `#player-view`. The host's
`overflow-x: hidden` then hid the overflow itself — the controls were not
pushed into a scrollable area anyone could reach, they were painted out of
existence.

The fix is to remove the pressure at its source: the title wraps, clamped to
two lines (`display: -webkit-box` + `-webkit-line-clamp: 2`), with
`overflow-wrap: anywhere` for the title that is one unbroken token. The clamp
is a ceiling, not a reserved slot — a short title still takes one line, because
vertical space in reading mode is text.

## The part worth remembering

**A standalone page cannot exhibit this defect.** In `test/fixture/out`,
`#player-view` is a block inside a block and *cannot* be wider than its parent.
Every existing browser suite loads that fixture, so every one of them was
structurally blind to a class of bug that only exists when a host embeds the
player. `test/reading-title.test.mjs` therefore builds the host: a flex column
page, a flex `<main>` with `overflow-x: hidden`, the mount as a flex child —
books.landry.bot's actual shape, because that is where the bug lives.

Three instruments returned green before one could see it:

1. **`document.scrollWidth`** — never moves, because the host clips. The page
   does not scroll; the content is simply gone.
2. **player-vs-mount** — the mount is a flex item with the same `min-width:
   auto` and blows out alongside the player. It read 637 vs 637 on a 412px
   screen: a pass on a broken layout. The screen is the only fixed reference.
3. **Range line counting** — a clamped `-webkit-box` still lays out every line
   box and Range still reports it. Counting them all called a working two-line
   row "4 lines". Count only the rects inside the element's own box.

And a fourth that produced a *false red on nothing*: the first draft forgot
`<meta name="viewport">`, so mobile emulation used a 980px layout viewport and
everything fitted.

## What was removed

`.player-view { min-width: 0 }`. It reads as the textbook fix for exactly this
— and with the title wrapping, nothing can make it fail. With the title NOT
wrapping, it does not help either (view still 637 on a 412px screen): the
blowout enters through a different link in the chain. Untestable in both
directions, so it came out. See [[mutation-testing-as-a-reading-list]].

Every declaration that stayed was mutation-checked and bites:
`display: -webkit-box` and `-webkit-line-clamp` (B, H), `overflow-wrap:
anywhere` (without it a 68-character token puts `#player-view` at **1071px**),
and the removal of nowrap itself (A, C, D, F).

## Playwright

Checked first, since packages had moved under it: gstack's pin is 1.61.1, the
apparmor profile is in place, and `chromium.launch()` works with no env vars
and no `--no-sandbox`. Nothing needed fixing.

## Commit

`ad8a57d` — reading mode: a long chapter title wraps, and stops costing the
controls. **Unpushed** — karagame fetches this player at deploy time, so it
must be pushed before any consumer deploy.
