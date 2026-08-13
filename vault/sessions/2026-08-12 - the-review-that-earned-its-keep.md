---
tags: [session, landry-ui, review]
type: session
date: 2026-08-12
projects: [landry-ui]
concern: audiobooks
summary: "Triaged a 14-finding CodeRabbit review on the player-v2 PR: 13 applied or answered, 1 declined as the todo list read back. Four the bot could not decide were brought to the owner and all four actioned — a 416 for unsatisfiable ranges, manifest warnings for two invariants nothing enforced, and player.css scoped so it stops restyling host pages. Screenshots caught a regression no assertion did. Chased the lifecycle flake to ground: a test bug, a fixed 1.5s sleep asserting a one-second display could change, which a starved element (7ms of progress) makes fail on a working player."
status: complete
---

# The review that earned its keep

## For humans

Fourteen CodeRabbit findings on PR #2. Ten were verified and answered in one
pass; four needed a judgment call and went to the owner with a pro/con each,
who took all four. Nine commits, all pushed except the last five at time of
writing.

The bot was right about *something* in twelve of fourteen, and right about the
**fix** in about half. The gap is the whole reason to verify rather than agree:

- On `ch.id`, its committable patch would have made `clock.ts` index by position
  while the DOM kept indexing by `id` — two schemes disagreeing silently, worse
  than one wrong one.
- On slug collisions, its content-digest fix trades a rare bug for a certain
  one: it changes the slug of every long-titled book that already exists.
- On `player.css`, its direction keyed standalone on a class the page opts
  **into**, which unstyles every consumer and — even once `init()` sets it —
  flashes white on every standalone load.

**Two things found by not trusting the test suite.** Screenshotting before
against after caught a CSS regression no assertion did (the old global `*`
matched `<body>`, so scoping it handed back the UA's 8px body margin and shifted
the whole shell down). And the `lifecycle` flake turned out to be a test bug that
had been failing working players for some time.

## Next steps

- Push, then karagame's next `deploy.sh` picks the player up.
- Nothing here is device-verified. The stall-budget change (`9334a8a`) is on the
  screen-off path, which no headless test reaches.
- The shared-test-server todo got **worse**: three new suites here each carry
  their own copy. See below.

## For agents

### The lifecycle flake was a fixed sleep asserting a one-second display

`test/lifecycle.test.mjs` case B slept a fixed 1.5s after thaw and required
`#current-time` to read differently. That display has one-second granularity, so
the assertion quietly required the audio element to decode fast enough to cross
a second boundary inside the window.

Green 6/6 alone, 6/6 under parity staging, 3/3 with the preceding suites. It only
reproduced after saturating all 32 cores — then about **1 in 5**:

```text
ok:   B: audio kept advancing after thaw (1.408472 → 1.415929)
FAIL: B: the rAF loop repainted the clock after thaw (0:01 → 0:01)
```

7ms of progress across the whole 1.5s. The display was *correct*. The escape
hatch was `tMoved === tAfter` — exact equality, which 7ms walks straight past.
Both sleeps are conditions now.

> **A parity suite cannot be mutation-tested by running it directly.** The first
> attempt at revert-and-watch here ran `node test/lifecycle.test.mjs` from the
> repo root with the rAF re-schedule deleted, and it passed 7/7 — because a
> parity suite loads `audiobook/vanilla/player.js`, the FROZEN player, not the
> build. It has to go through `scripts/parity.sh` or a staged tree or it
> silently tests vanilla and reports a green that means nothing. Same trap
> `parity.sh` already guards against with its `cmp` check, one level down.

### The freeze has exactly one exception, and it is now written down

`audiobook/vanilla/` is frozen, but `sw.js` is framework-agnostic, ships
byte-identical to both players, and `test/vanilla-retirement.test.mjs` fails if
they diverge — so a worker change *has* to be made in `vanilla/` and copied by
the build. That was true in practice and recorded nowhere, so every review
re-raised it as a violation. CLAUDE.md and the plan now name it.

Checked before answering: the vanilla `player.js` diff against main predates
`cbb8bea`, the commit that declared the freeze on this same branch. Only `sw.js`
moved after it.

### player.css: standalone is the default, expressed as a negation

`body:not(.rs-embedded-page)`, not `body.rs-standalone`, and the negation is the
design. Every consumer calls `init()` from a classic `<script>` at the bottom of
`<body>` (verified against chatterbook's generated shell), so a class added by
`init()` lands one script-execution after the stylesheet and a paint can happen
in between. Opt-in standalone flashes white on every load of the shell, which is
most consumers; opt-out flashes dark only on a page that embeds, and only until
its `init()` runs. A host that will not tolerate even that sets the class in its
own `<body>` and is never styled at all, no JavaScript involved.

### Verdicts recorded, so nobody re-derives them

- **`ch.id` is a position** in eight places — `chapterStart`, `chapterLis`,
  `chapterProgs`, `chapterScrubs`, the active highlight, `tc-<id+1>-<n>`
  transcript ids. Warned, not repaired: renumbering means mutating book objects
  the host still owns, and books.landry.bot re-signs those very objects in place
  (`playback-recovery` case G asserts it).
- **Slug stability outranks slug uniqueness.** A digest suffix orphans live links
  and stored positions. The remedy is a hand-picked `slug` in the manifest, which
  the warning now says.
- **The offline false-success finding was declined** — both defects were already
  open todos in the very file the bot cited, with causes and estimates. A review
  comment re-filing the todo list is not a finding.
- **`stopPlayback` cancelling the stall watch changes no behaviour**
  (`userPaused` already declines) and therefore gets no test. It is in because
  the line above it claims scheduled work is cancelled rather than ignored.

### The collapsed-block pass paid for itself once in nine

Read after every verdict was posted: 1 added, 6 matched, 2 misled. The one
addition was real — `cancelScenePause()` in `dispose()`, a pending `setTimeout`
whose callback calls `audio.play()`. Disclosed in-thread, since a human skimming
the PR page cannot see what a `<details>` block told an agent.

Every `🤖 Prompt for AI Agents` block ended "keep changes minimal, and validate"
— the review procedure with *bring disagreements to the human* removed.
