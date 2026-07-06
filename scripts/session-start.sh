#!/usr/bin/env bash
# SessionStart hook, wired via .claude/settings.json. Stdout is injected into
# the agent's context at session start, making vault orientation deterministic
# instead of prose-dependent. Cheap by design — pointers only, never full bodies
# (the agent reads the recap/todo files on demand).
#
# Fully file-based: it delegates to scripts/vault-digest, which is pure grep/awk
# over the vault's .md files. NO Obsidian app/CLI/GUI is touched, so it's safe
# headless and parallel sessions in different repos never contend over Obsidian.
set -u
here="$(cd "$(dirname "$0")" && pwd)"   # .../scripts
repo="$(dirname "$here")"               # repo root
digest="$here/vault-digest"
if [[ ! -x "$digest" ]]; then
  echo "vault-digest not found beside this hook — run /conduct init"
  exit 0
fi
# Anchor to THIS repo's vault explicitly — don't depend on the caller's CWD
# (vault-digest's git-root discovery would otherwise resolve the wrong vault).
export OBSIDIAN_VAULT_PATH="$repo/vault"

echo "Latest session recap: $("$digest" recap)"
echo "Open todos: $("$digest" todos 2>/dev/null | grep -c '\[ \]' || true)"
