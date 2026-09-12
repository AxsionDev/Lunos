# Claude Code Platform Updates — Research Brief

**Researched:** 2026-09-04, updated 2026-09-10 · **Installed version:** v2.1.267 (latest)
**Source:** `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`
**Coverage window:** v2.1.227 (2026-08-10) → v2.1.267 (2026-09-09) = the past month, confirmed via
`npm view @anthropic-ai/claude-code time --json` (CHANGELOG.md itself carries no dates — version
numbers were mapped to publish timestamps to verify the window, not extrapolated from cadence).
Version numbers 262 and 264 do not appear in the changelog — skipped/internal builds, not a gap in
this extraction.

Every version number below was mapped mechanically from the changelog line to its enclosing `##`
heading. Scope: deltas that matter for **this repo** — a 39-agent / 7-skill / 32-command fleet with
hooks, worktree isolation, MCP servers, and an Opus advisor. §§1–9 were researched 2026-09-04 and
cover up to v2.1.260; §10 is the 2026-09-10 update covering v2.1.261 → v2.1.267.

---

## 1. Subagent orchestration — the caps

| Version | Change |
|---------|--------|
| 2.1.212 | Per-session cap of 200 subagent spawns (`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`) — **later removed** |
| 2.1.217 | Concurrent subagent cap, default **20** (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) |
| 2.1.217 | Subagents **stopped** spawning nested subagents by default — reversed 2 versions later |
| 2.1.219 | **Nested spawning restored at depth 3 by default** (was 1). `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` disables |
| 2.1.224 | Removed the 200-per-session spawn cap entirely |
| 2.1.187 | Depth tracking fix: resumed subagents restore original depth; forked subagents count toward the cap |

### Does the depth ceiling affect this repo? **No.**

Verified by reading `.claude/commands/feature.md`: the command orchestrates everything **from the
main session**. `team-lead` has no dispatch logic in its body (only frontmatter examples) — it is
dispatched *by* the command, and the command separately dispatches the developers and reviewers.

```
main session (0) → project-orchestrator / team-lead / developers / reviewers  (all depth 1)
```

The deepest real chain is `/bug-fix` → `research-orchestrator` (1) → backend/frontend-developer (2),
since `research-orchestrator.md:34` genuinely does dispatch. **Depth 2 of 3 — comfortable headroom.**
Nothing to change. The 20-concurrent cap is also fine (peak is 4 parallel reviewers).

### Subagent model resolution changed — this one matters

- **2.1.251** — `CLAUDE_CODE_SUBAGENT_MODEL` became a *default* rather than an override. An agent
  definition's `model:` and an explicit per-spawn model now **win over it**. Good news: the fleet's
  per-agent `model: opus` pins are authoritative again.
- **2.1.257** — `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` restores override-everything behavior, if you ever
  want to force the whole fleet onto one cheap model for a dry run.

---

## 2. Agent frontmatter — fields the repo isn't using

Authoritative field list — `https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields`:

