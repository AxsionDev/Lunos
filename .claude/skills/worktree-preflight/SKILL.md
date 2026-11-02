---
name: worktree-preflight
description: Use when an action-taking command or workflow (bug fix, feature, etc.) begins, before any other step, to reset into a clean isolated git worktree — removing the current task worktree if present and creating a fresh one from a chosen base branch.
---

# Worktree Preflight

## Overview

Standard reset every action-taking command runs **first**, before any other step, so work always
starts in a clean, isolated git worktree instead of on top of stale state. Remove the current task
worktree (if any), then create a fresh one from a chosen base branch. This is **task-level** and
**sits on top of** other isolation — e.g. `feature.md`'s per-developer `isolation: "worktree"`
agents still spawn their own worktrees afterward; this only guarantees a clean base for them.

Run silently and proceed. Only stop to ask the user in the two cases called out below (an existing
worktree with **uncommitted work**, or a **missing base branch**) — never destroy work without a heads-up.

## When to Use

- **First action** of any command/workflow that edits code or files (bug-fix, feature,
  feature-lifecycle, quick-bugfix, batch-bugfix, jira-\*, fullstack-dev).
- **Skip** for read-only / docs-only / state commands (discover, user-journeys, prepare-stories,
  doc-refresh, session-_, state-_, etc.) — they take no code actions.

## The Sequence

Run these in order. Steps are best-effort; if something is missing, take the documented fallback.

### 1. Git-repo guard

```bash
git rev-parse --is-inside-work-tree 2>/dev/null
```

**If this is not a git repo** (e.g. the config repo itself): log one line
(`worktree-preflight: not a git repo — skipping`) and **return**. The command proceeds normally.
This is what makes the skill safe to wire into every command.

### 2. Resolve the base branch

- **Override first:** if the invoking command passed an override — a `--base=<branch>` or
  `--branch=<branch>` token in `$ARGUMENTS`, or a branch the orchestrator names explicitly — use it.
- **Else detect the default branch:**

  ```bash
  git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'
  ```

  **If empty,** fall back to the first existing of `main`, `master`, `develop`
  (`git rev-parse --verify <name>`); **final fallback** is the current branch
  (`git branch --show-current`).

- **Verify it exists:** `git rev-parse --verify --quiet "<base>"`. **If missing:** surface the
  resolved name and **ask the user** which branch to base the worktree on; do not guess.

### 3. Define the deterministic worktree location

A fixed path so removal is idempotent (one task worktree per repo):

```bash
ROOT="$(git rev-parse --show-toplevel)"
WT="$ROOT/../.agent-worktrees/$(basename "$ROOT")/task"   # sibling dir, never nested in the work tree
WT_BRANCH="agent/task"                                     # stable; recreated from base each run via -B
```

### 4. Remove the current worktree if present — with a delete-safety guard

- **Reuse guard (prevents nested resets).** If `$WT` already exists as a valid worktree on
  `agent/task` **and** no override base branch was supplied that differs from its current base:
  **reuse it and return** — do not remove/recreate. This makes the reset happen **once per task,
  not once per nested call**, so a command that internally invokes other wired commands
  (`batch-bugfix` → `quick-bugfix`/`bug-fix`, `jira-bug-fix` → `bug-fix`,
  `jira-feature` → `feature-lifecycle` → `feature`) doesn't wipe in-progress work. Pass an explicit
  `--fresh` token (or a different `--base`) to force a rebuild instead of reusing.
- Otherwise, locate it: `git worktree list --porcelain` and match the path `$WT`. If no such
  worktree, skip to step 5.
- **Look before you destroy.** Check it for work that would be lost:

  ```bash
  git -C "$WT" status --porcelain          # uncommitted changes
  git -C "$WT" log --branches --not --remotes --oneline   # unpushed commits
  ```

  If **either is non-empty** (dirty worktree), **surface exactly what would be lost and ask the user
  to confirm** before removing — never silently `--force` away real work.

