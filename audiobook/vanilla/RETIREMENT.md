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
      `build_book.sh --mode standalone` `file://` bundle. Its installed copy is
      an older vanilla snapshot, so the switch is still ahead of it.

## Switched

Kept as a record, not a checklist: `remainingConsumers` counts unticked boxes
only, so nothing here affects the flag.

- [x] `landry.bot/books` — switched 2026-08-07 (`PLAYER=` in
      `scripts/build-shell.sh`), in production since. First to switch and the
      one watched, which is why it found the two embedding defects the other
      consumers never would have: the player painting its own root over the
      host's `--player-surface`, and this shell's typography relying on a global
      reset that `player.css` had no business applying.