| Field | Notes |
|-------|-------|
| `name` **(req)** | lowercase + hyphens; no `:` (reserved for plugin namespacing, enforced 2.1.218) |
| `description` **(req)** | when Claude should delegate here |
| `model` | `sonnet`/`opus`/`haiku`/`fable`, a full id, or `inherit` |
| `tools` / `disallowedTools` | `tools: Task(agent_type)` restricts which subagents it may spawn (2.1.33) |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual` |
| `skills` | **Preloads** full skill content at startup (2.0.43) — see note below |
| `hooks` | PreToolUse/PostToolUse/Stop scoped to this agent's lifecycle (2.1.0) |
| `memory` | `user` / `project` / `local` persistent memory (2.1.33) |
| `isolation: worktree` | isolated git checkout (2.1.50) — **already used here** |
| `effort` | `low`…`max`, overrides session effort (2.1.78) |
| `maxTurns` | stops after N turns, returns marked partial, **resumable via `SendMessage`** |
| `background` | keep running even when Claude requests foreground |
| `color` | task-list display color |
| `initialPrompt` | auto-submitted first turn when run as main session (`--agent`) |
| `mcpServers` | server names or inline definitions |
| `experimental.cacheTtl` | `"5m"` / `"1h"` prompt cache TTL (2.1.248) |

### ✅ Resolved: `skills:` frontmatter vs. the `Skill`-call router pattern

**They are different mechanisms, not old vs. new — this repo's pattern is correct.**
The docs state: *"To preload Skills into context, use the `skills` field rather than listing `Skill` here."*

- `skills:` frontmatter → **eager**: injects full skill content at subagent startup. Lower latency,
  costs tokens whether or not the skill is used.
- `Skill` tool at runtime (this repo) → **lazy**: body loads only when invoked.

For `agent-bootstrap`, which every team agent always runs, `skills:` would be a legitimate latency
optimization. For conditional skills (`research-mode`, `contract-driven-implementation`) the runtime
call is strictly better. **No migration needed.**

### Deprecated / removed
- **2.1.198** — the `/agents` wizard was **removed**. Edit `.claude/agents/` directly or ask Claude.
- **2.1.218** — agent names containing `:` are now **rejected** (reserved for plugin namespacing).

---

## 3. Skills

| Change | Version |
|--------|---------|
| Skills support introduced | 2.0.x |
| `skills:` frontmatter to auto-load skills for subagents | 2.0.43 |
| Nested `.claude/skills` auto-discovery in subdirectories | 2.1.6 |
| `${CLAUDE_SESSION_ID}` substitution | 2.1.9 |
| Skill hot-reload (no restart); `context: fork`; `agent:` field; hooks in skill frontmatter | 2.1.0 |
| `${CLAUDE_SKILL_DIR}` substitution | 2.1.69 |
| `effort:` frontmatter on skills and slash commands | 2.1.80 |
| `disableSkillShellExecution` setting | 2.1.91 |
| `/reload-skills` — re-scan skill dirs without restarting | 2.1.152 |
| `disableBundledSkills` / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` | 2.1.169 |
| `context: fork` now runs **in the background by default**; opt out with `background: false` | 2.1.218 |
| `disallowed-tools` in skill **and slash command** frontmatter | 2.1.152 |
| Plugins accept `"."` as a `skills` path (root-level `SKILL.md`) | 2.1.221 |
| Skill chaining — up to 6 skills with trailing args (`/a /b /c do XYZ`) | 2.1.242 |

**Slash commands are NOT deprecated in favour of skills**, and they *do* support frontmatter —
`model:`, `effort:` (2.1.80), `disallowed-tools:` (2.1.152), `name:`, and hooks (2.1.0). As recently
as 2.1.259 there are bug fixes for "frontmatter `model:` on custom **commands** and skills". This
repo's 32 `.claude/commands/` files need no migration.

---

## 4. Hooks — large expansion

**Worktree-relevant (see §5):** `WorktreeCreate` / `WorktreeRemove` (**2.1.50**), `type: "http"`
support returning `hookSpecificOutput.worktreePath` (2.1.84).

**Multi-agent lifecycle:** `SubagentStart` (2.0.43); `TeammateIdle` / `TaskCreated` / `TaskCompleted`
(2.1.33 — exit code 2 blocks each); `SubagentStop` gains
`last_assistant_message` so hooks get the final response without parsing transcripts (2.1.47);
background agents fire `Notification` with `agent_needs_input` / `agent_completed` (2.1.198).

**Other new events:** `ConfigChange` (2.1.49), `HTTP hooks` (2.1.63), `InstructionsLoaded` (2.1.69),
`PostCompact` (2.1.76), `StopFailure` (2.1.78), `CwdChanged`/`FileChanged` (2.1.83),
`PermissionDenied` + `"defer"` PreToolUse decision (2.1.89), `PreCompact` blocking (2.1.105),
`MessageDisplay` (2.1.152), `PreModelSwitch`/`PostModelSwitch` (2.1.251), `Setup` (2.1.10).

