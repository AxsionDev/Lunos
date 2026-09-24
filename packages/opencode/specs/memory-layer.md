# Persistent memory layer: whether, what shape, and where (XCOD-85 spike)

**Status:** decision document. No code is built by this spike. **Recommendation: defer,** and ship the zero-build convention in §2 as documentation now. §6 gives the reasoning. The build / don't build / defer call is Petar's and is recorded on XCOD-85.

Checked against `origin/dev` on 2026-09-24.

## What exists today

- **Instruction files** are the only cross-session context. `packages/opencode/src/session/instruction.ts`:
  - Global: the first of `~/.config/opencode/AGENTS.md` or `~/.claude/CLAUDE.md` that exists (`instruction.ts:60-62`, `115-119`).
  - Project: the **first** of `AGENTS.md`, `CLAUDE.md` or `CONTEXT.md` found walking up to the worktree root. Only that filename's matches are used, so ancestors don't stack (`instruction.ts:122-132`).
  - Config `instructions`: extra files or globs, relative or absolute (`instruction.ts:135-150`). **URLs are skipped for system instructions** (`startsWith("https://") … continue`).
- **No memory layer.** Nothing writes to these files on the agent's behalf. `git ls-files` finds nothing memory-related in `packages/`; `packages/app/src/context/tab-memory.ts` is UI tab state and unrelated.

## 1. Is it worth building now?

**What Claude Code offers:** hierarchical `CLAUDE.md` files (user, project, local), a quick way to add a line to memory from the prompt, an `/memory` command to open and edit the files, and an auto-memory directory the agent writes notes into on its own and reads back in later sessions.

**What Lunos already covers:** the hierarchy, partly. Global and project instruction files load, and `CLAUDE.md` itself is read unless `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` is set. Missing: quick-add, an edit command, and any agent-written memory.

**Evidence of demand:**

- **No user signal exists either way.** Lunos has no telemetry, by design, and zero direct external contributions to date. No issue or ticket asks for memory. Any claim that "users feel the lack" would be an assumption, which the ticket rules out.
- **The one observable data point argues against auto-memory's value today.** This repository was developed with Claude Code's per-agent memory switched on across 35 agents. `.claude/agent-memory/*/MEMORY.md` holds **811 bytes in total across 35 files**, almost all empty headers. Agent-written memory produced essentially nothing durable over weeks of real use. The context that actually carried across sessions lived in hand-maintained files (`CLAUDE.md`, specs, tickets).
- **The roadmap marks memory as optional for Phase 3,** and Phase 3's exit criterion (XCOD-86) doesn't depend on it.

**Conclusion:** there's no evidence of demand, and there is some evidence that agent-written memory has low yield. The two pieces with clear value, a place for durable notes and a way to load them, are already possible without code (§2).

## 2. Shape

Three candidate shapes:

| Shape                                             | Who writes            | Review / edit story                                                                                          | Cost                            |
| ------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| A. Agent appends to `AGENTS.md`                   | Agent and user        | Mixed with hand-written rules; hard to review; first-match-wins means it may be the file that shadows others | Small build                     |
| **B. `.opencode/memory/*.md`, one fact per file** | User now; agent later | Plain files, reviewed in PRs like any doc; deletable one by one                                              | **Zero now**; small build later |
| C. Structured store (SQLite, embeddings)          | Agent                 | Not diffable; needs its own UI to inspect                                                                    | Large build                     |

**Recommended shape: B.** It works today with no code:

```json
{ "instructions": [".opencode/memory/*.md"] }
```

`instructions` already accepts globs of local files and loads them alongside `AGENTS.md`. This isn't limited by first-match-wins, which only applies to the `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` names. If memory is built later, the agent-facing part is a small write tool that creates or updates files in that directory, plus a `/memory` command that opens it. The storage format and the load path need no change.

Shape C is ruled out by §3: it isn't inspectable or diffable.

## 3. Sovereignty and trust constraints

Shape B meets every non-negotiable:

| Constraint                                                                           | How B meets it                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local and file-based                                                                 | Markdown files in the repo or the user's config dir                                                                                                                                                                                               |
| Inspectable, and diffable in git                                                     | One fact per file; project memory is committed and reviewed like code                                                                                                                                                                             |
| No hosted store                                                                      | None exists. System instructions from URLs are already skipped, so a remote memory source can't sneak in via `instructions`                                                                                                                       |
| Nothing leaves the machine except inside model requests the residency policy governs | Memory reaches a model only as part of the system prompt, which goes to the residency-checked provider (XCOD-93)                                                                                                                                  |
| A clear rule for what must never be written                                          | Needed only once the agent writes (§5): refuse anything matching the secret patterns the marketplace guard already rejects (`{env:`/`{file:` tokens, key-shaped strings), and never write from tool output of `read` on files outside the project |

## 4. Scope, and interaction with first-match-wins

- **Per project:** `.opencode/memory/` in the repo, committed. This is team knowledge and gets reviewed.
- **Per user:** `~/.config/opencode/memory/`, loaded with `"instructions": ["~/.config/opencode/memory/*.md"]` in the global config. Personal and never committed.
- **Both** can be active: `instructions` entries from every config layer are unioned.
- **First-match-wins isn't affected.** It only picks between `AGENTS.md`, `CLAUDE.md` and `CONTEXT.md`. Memory loaded through `instructions` sits beside whichever one wins, and never competes with it.

## 5. Prompt-injection risk

Memory the agent writes and later reads back is a **persistence vector**. Text the agent saw once (a web page, a file in a dependency, tool output) could become a standing instruction in every future session. This is the main reason to defer agent-written memory.

If agent-written memory is built, bound it as follows:

1. **Write only through a dedicated tool,** never through `edit`/`write` on the memory directory. The tool is permission-gated (`ask` by default), so a person approves every new memory. That approval is the review.
2. **Provenance header** on each file: the session and date it came from, so a suspicious memory can be traced and removed.
3. **Refuse content derived from untrusted sources:** anything whose text came from `webfetch`, `websearch`, MCP resources, or files outside the worktree in the same turn.
4. **Project memory changes show up in `git diff`.** A malicious addition is visible in review, which is the strongest control available and costs nothing.
5. **Size cap** per file and in total, so memory can't grow into an unreviewable blob.

Until then, memory written by people (shape B, today) carries no new risk. It's the same trust level as `AGENTS.md`.

## 6. Recommendation: defer

- **Now, no build:** document shape B in `packages/web/src/content/docs/rules.mdx` as the recommended way to keep durable notes: `.opencode/memory/*.md` plus the `instructions` glob. Small, reversible, and useful immediately.
- **Build later, only on evidence:** agent-written memory (the write tool, `/memory`, the §5 bounds), once real users ask for it or the dev-cycle run (XCOD-86) shows the agent repeatedly rediscovering the same facts. The storage and load path from §2 won't need to change.
- **Don't build:** a structured or hosted store (shape C), at any point, under the current positioning.

If the decision is **build**, the implementation story to create from this doc covers: the memory write tool with §5 bounds 1–5, `/memory` in the TUI, docs, and a real-run test that a written memory is loaded in the next session and that a memory derived from `webfetch` output is refused.