- When clean (or the user confirms):

  ```bash
  git worktree remove "$WT" --force
  git worktree prune
  ```

### 5. Create the fresh worktree from the base branch

```bash
git worktree add -B "$WT_BRANCH" "$WT" "<base>"
```

**Honor `.worktreeinclude`:** if `$ROOT/.worktreeinclude` exists, copy each listed (gitignored) file
into `$WT` so local config/credentials are available (per CLAUDE.md §"Worktree Environment Files"):

```bash
if [ -f "$ROOT/.worktreeinclude" ]; then
  while IFS= read -r f; do
    case "$f" in ''|\#*) continue;; esac          # skip blanks/comments
    [ -e "$ROOT/$f" ] && mkdir -p "$WT/$(dirname "$f")" && cp -R "$ROOT/$f" "$WT/$f"
  done < "$ROOT/.worktreeinclude"
fi
```

### 6. Hand off into the worktree

Report the worktree path, base branch, and task branch. **For the remainder of this command, treat
`$WT` as the project root** — read/edit/run all files there. Then continue with the command's normal
first step (state init, workspace setup, etc.).

## Quick Reference

| Step          | Check                                                                                   | Fallback / guard                                                        |
| ------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1 Git guard   | `git rev-parse --is-inside-work-tree`                                                   | Not a repo → log + return (no-op)                                       |
| 2 Base branch | override → `origin/HEAD` → main/master/develop → current                                | Missing → ask the user                                                  |
| 3 Location    | `$ROOT/../.agent-worktrees/<repo>/task`, branch `agent/task`                            | Deterministic, idempotent                                               |
| 4 Remove old  | healthy `agent/task` exists & same base → reuse (no-op); else match `git worktree list` | Dirty → confirm before `--force`; `--fresh`/new `--base` forces rebuild |
| 5 Create      | `git worktree add -B agent/task "$WT" <base>`                                           | Copy `.worktreeinclude` files in                                        |
| 6 Hand off    | treat `$WT` as project root                                                             | Continue command's normal first step                                    |

## Relationship to native worktree config — audited 2026-09-10

**Verdict: keep as-is.** This skill does not duplicate native Claude Code worktree config
(`worktree.baseRef`, `isolation: "worktree"`, `--worktree`/`-w`) — it solves a different problem:

- Native `isolation: "worktree"` (agent frontmatter) and `--worktree`/`-w` (CLI flag) each create
  **one worktree scoped to one agent spawn or one session**. `worktree.baseRef` (`fresh`|`head`)
  only configures what _those_ native paths branch from.
- This skill creates and manages **one worktree per task**, shared across an entire command chain
  that may invoke other wired commands internally (`jira-feature` → `feature-lifecycle` → `feature`,
  `batch-bugfix` → `quick-bugfix`/`bug-fix`). Native config has no concept of "task" spanning nested
  command invocations — it can't provide the reuse guard in step 4, which is this skill's actual job.
- This skill also never calls native worktree creation (no `EnterWorktree`/`WorktreeCreate`) — it
  shells out to raw `git worktree` directly — so native's automatic `.worktreeinclude` handling
  never applies here; step 5's manual copy loop is necessary, not redundant.

**No migration needed.** If a future Claude Code version adds task-scoped (not just
agent-/session-scoped) native worktree reuse, re-audit against this section.

## Common Mistakes

- **Forcing removal of a dirty worktree** without surfacing/confirming the uncommitted or unpushed work.
- **Expecting a worktree in the config repo** — it isn't a git repo, so the skill no-ops; that's correct.
- **Nesting the worktree inside the work tree** — use the sibling `../.agent-worktrees/...` path.
- **Forgetting `.worktreeinclude`** — gitignored config (`.env`, `appsettings.Development.json`) won't be in the fresh worktree unless copied.
- **Asking the user about every step** — only the dirty-worktree and missing-base-branch cases warrant a prompt; everything else is silent.
