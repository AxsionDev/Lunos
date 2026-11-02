---
name: agent-bootstrap
description: Use when a team agent (developer, reviewer, investigator, orchestrator) begins work, before substantive task work, to silently establish state tracking, project environment, tech-stack patterns, documentation context, and the shared workspace.
---

# Agent Bootstrap

## Overview

Standard startup sequence every team agent runs **silently** before its primary task. Establishes the shared context (state, project config, patterns, docs, workspace) so agents behave consistently without re-deriving setup. Never ask the user about any step — initialize and proceed.

## When to Use

- First action of any developer, reviewer, investigator, or orchestrator agent
- Skip steps that don't apply to read-only agents (e.g., reviewers may skip workspace writes)

## The Sequence

Run these in order. Each is best-effort and silent — if a directory or file is missing, take the documented fallback and move on.

### 1. State tracking

Ensure `.agent-state/` exists; create it if missing:

```
.agent-state/
├── config.yaml            # see Config defaults below
├── active-session.yaml    # session_id: null  (until a session is created)
├── sessions/
├── global/
└── indexes/
```

Read `.agent-state/active-session.yaml`. If `session_id` is null or absent, create a session:

- ID format: `session-{YYYYMMDD}-{HHMMSS}-{task-slug}` (slug from the user request: lowercase, hyphens, ≤30 chars)
- Create `sessions/{id}/` with `session.yaml`, `tasks.yaml`, `decisions.yaml`, `context.yaml`
- Point `active-session.yaml` at the new id

If a session already exists with populated `context.yaml`, load `mission`, `current_state`, and `key_decisions` to inform your work.

### 2. Project startup doc

Read `.claude/PROJECT_STARTUP.md` for paths, build/start commands, and dev URLs.
**If missing:** do not scan or auto-detect — tell the user to run `/generate-startup`, then proceed using codebase inspection only where needed.

### 3. Tech-stack patterns

Load project-specific idioms if present:

- `.claude/patterns/tech-stack.md` — key idioms and review focus per layer
- `.claude/patterns/{backend,frontend,database}-patterns.md` — real code examples

Apply these over generic knowledge. **If absent:** rely on your baseline expertise and note that `/generate-startup` would enable project patterns.

### 4. Documentation lookup

Extract 2–4 keywords from the task. Search, in order, for matching `*.md`:
`.claude/docs/` → `.claude/patterns/` → `.augment/` → `docs/` → `README.md`.
Also check `{feature}.md` and `{feature}-user-journeys.md`. Read the most relevant, extract architecture/data-flow/affected-components context, and note which docs you consulted.
**If none found:** note the gap and suggest `/discover {feature-area}` after the task.

### 5. Workspace (multi-agent workflows only — OPTIONAL)

Glob `.agent-workspace/*/` for an active run.

- If one exists: read dependency artifacts (e.g. `contracts/`, other agents' `outputs/*.md`) before starting; after finishing, write your artifact to `outputs/{agent-name}.md` using the `agent-output-contract` skill.
- **Worktree caveat:** agents running with `isolation: "worktree"` are on a separate branch and **cannot** see `.agent-workspace/` (it lives on main) — skip workspace reads/writes; their output lives in the worktree branch.
- If no workspace exists: skip silently. Never block waiting on another agent.

## Config defaults (step 1)

```yaml
version: "1.0"
project: { id: "auto", name: "" }
context: { compact_after_messages: 25, summary_trigger_tokens: 8000 }
sessions: { auto_resume: true }
handoff: { auto_generate: true }
todo_write: { enabled: true, sync_mode: "bidirectional" }
```

## Quick Reference

| Step        | Check                                 | Fallback if missing                                   |
| ----------- | ------------------------------------- | ----------------------------------------------------- |
| 1 State     | `.agent-state/` + active session      | Create structure + new session                        |
| 2 Startup   | `.claude/PROJECT_STARTUP.md`          | Tell user to run `/generate-startup`; don't auto-scan |
| 3 Patterns  | `.claude/patterns/*.md`               | Use baseline expertise                                |
| 4 Docs      | `.claude/docs/`, `.augment/`, `docs/` | Note gap; suggest `/discover`                         |
| 5 Workspace | `.agent-workspace/{run}/`             | Skip silently (always optional)                       |

## Common Mistakes

- **Asking the user** about setup — every step is silent.
- **Auto-scanning** the project when `PROJECT_STARTUP.md` is missing — stop and point to `/generate-startup` instead.
- **Blocking** on another agent's workspace output — workspace is always optional and non-blocking.
- **Writing to `.agent-workspace/` from a worktree-isolated agent** — it isn't visible there.