**Config improvements:** `if:` conditions using permission-rule syntax — e.g. `Bash(git *)` — to avoid
needless process spawning (2.1.85); `args: string[]` exec form, no shell quoting, plus
`continueOnBlock` for PostToolUse (2.1.139); hook timeout raised 60s → 10min; output over 50K chars
saved to disk instead of injected into context.

⚠️ **2.1.214** — single-segment `dir/**` hook `if:` conditions now match only `<cwd>/dir`.
Write `**/dir/**` for any-depth matching. `deny`/`ask` permission rules keep their any-depth match.

---

## 5. Worktrees — native config the repo may be duplicating

**`.worktreeinclude` is a native Claude Code feature**, not a repo convention — it appears in
changelog bug fixes at 2.1.207 and 2.1.239. CLAUDE.md's documentation of it is correct usage.

| Feature | Version |
|---------|---------|
| `--worktree` / `-w` flag | 2.1.49 |
| `isolation: worktree` in agent definitions + `WorktreeCreate`/`WorktreeRemove` hooks | 2.1.50 |
| `worktree` field in status line hooks (name, path, branch, origin dir) | 2.1.69 |
| `ExitWorktree` tool | 2.1.72 |
| `worktree.sparsePaths` — sparse-checkout for large monorepos | 2.1.76 |
| `EnterWorktree` gains a `path` param to switch into an existing worktree | 2.1.105 |
| **`worktree.baseRef`** (`fresh` \| `head`) — branch from `origin/<default>` or local `HEAD` | 2.1.133 |
| `worktree.bgIsolation: "none"` — background sessions edit the working copy directly | 2.1.143 |

⚠️ **`worktree.baseRef` (2.1.133) overlaps this repo's custom `worktree-preflight` skill**, which
CLAUDE.md describes as "reset into a clean git worktree from a chosen base branch." Worth auditing
whether the skill still earns its complexity or can defer to native config. Note the 2.1.133 default
change: `fresh` moved `EnterWorktree`'s base back to `origin/<default>`.

---

## 6. Review & orchestration commands

- **`/ultrareview` (added 2.1.111) → now `/code-review ultra`** as of **2.1.223**; `/review` is an
  alias of `/code-review`. `/code-review <level> <pr#>` picks the effort tier; with no level it
  reuses your last.
- `/code-review` runs as a **background subagent** (2.1.218) — no longer fills the conversation.
- `claude ultrareview [target]` for CI/scripts, `--json` output (2.1.120).
- ⚠️ **The dynamic-workflow trigger keyword was renamed `workflow` → `ultracode` in v2.1.160.** The
  word "workflow" no longer triggers a run. `/effort ultracode` = xhigh reasoning + auto-workflows.
- `/deep-research` is manual-invoke only since 2.1.218 (Claude no longer launches it unprompted).
- Workflow runtime limits: 16 concurrent agents per run, 1,000 agents total, 4,096 items per
  `parallel()`/`pipeline()` call. Runs are resumable in-session (completed agents return cached results).
- **Workflow tool**: dynamic workflows default to a **medium size guideline (<15 agents)** (2.1.219);
  set via `workflowSizeGuideline` in any settings file or `/config`. The script-writing reference
  moved into a bundled `workflow-authoring` skill (2.1.248), cutting the tool description 5.7k → 1k tokens.
- `workflow.run_id` / `workflow.name` OTel attributes for reconstructing a run (2.1.219).

---

## 7. Agent teams & cross-session messaging

