# Dev-Cycle Mode Design

Design spec for a fourth primary mode, `dev-cycle`, that walks a feature
through the SDLC — Discover, Architect, Plan, Build+Verify — dispatching a
subagent per phase (with one deliberate exception, §5.1) and stopping for
human approval at three gates.

This document is spec only; no source file was modified to produce it.

Status: approved in brainstorming, not yet implemented. Successor to the
`plan` / `research` mode work documented in `specs/agent-mode-system.md`.

## 1. Premise and constraints

A mode in this codebase is **a permission set plus a per-turn reminder**. It
is not an orchestrator. Nothing in `agent.ts` runs a state machine, and
`reminders.ts` dispatches on a single `input.agent.name`
(`packages/opencode/src/session/reminders.ts:29,51,76`) — there is no phase
counter anywhere in that structure. Any phase machine must therefore be
carried in mode-owned *data*, not in new control flow.

Three constraints follow from existing code and are binding on this design:

1. **No `prompt` field on the agent entry.** For a primary agent, `prompt`
   *replaces* `SystemPrompt.provider()` (see `session/llm/request.ts` and the
   comment at `agent/agent.ts:206-211`). Setting it strips the provider
   prompt's tool-use discipline — the exact bug fixed in commit `60ff27f45`
   for research mode. Steering goes in `reminders.ts`.
2. **`task` must not be denied.** `plan` sets `task: { general: "deny" }`
   (`agent.ts:165-167`); `research` deliberately omits it, with a comment
   explaining that the mode must delegate legwork (`agent.ts:191-192`). A
   phase-delegating mode has the same requirement.
3. **One mode carries one permission set for its whole run.** `plan` and
   `research` deny `edit` except their own artifact path
   (`agent.ts:171-175`, `agent.ts:196-200`). A dev-cycle that reaches an
   implementation phase needs real write access, so it holds build-like
   permissions from turn one. See §7.

### Chosen approach: advisory gates

Gates are **prompt-level, not permission-level**. The alternative — turning
`plan_enter`/`plan_exit` (`tool/plan.ts`) into a generalized N-phase
transition tool, making each phase its own enforced permission set — was
considered and rejected for v1 as too large a blast radius across the tool
registry and permission plumbing.

The accepted cost: a model *can* skip a gate, and write access exists before
gate 2 approves any design. §3 mitigates this with a durable on-disk cursor
and a per-turn restatement; it does not eliminate it.

## 2. Surface

| File | Change |
|---|---|
| `packages/opencode/src/agent/agent.ts` | New `dev-cycle` entry in the `agents` record (alongside `research`, `agent.ts:182-212`), plus the three native phase subagents (§5.2) |
| `packages/opencode/src/session/session.ts` | New `devcycle()` export beside `plan()` (`session.ts:342`) and `research()` (`session.ts:346`) |
| `packages/opencode/src/session/prompt/dev-cycle-mode.txt` | New reminder body |
| `packages/opencode/src/session/reminders.ts` | New branch mirroring the `research` branch (`reminders.ts:29-48`) |
| `packages/opencode/src/agent/prompt/architect.txt`, `planner.txt`, `qa.txt` | Prompt bodies for the three new native subagents (§5.2) |
| `packages/opencode/src/session/dev-cycle.ts` | Frontmatter cursor parser. **Not in the original design** — the spec put the regex inline in `reminders.ts`; splitting it out is an improvement, since it is the one piece of this mode that is unit-testable without the reminder harness |
| `packages/opencode/test/session/dev-cycle-mode.test.ts` | New test file mirroring `research-mode.test.ts` |
| `packages/opencode/test/agent/agent.test.ts` | Extended: the native-agent roster and the phase subagents' permission outcomes. This is the file that catches a new primary or subagent breaking the mode's registration |
| `packages/web/src/content/docs/agents.mdx` | User-facing documentation of the mode |

### 2.1 Agent entry

`mode: "primary"`, `native: true`, **no `prompt`**. Permissions are
`Permission.merge(defaults, Permission.fromConfig({...}), user)` following
the shape at `agent.ts:187-203`, with:

- `question: "allow"` — `question` is `"deny"` in the `defaults` block
  (`agent.ts:126`) and the gate protocol depends on it.
- No `task` deny — per constraint 2.
- `external_directory`: allow for the dev-cycle data dir, mirroring
  `agent.ts:193-195`. **This entry is load-bearing, not copied ceremony.**
  `external_directory` is an independent gate, not a modifier on `edit`:
  `edit.ts:83` calls `assertExternalDirectoryEffect`, which issues its own
  `ctx.ask({ permission: "external_directory" })`
  (`tool/external-directory.ts:33-42`) whenever the target falls outside the
  instance context. A permissive `edit` does **not** short-circuit it. Since
  `artifact()` resolves into `Global.Path.data` for non-VCS projects
  (`session.ts:336-338`) — outside the worktree — omitting this entry would
  make every artifact write prompt against the `external_directory: "ask"`
  default (`agent.ts:122-125`).
- `edit`: **not** restricted to the artifact path. Unlike `plan` and
  `research`, this mode implements code. This is the constraint-3 cost.

