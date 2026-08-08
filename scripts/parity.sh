#!/usr/bin/env bash
# parity.sh — run the browser suites, UNEDITED, against the Preact build.
#
# The suites hardcode `../audiobook/vanilla`, which is the point: parity means
# the same assertions, unchanged, passing against a different implementation. A
# rewrite that gets to edit its own tests is not a parity check.
#
# So rather than parameterise the tests, this stages a copy of the tree with the
# built artifacts sitting where the suites already look. Nothing in the repo is
# touched, and the suites cannot tell which player they are exercising — which
# is exactly the property being tested.
#
# Usage:
#   scripts/parity.sh              # all browser suites
#   scripts/parity.sh reading-mode # one suite, by basename
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${TMPDIR:-/tmp}/landry-ui-parity.$$"
trap 'rm -rf "$STAGE"' EXIT

BUILT="$REPO/audiobook/player"
[ -f "$BUILT/player.js" ] || {
  echo "no build at $BUILT/player.js — run: (cd audiobook/player-src && node build.mjs)" >&2
  exit 1
}

mkdir -p "$STAGE"
cp -r "$REPO/test" "$REPO/audiobook" "$STAGE/"
rm -rf "$STAGE/audiobook/player-src"

# The substitution under test.
cp "$BUILT/player.js"  "$STAGE/audiobook/vanilla/player.js"
cp "$BUILT/player.css" "$STAGE/audiobook/vanilla/player.css"

# Guard against the harness quietly testing vanilla against itself — a green run
# would then mean nothing at all.
if cmp -s "$STAGE/audiobook/vanilla/player.js" "$REPO/audiobook/vanilla/player.js"; then
  echo "staged player.js is identical to vanilla — the substitution did not happen" >&2
  exit 1
fi

cd "$STAGE"
filter="${1:-}"
fail=0
total=0
skipped=""

# Which suites are PARITY suites is derived from what they load, not from a
# list here — a list drifts, and a feature suite swept into this run pads the
# parity number with assertions that measure no parity at all.
#
# The marker is how a suite RESOLVES the player on disk. A feature suite does
# `join(here, '../audiobook/player')` and is untouched by the substitution this
# script exists to test. A parity suite does not: it takes whatever the staged
# tree serves. Matching on the URL path instead would be wrong in both
# directions — the parity suites never mention it (they go through
# fixture/out), and the feature suites DO mention it, because they serve the
# build at that URL so the shared fixture needs no fork.
for f in test/*.test.mjs; do
  base="$(basename "$f" .test.mjs)"
  case "$base" in core-*|vanilla-retirement) continue ;; esac
  if grep -q "join(here, '../audiobook/player')" "$f"; then
    skipped="$skipped $base"
    continue
  fi
  [ -n "$filter" ] && [ "$base" != "$filter" ] && continue

  out="$(node "$f" 2>&1 || true)"
  line="$(printf '%s' "$out" | grep -E '^[0-9]+ passed' | tail -1 || true)"
  if [ -z "$line" ]; then
    printf '%-24s NO SUMMARY — suite crashed\n' "$base"
    printf '%s\n' "$out" | tail -20
    fail=$((fail + 1))
    continue
  fi
  printf '%-24s %s\n' "$base" "$line"
  n="$(printf '%s' "$line" | sed -E 's/^([0-9]+) passed.*/\1/')"
  total=$((total + n))
  printf '%s' "$line" | grep -qE ', 0 failed' || fail=$((fail + 1))
done

# Feature suites are not parity, but they still have to run — naming them as
# skipped and stopping there would make it easy to never run them at all. They
# go against the real build in the repo, not the staged copy.
if [ -n "$skipped" ] && [ -z "$filter" ]; then
  echo
  echo "== feature suites (against the build, not the staged copy) =="
  for base in $skipped; do
    out="$(cd "$REPO" && node "test/$base.test.mjs" 2>&1 || true)"
    line="$(printf '%s' "$out" | grep -E '^[0-9]+ passed' | tail -1 || true)"
    if [ -z "$line" ]; then
      printf '%-24s NO SUMMARY — suite crashed\n' "$base"
      printf '%s\n' "$out" | tail -20
      fail=$((fail + 1))
      continue
    fi
    printf '%-24s %s\n' "$base" "$line"
    printf '%s' "$line" | grep -qE ', 0 failed' || fail=$((fail + 1))
  done
fi

echo "---"
if [ "$fail" -eq 0 ]; then
  echo "parity: $total assertions passed against the Preact build, suites unedited"
else
  echo "parity: $fail suite(s) failed"
fi
exit "$fail"