- **Agent teams** — research preview since **2.1.32**, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`;
  token-intensive. Teammates use the leader's model unless the spawn names one (the "Default teammate
  model" `/config` row was removed in 2.1.234). `teammateMode: "iterm2"` (2.1.186).
- **2.1.178 — `TeamCreate` / `TeamDelete` tools removed.** With teams enabled, every session now has
  **one implicit team**; spawn teammates directly via the Agent tool's `name` parameter — no setup
  step. The Agent tool's `team_name` parameter is still accepted but **ignored**.
  ⚠️ Known limitation: in-process teammates are **not restored by `/resume`**.
- Named subagents are now auto-named by Claude to enable `SendMessage` resumption. With teams **on**,
  named subagents launch as *teammates*; with teams **off**, they stay ordinary subagents.
- **Cross-session `SendMessage` / `ListAgents`** (2.1.224) — sessions message each other across your
  machines; `crossSessionInbound` controls inbound policy (2.1.224).
- `claude self-hosted-runner` (2.1.224) — run web/mobile/desktop sessions on your own machines.

---

## 8. Models & advisor

- **Opus 5** (`claude-opus-5`) — **2.1.219**, default Opus, 1M context, fast mode.
- **Fable 5.1** (`claude-fable-5-1`) — **2.1.257**, now the default Fable model, 1M context,
  $10/$50 per Mtok, $0.25/Mtok cache reads. ⚠️ `fable` / `best` still resolve to **Fable 5** in Claude
  apps gateway sessions; pick 5.1 explicitly in `/model`. → Relevant to `/fullstack-fable`.
- **Advisor**: gained a text form (`/advisor`, `/advisor <model>`, `/advisor off`) usable in headless
  `-p` / SDK / Remote Control sessions (**2.1.260**). Fable is selectable as an advisor again. A
  prompt-cache bug on advisor-enabled background requests was fixed in 2.1.257.
- `ANTHROPIC_DEFAULT_MODEL` (2.1.236) — sets the model new sessions start on, without `ANTHROPIC_MODEL`'s stickiness.
- `modelPicker`, `promptCacheTtl` / `subagentPromptCacheTtl` (all 2.1.243).

---

## 9. Permissions

- **`Tool(param:value)` permission syntax** (**2.1.178**) — matches a tool's *input parameters*, with
  `*` wildcards. e.g. `Agent(model:opus)` to block Opus subagents. A real cost guardrail for a
  39-agent fleet.
- `defaultMode: "bypassPermissions"` in **project** `.claude/settings.json` is now **ignored**
  (2.1.257) — set it in user or managed settings, or pass `--permission-mode`.
- `/config key=value` from the prompt (2.1.181), works in `-p` and Remote Control.
- `--safe-mode` / `CLAUDE_CODE_SAFE_MODE` (2.1.169) — start with all customizations (CLAUDE.md,
  plugins, skills, hooks, MCP) disabled. **Fastest way to bisect a misbehaving fleet.**

---

## 10. Update — 2026-09-10 (v2.1.261 → v2.1.267)

### The prompt-cache cluster — read as one story, not scattered bullets

Roughly a dozen separate fixes across 2.1.261/265/266/267 all address the same failure family:
**something about a subagent, teammate, or resumed session subtly changed the request prefix,
missing the prompt cache.** Specifically:

- Foreground-spawned subagents resuming with a changed tool list/system-prompt prefix (2.1.265)
- Agent-team teammates & resumed subagents moving `SubagentStart` hook context and **preloaded
  skills** out of the prefix on later turns (2.1.265) — directly relevant to §2's `skills:`
  frontmatter discussion
- In-process agent-team teammates re-sending first-turn tool/skill announcements on turn 2 (2.1.261)
- A background worker forked from a conversation adding `EnterWorktree` mid-session (2.1.267) —
  relevant to worktree isolation
- Model switches (`/model`) re-sending every tool definition (2.1.267)
- Mid-session MCP/plugin tool changes rewriting the tool list on resume (2.1.267, several bullets)

**Operational read:** a 39-agent fleet that spawns subagents, uses worktree isolation, and (per
§7) could add named teammates was very likely bleeding prompt-cache reuse across most of the last
month, invisibly (cache misses aren't errors — just cost/latency). **v2.1.267 is worth being on**
for this reason alone, independent of any feature interest below. This also makes follow-up #6
below (preloading `agent-bootstrap` via `skills:`) safer than it was when first suggested, since
the specific bug that would have undermined it (preloaded skills falling out of the prefix) is now
fixed. Note the honest scope of that claim: it means the preload is *less likely to regress via a
known cache bug*, not that it was measured faster — see the verification note under follow-up #6.

### `effort:` frontmatter silently ignored on pinned legacy models — fixed 2.1.267

**Fixed:** `effort:` frontmatter on custom commands, skills, and subagents was being ignored on
models whose default effort is still pinned — **Opus 4.7, Opus 4.8, Fable 5**.

Checked against this repo: all 33 agents using `effort:` frontmatter pin `model: opus` / `sonnet`
/ `haiku` (generic aliases, resolving to current-gen models, not the pinned legacy ones) — **not
affected**. The one file in the repo pinned to a raw legacy model id, `.claude/commands/fullstack-fable.md`
(`model: claude-fable-5`), does **not** currently set `effort:` — also not affected today, but
worth remembering if an `effort:` field is ever added there, since that's exactly the affected
combination.

### `/skill-doctor` (2.1.261) — run 2026-09-10, with a measurement caveat

Ran via `claude -p "/skill-doctor"` (confirms slash commands work headlessly, per §3). Real results:

- **126 skills loaded but never invoked**, 66 of them from plugins (`bmad`, `agent-vibes`, `postman`,
  `notion`, `atlassian`, `chrome-devtools-mcp`, `microsoft-docs`, `code-review`, `greptile`,
  `pr-review-toolkit`, `ralph-loop`, `claude-md-management`, `agent-sdk-dev`, `remember`,
  `frontend-design`, `ui-ux-pro-max`, `skill-creator`) — each adds to the system prompt every turn.
  This is genuine, actionable context cost, but it's **user/machine-level plugin config
  (`~/.claude`), not this repo** — pruning it is the user's call, not something to act on unasked.
- ⚠️ **Blind spot found, don't misread it:** this repo's own 6 project skills
  (`agent-bootstrap`, `agent-output-contract`, `bug-investigation`, `contract-driven-implementation`,
  `research-mode`, `worktree-preflight`) all show **"0× never"** used — despite `bug-fix` alone
  showing **105 uses** in the same report, and `bug-fix`'s documented first step being
  `worktree-preflight`. The tool's usage counter evidently tracks `Skill()` calls made in the
  **main session**, not calls made *inside subagents* — which is how every one of these 6 skills is
  invoked (per §2, they're called via the `Skill` tool from within agent bodies). **Conclusion: "0
  uses" here means "not measured," not "unused."** Do not use this report to argue for removing any
  of this repo's own skills.

### Advisor: decided once per conversation, not per request (2.1.265)

**Fixed:** whether the advisor tool and its instructions apply was being re-decided per request
from the request's model, causing inconsistent behavior mid-conversation. It's now decided once
and **announced in the conversation when it changes**. Directly relevant to CLAUDE.md's Advisor
Model section — the opus/sonnet/haiku pairing check described there now applies stably for the
whole conversation rather than fluctuating per turn.

### Other items worth knowing about, lower repo impact

| Change | Version | Why it's here |
|---|---|---|
| `--append-subagent-system-prompt-file` | 2.1.261 | Subagent system prompts too large for the command line can be file-based |
| `bashOutputMaxChars` / `taskOutputMaxChars` settings, up to 128K | 2.1.261 | Raises inline Bash/background-task output before it's saved to disk — relevant given how Bash-heavy the developer/reviewer agents are |
| Forked skills (`context: fork`) not streaming their kickoff prompt as progress events | 2.1.265 fix | Relevant if any skill here uses `context: fork` (per §3, introduced 2.1.0) |
| Workflow `agent()` calls with large output schemas wrongly refused in auto mode | 2.1.267 fix | Relevant to `Workflow` tool usage (§6) — schema-heavy `agent()` calls (e.g. `FINDINGS_SCHEMA`) were sometimes blocked pre-fix, not by design |
| `/workflows` agent detail shows running/failed/done + subagent task list | 2.1.265 | Better visibility into Workflow runs |
| `maxEffortLevel` setting (caps effort across providers) | 2.1.267 | Cost guardrail alternative/complement to `Agent(model:opus)` permission rules (§9) |
| `--plugin-dir` accepting a folder of plugins, hot-added/removed | 2.1.265 | Not currently used by this repo but relevant if plugin distribution changes |

---

## Follow-ups — status as of 2026-09-10

1. ✅ **Audited `worktree-preflight` against native `worktree.baseRef`** (§5) — **no duplication,
   kept as-is.** Verdict and reasoning recorded directly in `.claude/skills/worktree-preflight/SKILL.md`
   under "Relationship to native worktree config": the skill provides task-scoped (not agent-/session-
   scoped) reuse across nested command chains, which no native config does, and never calls native
   worktree creation, so it isn't shadowing `.worktreeinclude` handling either.
2. ✅ **`/code-review ultra` / `/ultrareview` rename** — checked; **nothing to change.** No file in
   this repo outside this brief mentions `ultrareview`.
3. ❌ **`Agent(model:opus)`-style permission rules** (§9) — **deliberately not applied; confirmed with
   the user 2026-09-10.** 15 of this repo's 33 agents are pinned to `opus` by design; a blanket `deny`
   would break them, an `ask` rule would prompt on every one of those spawns across `/feature`,
   `/bug-fix`, etc. User chose "leave it undone" over an `ask` speed bump or a narrower per-agent
   `deny` — no permission rule added to `.claude/settings.json`. Revisit only if opus cost actually
   becomes a problem in practice.
4. ✅ **CLAUDE.md's advisor section updated** — now notes `/advisor` works headless (v2.1.260) and
   that advisor pairing is decided once per conversation, not per request (v2.1.265).
5. ✅ **`/fullstack-fable` moved to `claude-fable-5-1`** — `model:` frontmatter and all in-body
   references updated in `.claude/commands/fullstack-fable.md`.
6. ✅ **`agent-bootstrap` preloaded via `skills:` frontmatter** on all 26 agents that call it
   unconditionally as step 1 (scripted edit, verified against the two phrasing variants found). The
   old explicit `Skill(agent-bootstrap)` step-1 line (with its Read-fallback safety net) was replaced
   with a note that it's now preloaded — **empirically verified, not assumed**: a live probe of
   `backend-developer` via the Agent tool confirmed the skill's content is present in context with
   zero tool calls (`BOOTSTRAP_PRESENT`, 0 tool_uses). Framed as removing a startup tool round-trip,
   **not** as a measured latency win — this window's prompt-cache cluster (above) shows preloaded
   skills were exactly the kind of thing with cache-fragility bugs recently, now fixed in v2.1.265.
   CLAUDE.md's skill table and Skill-Based Architecture section updated to document why only this
   one skill gets the eager-preload treatment.
7. ✅ **`ultracode` keyword rename** — checked; **nothing to change.** No file in this repo mentions
   "workflow" as a dynamic-workflow trigger keyword.
8. ✅ **Ran `/skill-doctor`** headlessly (`claude -p "/skill-doctor"`) — confirms slash commands work
   in `-p` mode. Full results and a real measurement caveat recorded in §10. **Do not act further on
   the "0 uses" numbers for this repo's own 6 skills** — see the caveat before touching anything here.
9. ✅ **Already on v2.1.267** — confirmed via `claude --version`; no action needed.

### ⚠️ Claims from secondary research that this changelog contradicts
A `claude-code-guide` research pass returned three assertions that are **false** against the changelog —
recorded here so they don't get re-adopted later:
- *"Slash commands have no frontmatter"* — false; see §3.
- *"`.claude/commands/` is legacy; `.claude/skills/` is canonical"* — no changelog support whatsoever.
- *"`worktree.sparsePaths` is not documented"* — it exists, added in **v2.1.76**.

### Explicitly NOT recommended
- ~~Setting `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`~~ — verified unnecessary; the fleet dispatches from
  the main session and peaks at depth 2 of 3.
- ~~Replacing `.worktreeinclude` with a `WorktreeCreate` hook~~ — `.worktreeinclude` **is** the native
  mechanism.