### 2.2 Artifact path

```ts
export function devcycle(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  return artifact("dev-cycle", input, instance)
}
```

`artifact()` (`session.ts:335-340`) already resolves to
`<worktree>/.opencode/dev-cycle/<created>-<slug>.md` in a VCS project and
`Global.Path.data/dev-cycle/...` otherwise. No new path logic is needed.

## 3. Phase state

The artifact file is simultaneously the machine cursor and the human
deliverable — the same double duty `plan` mode gives its plan file. It opens
with frontmatter:

```markdown
---
phase: architect
gate: pending
---
```

`phase` is one of `discover | architect | plan | build | verify`. `gate` is
`pending | approved` and describes the gate at the *end* of the current
phase.

Note the asymmetry between *phases* and *cursor states*: the cycle has four
gated phases, but five cursor values, because Build+Verify is **one phase
with one gate and two cursor states**. The split exists so a failed
verification can move the cursor back to `build` without re-opening the
approved plan (§6); it does not introduce a fourth gate.

The reminder branch reads the file, extracts those two fields by regex over
the leading frontmatter block, and injects the current position into every
turn. Three properties motivate putting the cursor on disk rather than
relying on conversation history:

- It survives compaction and session restarts.
- A human can approve, rewind, or redirect a cycle by editing two lines.
- The model cannot drift by forgetting which phase it is in — the position
  is restated every turn, not inferred.

Both the model and the human mutate this frontmatter — the model at gate
transitions (§4), the human when approving or rewinding by hand. The
injected position is therefore read **from the file on every turn, never
from conversation history**, so a human edit between turns takes effect on
the next turn without anyone telling the model. This is why the frontmatter
parse must not be cached.

Malformed or absent frontmatter degrades to `phase: discover`,
`gate: pending`. It must not throw.

## 4. Gate protocol

Gates sit after Architect (gate 1), after Plan (gate 2), and after Verify
(gate 3). Discover has no gate: approving a read-only findings summary is
ceremony without a decision.

At a gate the model must, in order:

1. Write the completed phase's section into the artifact file.
2. Set `gate: pending` in the frontmatter.
3. Call the `question` tool with the approval decision.
4. **End the turn.**

On approval: flip `gate: approved`, advance `phase:`, continue. On
rejection: revise the current section in place and re-present. Never
advance on rejection.

The reminder restates this every turn and carries a violation clause — "advancing a phase without an approved gate is a violation of this mode" —
modeled on the "Answering from memory is a violation" section of
`session/prompt/research-mode.txt:8-10`, which is the established pattern
here for making a prompt-level rule stick.

## 5. Phases and subagents

| Phase | Cursor | Subagent | Output section | Gate |
|---|---|---|---|---|
| 1. Discover | `discover` | built-in `explore`, thoroughness "very thorough" (`agent.ts:227-249`) | Findings | — |
| 2. Architect | `architect` | new `architect` (read-only tools) | Architecture + rejected alternatives | Gate 1 |
| 3. Plan | `plan` | new `planner` | Ordered, testable steps | Gate 2 |
| 4. Build+Verify | `build` | **the dev-cycle primary itself** | Diff summary | — |
| 4. Build+Verify | `verify` | new `qa` | Test results + review findings | Gate 3 |

Discover should dispatch `explore` subagents **in parallel** when the
investigation has independent parts, following the guidance already proven
in `research-mode.txt:36-38`.

### 5.1 Why Build is not delegated

Every other phase gets a dedicated subagent; Build does not. The primary
holds the approved plan in context and holds the write permissions.
Delegating implementation would mean re-establishing that context through a
task prompt and receiving back a summary rather than the work itself.

The value of agent separation in this cycle is **fresh eyes on written
code**, and that value lands on `qa` — an agent that did not write the code
reviewing it. That separation is preserved. Symmetry for its own sake is
not.

### 5.2 Subagent definitions

The three new agents are **native**, compiled into the binary alongside
`explore` (`agent/agent.ts:254-276`): entries in the `agents` record with
`mode: "subagent"`, `native: true`, and a `prompt:` imported from
`agent/prompt/{architect,planner,qa}.txt`.

They are deliberately *not* project markdown under `.opencode/agent/`, which is
where this design originally put them. That was wrong, and shipped broken:
`ConfigPaths.directories` (`config/paths.ts:23-40`) scans only
`Global.Path.config` and the `.opencode` directories walked up from the cwd —
nothing bundled into the binary. Run this build against any project other than
this one and `dev-cycle` appears in the picker while three of its four phases
fail with `Unknown agent type` (`tool/task.ts:133`). A native mode cannot name
project-scoped agents in its own prompt. Graceful degradation was considered
and rejected: the only fallback is `general`, which inherits `edit: "*":
"allow"` from `defaults`, so a "degraded" `architect` would be a *writable*
architect — precisely inverting the guarantee below.

Setting `prompt` on these entries does not violate §1's constraint 1. That
constraint is specific to *primary* agents, where `prompt` replaces
`SystemPrompt.provider()`; for a subagent it is the normal way to define the
agent, which is why `explore` has always carried one.

