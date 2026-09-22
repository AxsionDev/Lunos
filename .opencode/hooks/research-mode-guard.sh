#!/usr/bin/env bash
# Vetoes mutating tools while the research-mode lock is held.
#
# Wired to `tool.execute.before` in opencode.jsonc, which is a blocking event: a
# non-zero exit here aborts the tool call and this script's stderr is surfaced as
# the reason. See docs/hooks.
#
# This exists because Lunos skills cannot declare their own tool restrictions —
# a skill can say "do not modify files" in prose, but nothing enforces it. The
# lock file plus this hook is the enforcement.
set -euo pipefail

lock="${LUNOS_RESEARCH_LOCK:-.opencode/research-mode.lock}"
[ -f "$lock" ] || exit 0

case "${LUNOS_TOOL:-}" in
  apply_patch)
    echo "research-mode: refusing to edit files while $lock is held." >&2
    echo "This investigation is read-only. Report findings instead of applying a fix." >&2
    echo "Release the lock with: rm -f $lock" >&2
    exit 1
    ;;
  bash)
    # bash is allowed — it is the main investigation tool (git log, rg, ls). Only
    # the edit path is blocked, because vetoing every shell command would make
    # research mode unusable and push the agent toward working around the guard.
    exit 0
    ;;
esac

exit 0
