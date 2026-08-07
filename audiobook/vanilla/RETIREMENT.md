# Retiring `audiobook/vanilla/`

The Preact build in `audiobook/player/` replaces this directory. Both ship side
by side until every consumer has switched, so that a phase-out and a rewrite
cannot fail at the same time with no way to tell which one broke it.

`test/vanilla-retirement.test.mjs` reads the checklist below and **fails once it
is empty** — the signal to delete this directory is a red test in the gate you
already run, not a note someone has to remember to re-read.

Remove a line when that consumer has switched to `audiobook/player/` and been
verified in production.

## Remaining consumers

- [ ] `karagame` — karalandry.com. Being phased out entirely; this line goes
      when the site does, not when it switches.
- [ ] `chatterbook` — `./luinst audiobook/vanilla lui-deps/player`, and the
      `build_book.sh --mode standalone` `file://` bundle.
- [ ] `landry.bot/books` — `PLAYER=` in `scripts/build-shell.sh`. First to
      switch, and the one watched in production.