**Verified after implementation.** `architect` and `planner` are read-only at
the permission layer, not merely by prompt. Each ruleset opens with
`"*": "deny"` and adds back only read tools; `write`, `edit` and `patch` all
normalise onto the single `edit` permission key
(`packages/core/src/v1/config/agent.ts:62-81`), and `evaluate()` resolves
last-match-wins via `findLast` (`permission/index.ts:32`), so with no later
`edit` allow the blanket deny stands. `test/agent/agent.test.ts` pins this —
which it could not do while the agents were project markdown invisible to the
test harness.

Two consequences of being native rather than file-scoped are worth stating,
because both are real changes from the markdown form:

- **User config now outranks the agent's own rules.** Native rulesets are built
  `Permission.merge(defaults, fromConfig({...}), user)`, so a user's
  `permission: { edit: "allow" }` wins. Under the markdown form the file's own
  ruleset was appended last (`agent/agent.ts:325-352`) and could not be
  overridden. This is the native convention — `explore` has shipped with it —
  but it narrows the claim above: read-only is a guarantee against the *agent*,
  not against the operator's own configuration.
- **External-directory reads loosen from deny to ask.** The markdown `"*":
  false` incidentally denied the independent `external_directory` gate too,
  which a subagent cannot recover from since it has no one to prompt. The
  native entries follow `explore` and restore `readonlyExternalDirectory`
  (`agent.ts:114-117`) after the blanket deny. This does not touch `edit`.

`qa` is deliberately weaker, and the difference is easy to miss. It is granted
`bash`, which gates on the separate `"bash"` permission key
(`tool/shell/id.ts:16`) and is a general write channel — redirection, `sed -i`,
`git checkout`. `qa` can therefore modify files at the permission layer, and
its "report, never fix" discipline (stated in its own prompt,
`agent/prompt/qa.txt`, and noted in §7) holds by instruction only. That is
the accepted trade: `qa` cannot run the suite without a shell.

Note that the 39-agent fleet under `.claude/agents/` is **not** reachable
from Lunos — the agent loader and config never reference `.claude`
(verified by grep over `agent/agent.ts` and `config/*.ts`). The two
registries are separate, and this design uses only the Lunos one.

## 6. Failure paths

| Situation | Behavior |
|---|---|
| Verify fails | Gate 3 stays `pending`; failures appended to the artifact; `phase` returns to `build` |
| Gate rejected | Revise the current section in place; do not advance |
| Session restart / compaction | Artifact frontmatter is the source of truth; reminder re-injects position |
| Malformed frontmatter | Degrade to `discover`/`pending`; never throw; **the reminder states explicitly that the position is unknown**, so a parse failure does not read as genuinely being at phase 1. Only an unreadable *phase* triggers that — an unreadable `gate` degrades to `pending` silently, which errs toward re-asking rather than toward redoing work |
| User switches to another mode mid-cycle | **Known gap, out of scope for v1.** Plan mode handles its equivalent with `BUILD_SWITCH` (`reminders.ts:62-71,76-92`); no analogue is built here |

## 7. Known limitations

1. **Gates are advisory.** A model can skip one. Mitigated, not solved, by
   the durable cursor and per-turn restatement.
2. **Write access precedes design approval.** A consequence of constraint 3:
   one mode, one permission set. Enforcing "no edits before gate 2" requires
   the rejected permission-level approach.
3. **No mid-cycle mode-switch handling.** Per §6.
4. **Prior turns retain their phase lines.** The reminder is persisted per
   turn, so a multi-turn cycle shows several reminder blocks, each with the
   phase that was current when it was written. Only the last is
   authoritative; the earlier ones read as the cycle's history. The prompt
   states this rule explicitly, but it is prompt-level like the gates
   themselves. The underlying accumulation is shared with `plan` and
   `research` and would need a generic fix across all three modes.

Limitations 1-3 are consequences of the advisory approach chosen in §1, and
all three are resolved by the permission-level alternative if it is ever
revisited. Limitation 4 is independent of that choice: it follows from how
reminders are persisted, is shared with `plan` and `research`, and would
survive the permission-level alternative unchanged.

## 8. Testing

Mirror `packages/opencode/test/session/research-mode.test.ts`:

- Reminder fires only when `agent.name === "dev-cycle"`.
- Artifact absent → injected text instructs creation at the resolved path.
- Artifact present → injected text carries the parsed `phase` and `gate`.
- Malformed / missing frontmatter → degrades to `discover`/`pending`, no
  throw.
- `Session.devcycle()` resolves to `.opencode/dev-cycle/<created>-<slug>.md`
  under VCS and to the data dir otherwise.
- Regression: the `research` and `plan` reminder branches still fire
  unchanged.
- **Namespace separation.** The cursor value `phase: build` and the agent
  name `build` are different namespaces that now live in one module:
  `reminders.ts:61-71` already branches on `input.agent.name === "build"`.
  Test that with `agent.name === "build"` and a dev-cycle artifact present
  carrying `phase: build`, the dev-cycle reminder does **not** fire and the
  `BUILD_SWITCH` path behaves as before.
