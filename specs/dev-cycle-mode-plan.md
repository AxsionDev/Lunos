# Dev-Cycle Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `dev-cycle` primary mode that walks a feature through Discover → Architect → Plan → Build+Verify, dispatching a subagent per phase and stopping at three human approval gates.

**Architecture:** A mode here is a permission set plus a per-turn reminder — not an orchestrator. Phase position lives in frontmatter on the mode's own artifact file, is re-read from disk every turn, and is injected into the conversation by a new branch in `reminders.ts`. Gates are advisory (prompt-level), enforced by restatement rather than by permissions.

**Tech Stack:** TypeScript, Bun, Effect. Tests use `bun:test` via the repo's `testEffect` harness.

**Spec:** `specs/dev-cycle-mode.md`

## Global Constraints

Copied verbatim from the spec; every task's requirements implicitly include these.

- **No `prompt` field on the agent entry.** For a primary agent, `prompt` *replaces* `SystemPrompt.provider()` (`agent/agent.ts:206-211`). This is the bug commit `60ff27f45` fixed for research mode.
- **`task` must not be denied.** `plan` sets `task: { general: "deny" }` (`agent.ts:165-167`); this mode must delegate, like `research` (`agent.ts:191-192`).
- **`external_directory` allow is required and is an independent gate.** `edit.ts:83` calls `assertExternalDirectoryEffect`, which issues its own `ctx.ask({ permission: "external_directory" })` (`tool/external-directory.ts:33-42`). A permissive `edit` does **not** short-circuit it.
- **`edit` is NOT restricted to the artifact path.** Unlike `plan`/`research`, this mode implements code. It inherits `"*": "allow"` from `defaults` (`agent.ts:120`).
- **Frontmatter parsing must never throw.** Malformed or absent → `phase: discover`, `gate: pending`.
- **Cursor is never cached.** Re-read from disk each turn, so a human hand-edit between turns takes effect immediately.

**Commands:**
- Tests: `bun test --timeout 30000 --only-failures` from `packages/opencode`
- Single file: `bun test test/session/dev-cycle-mode.test.ts` from `packages/opencode`
- Typecheck: `bun run typecheck` from `packages/opencode`

**Baseline note:** 4 pre-existing failures in `cf-ai-gateway` are not regressions. Do not use `bun test | tail` — it masks the real exit code.

---

### Task 1: `Session.devcycle()` artifact path helper

**Files:**
- Modify: `packages/opencode/src/session/session.ts:346-348` (add after `research`)
- Test: `packages/opencode/test/session/dev-cycle-mode.test.ts` (create)

**Interfaces:**
- Consumes: `artifact(dir, input, instance)` (`session.ts:335-340`), already resolves `<worktree>/.opencode/<dir>/<created>-<slug>.md` under VCS and `Global.Path.data/<dir>/...` otherwise.
- Produces: `Session.devcycle(input: { slug: string; time: { created: number } }, instance: InstanceContext): string`

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/session/dev-cycle-mode.test.ts`. Copy the harness preamble from `test/session/research-mode.test.ts:1-56` verbatim (imports, `const it = testEffect(...)`, `const instance = ...`), then add:

```typescript
describe("dev-cycle output path", () => {
  it.effect("mirrors the plan path under a vcs project", () =>
    Effect.sync(() => {
      const ctx = instance({ vcs: true, worktree: "/tmp/wt" })
      const session = { slug: "my-feature", time: { created: 1700000000000 } }

      expect(SessionNs.devcycle(session, ctx)).toBe(SessionNs.plan(session, ctx).replace("/plans/", "/dev-cycle/"))
      expect(SessionNs.devcycle(session, ctx)).toBe("/tmp/wt/.opencode/dev-cycle/1700000000000-my-feature.md")
    }),
  )

  it.effect("mirrors the plan path outside a vcs project", () =>
    Effect.sync(() => {
      const ctx = instance({ vcs: false, worktree: "/tmp/wt" })
      const session = { slug: "my-feature", time: { created: 1700000000000 } }

      expect(SessionNs.devcycle(session, ctx)).toBe(SessionNs.plan(session, ctx).replace("/plans/", "/dev-cycle/"))
      expect(SessionNs.devcycle(session, ctx)).not.toContain("/tmp/wt")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

From `packages/opencode`: `bun test test/session/dev-cycle-mode.test.ts`
Expected: FAIL — `SessionNs.devcycle is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/opencode/src/session/session.ts`, directly after the `research` function (line 348):

```typescript
export function devcycle(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  return artifact("dev-cycle", input, instance)
}
```

- [ ] **Step 4: Run test to verify it passes**

From `packages/opencode`: `bun test test/session/dev-cycle-mode.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/session/session.ts packages/opencode/test/session/dev-cycle-mode.test.ts
git commit -m "feat(dev-cycle): add Session.devcycle artifact path helper"
```

---

### Task 2: Phase cursor parser

**Files:**
- Create: `packages/opencode/src/session/dev-cycle.ts`
- Test: `packages/opencode/test/session/dev-cycle-mode.test.ts` (append)

**Interfaces:**
- Consumes: nothing — pure module, no Effect, no I/O.
- Produces:
  - `DevCycle.PHASES: readonly ["discover", "architect", "plan", "build", "verify"]`
  - `DevCycle.Phase` (union of those literals), `DevCycle.Gate` = `"pending" | "approved"`
  - `DevCycle.Cursor` = `{ phase: Phase; gate: Gate }`
  - `DevCycle.DEFAULT_CURSOR: Cursor` = `{ phase: "discover", gate: "pending" }`
  - `DevCycle.parseCursor(text: string | undefined): Cursor`

This is a separate module from `reminders.ts` deliberately: it is pure and exhaustively testable without the Effect harness, which keeps the reminder branch in Task 4 thin.

- [ ] **Step 1: Write the failing test**

Append to `packages/opencode/test/session/dev-cycle-mode.test.ts`. Add `import { DevCycle } from "@/session/dev-cycle"` to the imports at the top of the file.

```typescript
describe("dev-cycle cursor parsing", () => {
  const frontmatter = (phase: string, gate: string) => `---\nphase: ${phase}\ngate: ${gate}\n---\n\n# Cycle\n`

  it.effect("reads phase and gate from frontmatter", () =>
    Effect.sync(() => {
      expect(DevCycle.parseCursor(frontmatter("architect", "approved"))).toEqual({
        phase: "architect",
        gate: "approved",
      })
      expect(DevCycle.parseCursor(frontmatter("verify", "pending"))).toEqual({ phase: "verify", gate: "pending" })
    }),
  )

  it.effect("degrades to discover/pending rather than throwing", () =>
    Effect.sync(() => {
      // Each of these is a real way the file can be wrong: absent, empty,
      // no frontmatter at all, unterminated block, unknown phase, unknown gate.
      expect(DevCycle.parseCursor(undefined)).toEqual(DevCycle.DEFAULT_CURSOR)
      expect(DevCycle.parseCursor("")).toEqual(DevCycle.DEFAULT_CURSOR)
      expect(DevCycle.parseCursor("# Cycle\n\nno frontmatter here")).toEqual(DevCycle.DEFAULT_CURSOR)
      expect(DevCycle.parseCursor("---\nphase: architect\n")).toEqual(DevCycle.DEFAULT_CURSOR)
      expect(DevCycle.parseCursor(frontmatter("deploy", "approved"))).toEqual({
        phase: "discover",
        gate: "approved",
      })
      expect(DevCycle.parseCursor(frontmatter("plan", "yes"))).toEqual({ phase: "plan", gate: "pending" })
    }),
  )

  it.effect("tolerates windows line endings and surrounding whitespace", () =>
    Effect.sync(() => {
      expect(DevCycle.parseCursor("---\r\nphase:   build  \r\ngate: approved\r\n---\r\n")).toEqual({
        phase: "build",
        gate: "approved",
      })
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

From `packages/opencode`: `bun test test/session/dev-cycle-mode.test.ts`
Expected: FAIL — cannot resolve module `@/session/dev-cycle`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/opencode/src/session/dev-cycle.ts`:

```typescript
export const PHASES = ["discover", "architect", "plan", "build", "verify"] as const

export type Phase = (typeof PHASES)[number]
export type Gate = "pending" | "approved"
export type Cursor = { phase: Phase; gate: Gate }

export const DEFAULT_CURSOR: Cursor = { phase: "discover", gate: "pending" }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const FIELD = (name: string) => new RegExp(`^${name}:[ \\t]*(\\S+)[ \\t]*$`, "m")

/**
 * Reads the phase cursor out of the artifact's frontmatter.
 *
 * Both the model and the human edit this block, so every input here is
 * untrusted: anything unrecognised degrades to DEFAULT_CURSOR rather than
 * throwing. A cycle that cannot be parsed restarts at discover, which is
 * recoverable; a reminder that throws takes the whole turn down.
 */
export function parseCursor(text: string | undefined): Cursor {
  const block = text?.match(FRONTMATTER)?.[1]
  if (!block) return DEFAULT_CURSOR

  const phase = block.match(FIELD("phase"))?.[1]
  const gate = block.match(FIELD("gate"))?.[1]

  return {
    phase: PHASES.includes(phase as Phase) ? (phase as Phase) : DEFAULT_CURSOR.phase,
    gate: gate === "approved" ? "approved" : DEFAULT_CURSOR.gate,
  }
}

export * as DevCycle from "./dev-cycle"
```

- [ ] **Step 4: Run test to verify it passes**

From `packages/opencode`: `bun test test/session/dev-cycle-mode.test.ts` → PASS (5 tests).
Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/session/dev-cycle.ts packages/opencode/test/session/dev-cycle-mode.test.ts
git commit -m "feat(dev-cycle): add phase cursor frontmatter parser"
```

---

### Task 3: `dev-cycle` agent entry

**Files:**
- Modify: `packages/opencode/src/agent/agent.ts` (insert after the `research` entry ending at line 212)
- Test: `packages/opencode/test/session/dev-cycle-mode.test.ts` (append)

**Interfaces:**
- Consumes: `Permission.merge`, `Permission.fromConfig`, the `defaults` ruleset (`agent.ts:119-136`), `user` (`agent.ts:138`).
- Produces: an agent retrievable via `agents.get("dev-cycle")` with `mode: "primary"`, `native: true`, `prompt` undefined.

- [ ] **Step 1: Write the failing test**

Append to `packages/opencode/test/session/dev-cycle-mode.test.ts`:

```typescript
describe("dev-cycle mode agent", () => {
  it.instance("carries no prompt, so the provider system prompt is retained", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const devcycle = yield* agents.get("dev-cycle")

      expect(devcycle).toBeDefined()
      expect(devcycle?.mode).toBe("primary")
      // `prompt` replaces SystemPrompt.provider() for primary agents (XCOD-45).
      expect(devcycle?.prompt).toBeUndefined()
    }),
  )

  // Parity with `plan` rather than a literal "allow", for the same reason the
  // research test gives at research-mode.test.ts:100-107: these scalar rules
  // resolve through glob matching whose behaviour on a non-path subject is a
  // quirk `plan` has already shipped with. The invariant that matters is that
  // dev-cycle is never more restricted than plan for the tool its gates need.
  it.instance("allows question at least as freely as plan, since every gate depends on it", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const devcycle = yield* agents.get("dev-cycle")
      const plan = yield* agents.get("plan")

      expect(Permission.evaluate("question", "", devcycle.permission).action).toBe(
        Permission.evaluate("question", "", plan.permission).action,
      )
    }),
  )

  it.instance("does not deny task, so phases can delegate to subagents", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const devcycle = yield* agents.get("dev-cycle")
      const plan = yield* agents.get("plan")

      // plan denies task.general; this mode must not.
      expect(Permission.evaluate("task", "general", plan.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "general", devcycle.permission).action).not.toBe("deny")
    }),
  )

  it.instance("can edit the codebase, unlike plan and research", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const devcycle = yield* agents.get("dev-cycle")
      const research = yield* agents.get("research")

      expect(Permission.evaluate("edit", "packages/opencode/src/index.ts", devcycle.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "packages/opencode/src/index.ts", research.permission).action).toBe("deny")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

From `packages/opencode`: `bun test test/session/dev-cycle-mode.test.ts`
Expected: FAIL — `agents.get("dev-cycle")` returns undefined / throws.

- [ ] **Step 3: Write minimal implementation**

In `packages/opencode/src/agent/agent.ts`, insert immediately after the closing brace of the `research` entry (line 212) and before `general:`:

```typescript
          "dev-cycle": {
            name: "dev-cycle",
            description:
              "Full development cycle — discover, architect, plan, build and verify, with human approval gates between phases.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                // Every gate is a `question` call, and question is denied by default.
                question: "allow",
                // Unlike `plan`, no `task: { general: "deny" }` — each phase
                // delegates to a subagent.
                //
                // Also unlike `plan`/`research`, no `edit` restriction: this
                // mode implements code and inherits "*": "allow" from defaults.
                // The gates are prompt-level, not permission-level.
                external_directory: {
                  [path.join(Global.Path.data, "dev-cycle", "*")]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
            // Deliberately no `prompt` — see the note on the `research` entry
            // above. Steered by a per-turn reminder (session/reminders.ts).
          },
```

Note: the `external_directory` entry is load-bearing even though `edit` is permissive — it is a separate gate raised by `edit.ts:83` for non-VCS projects whose artifacts resolve outside the worktree.

- [ ] **Step 4: Run test to verify it passes**

From `packages/opencode`: `bun test test/session/dev-cycle-mode.test.ts` → PASS (9 tests).
Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/agent.ts packages/opencode/test/session/dev-cycle-mode.test.ts
git commit -m "feat(dev-cycle): register dev-cycle primary agent"
```

---

### Task 4: Reminder prompt and `reminders.ts` branch

**Files:**
- Create: `packages/opencode/src/session/prompt/dev-cycle-mode.txt`
- Modify: `packages/opencode/src/session/reminders.ts` (imports at 11-14; new branch after the `research` branch ends at line 48)
- Test: `packages/opencode/test/session/dev-cycle-mode.test.ts` (append)

**Interfaces:**
- Consumes: `Session.devcycle` (Task 1), `DevCycle.parseCursor` (Task 2), the `dev-cycle` agent (Task 3), `fsys.existsSafe` / `fsys.readFileStringSafe` (`packages/core/src/fs-util.ts:34-35`).
- Produces: a synthetic text part appended to the last user message whenever `agent.name === "dev-cycle"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/opencode/test/session/dev-cycle-mode.test.ts`. **No new imports are required** — the preamble copied in Task 1 (from `research-mode.test.ts:1-56`) already provides `SessionV1`, `MessageID`, `SessionReminders`, `InstanceState`, `Agent`, and `SessionNs`; `Bun.write` is a global.

Add this seed-capable helper (it replaces the plain `applyFor` copied from the research test — the difference is the `seed` parameter, which writes the artifact before `apply` runs):

```typescript
const userMessage = (input: { sessionID: string; messageID: string }) => ({
  info: {
    id: input.messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
  } as unknown as SessionV1.Info,
  parts: [] as SessionV1.Part[],
})

const reminderText = (parts: SessionV1.Part[]) =>
  parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const applyFor = (agentName: string, seed?: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const agents = yield* Agent.Service
    const ctx = yield* InstanceState.context
    const session = yield* sessions.create({})
    const agent = yield* agents.get(agentName)
    const messageID = MessageID.ascending()
    const file = SessionNs.devcycle(session, ctx)

    if (seed !== undefined) yield* Effect.promise(() => Bun.write(file, seed))

    yield* sessions.updateMessage({
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "user",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as SessionV1.Info)

    const messages = [userMessage({ sessionID: session.id, messageID })] as any
    const result = yield* SessionReminders.apply({ messages, agent, session })
    return { session, file, parts: result[0].parts }
  })

describe("dev-cycle mode reminder", () => {
  it.instance("injects a reminder carrying the resolved artifact path", () =>
    Effect.gen(function* () {
      const { file, parts } = yield* applyFor("dev-cycle")
      const text = reminderText(parts)

      expect(text).toContain("Dev-cycle mode is active")
      expect(text).toContain("No cycle file exists yet")
      expect(text).toContain(file)
      // The placeholder must be interpolated, never emitted literally.
      expect(text).not.toContain("${cycleInfo}")
      // A fresh cycle starts at the first phase with its gate unapproved.
      expect(text).toContain("discover")
      expect(text).toContain("pending")
    }),
  )

  it.instance("injects the cursor parsed from an existing artifact", () =>
    Effect.gen(function* () {
      const { file, parts } = yield* applyFor("dev-cycle", "---\nphase: plan\ngate: approved\n---\n\n# Cycle\n")
      const text = reminderText(parts)

      expect(text).toContain("A cycle file already exists")
      expect(text).toContain(file)
      expect(text).toContain("plan")
      expect(text).toContain("approved")
    }),
  )

  it.instance("degrades to discover/pending on malformed frontmatter", () =>
    Effect.gen(function* () {
      const { parts } = yield* applyFor("dev-cycle", "# Cycle\n\nsomebody deleted the frontmatter\n")
      const text = reminderText(parts)

      expect(text).toContain("discover")
      expect(text).toContain("pending")
    }),
  )

  // The cursor value `build` and the agent name `build` are different
  // namespaces that now share one module: reminders.ts already branches on
  // input.agent.name === "build" (reminders.ts:61-71). This pins them apart.
  it.instance("does not fire for build mode, even with a phase: build artifact", () =>
    Effect.gen(function* () {
      const { parts } = yield* applyFor("build", "---\nphase: build\ngate: pending\n---\n")
      expect(reminderText(parts)).not.toContain("Dev-cycle mode is active")
    }),
  )

  it.instance("leaves the plan and research reminders untouched", () =>
    Effect.gen(function* () {
      const plan = yield* applyFor("plan")
      expect(reminderText(plan.parts)).toContain("Plan mode")
      expect(reminderText(plan.parts)).not.toContain("Dev-cycle mode is active")

      const research = yield* applyFor("research")
      expect(reminderText(research.parts)).toContain("Research mode is active")
      expect(reminderText(research.parts)).not.toContain("Dev-cycle mode is active")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

From `packages/opencode`: `bun test test/session/dev-cycle-mode.test.ts`
Expected: FAIL — no reminder text containing "Dev-cycle mode is active".

- [ ] **Step 3a: Create the reminder prompt**

Create `packages/opencode/src/session/prompt/dev-cycle-mode.txt`:

```
<system-reminder>
Dev-cycle mode is active. You are running one feature through a four-phase development cycle, and you are NOT free to move through it at your own pace: three of the phases end in a gate that only the human can open.

## Cycle File Info:
${cycleInfo}

The cycle file is both your working document and your position marker. Its frontmatter is the single source of truth for where you are:

---
phase: discover | architect | plan | build | verify
gate: pending | approved
---

The human may edit that frontmatter between turns to approve, rewind, or redirect you. The position quoted above is read fresh from the file every turn -- trust it over your own memory of what you were doing.

## The phases

1. discover -- Understand the request and the code that surrounds it. Dispatch `explore` subagents, IN PARALLEL (single message, multiple tool calls) when the investigation has independent parts. Write findings into the cycle file. NO GATE: continue straight to architect.
2. architect -- Dispatch the `architect` subagent. Design the approach, the interfaces, and the trade-offs; record the alternatives you rejected and why. GATE 1 follows.
3. plan -- Dispatch the `planner` subagent. Break the approved architecture into ordered, independently testable steps. GATE 2 follows.
4. build + verify -- Implement the approved plan yourself; you hold the plan context and the write permissions. Then dispatch the `qa` subagent to review and test what you wrote -- it must be a different agent from the one that wrote the code, because the point is fresh eyes. GATE 3 follows.

## Gate protocol

At a gate you MUST, in this order:
1. Write the finished phase's section into the cycle file.
2. Set `gate: pending` in the frontmatter.
3. Call the `question` tool to put the decision to the human.
4. END YOUR TURN.

When the human approves: set `gate: approved`, advance `phase:` to the next value, and continue. When the human rejects: revise the current phase's section in place and present it again. Do NOT advance.

## Advancing a phase without an approved gate is a violation

The gates are the entire point of this mode. Writing code before gate 2 is approved, or calling the cycle finished before gate 3 is approved, is a failure of this mode even when you are confident the work is right. Confidence is not approval. If you think a gate is unnecessary, say so and ask -- do not skip it.

Equally, do not stall: phase 1 has no gate, so do not ask for approval of your findings before moving to architect.

## If verification fails

Set `phase: build`, leave `gate: pending`, append what failed to the cycle file, and fix it. A failed verification does not re-open the approved plan -- if you believe the plan itself is wrong, that is a question for the human, not a decision for you.

NOTE: At any point you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent.
</system-reminder>
```

- [ ] **Step 3b: Wire the reminder branch**

In `packages/opencode/src/session/reminders.ts`, add to the imports (after line 14):

```typescript
import DEV_CYCLE_MODE from "./prompt/dev-cycle-mode.txt"
import { DevCycle } from "./dev-cycle"
```

Then insert this branch immediately after the `research` branch closes (after line 48, before `if (!flags.experimentalPlanMode) {`):

```typescript
  // Like research, dev-cycle is independent of the plan-mode flag: its
  // reminder carries both the output path and the phase cursor, so it always
  // follows the path-bearing shape above.
  if (input.agent.name === "dev-cycle") {
    const ctx = yield* InstanceState.context
    const file = Session.devcycle(input.session, ctx)
    const exists = yield* fsys.existsSafe(file)
    if (!exists) yield* fsys.ensureDir(path.dirname(file)).pipe(Effect.catch(Effect.die))
    // Read every turn, never cache: the human edits this frontmatter to
    // approve or rewind a gate, and that must take effect on the next turn.
    // `readFileStringSafe` carries an Error channel (fs-util.ts:35) that this
    // file has no precedent for handling — `orElseSucceed` is verified in use
    // across packages/*/src (26 call sites, e.g. packages/core/src/npm.ts).
    // A file we cannot read degrades to the default cursor; it never throws.
    const contents = exists
      ? yield* fsys.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      : undefined
    const cursor = DevCycle.parseCursor(contents)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: DEV_CYCLE_MODE.replace("${cycleInfo}", () =>
        [
          exists
            ? `A cycle file already exists at ${file}. Read it and make incremental edits using the edit tool.`
            : `No cycle file exists yet. Create it at ${file} using the write tool, opening with the frontmatter block described below.`,
          `Current phase: ${cursor.phase}. Gate at the end of this phase: ${cursor.gate}.`,
        ].join("\n"),
      ),
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }
```

- [ ] **Step 4: Run test to verify it passes**

From `packages/opencode`: `bun test test/session/dev-cycle-mode.test.ts` → PASS (14 tests).
Then the full suite: `bun test --timeout 30000 --only-failures`. Expected: no new failures against the 4 known `cf-ai-gateway` baseline failures. Check the exit code directly — do not pipe to `tail`.
Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/session/prompt/dev-cycle-mode.txt packages/opencode/src/session/reminders.ts packages/opencode/test/session/dev-cycle-mode.test.ts
git commit -m "feat(dev-cycle): steer dev-cycle mode by per-turn phase reminder"
```

---

### Task 5: Phase subagents

**Files:**
- Create: `.opencode/agent/architect.md`
- Create: `.opencode/agent/planner.md`
- Create: `.opencode/agent/qa.md`

**Interfaces:**
- Consumes: the markdown agent loader that already reads `.opencode/agent/*.md`.
- Produces: three agents named `architect`, `planner`, `qa`, dispatchable by the `task` tool from the reminder in Task 4.

**Verification note:** these are config files, not code — there is no unit test seam. The frontmatter below mirrors `.opencode/agent/triage.md`, a working example in this repo, rather than being derived from `ConfigAgent.Info` (`packages/core/src/config/agent.ts:13-25`) alone — `triage.md` uses a `tools:` key absent from that schema, so the working file is the more reliable reference.

That means the `tools:` blocks use `triage.md`'s **proven deny-all-then-allow form** (`"*": false` plus explicit allows), not a per-tool `false` form, which is unverified. Tool names are taken from the files in `packages/opencode/src/tool/` and from the `explore` agent's allow-list (`agent.ts:231-240`): `read`, `grep`, `glob`, `list`, `bash`, `webfetch`, `websearch`.

**Read this before Step 4:** if the `tools:` key is silently ignored by the loader, `architect` and `planner` would quietly hold write access, defeating the read-only property §5 of the spec depends on. Step 4 checks that the agents *load*; confirming they lack write may not be possible from `agent list` alone. If it isn't, treat their read-only status as prompt-level only — consistent with the advisory-gate decision — and say so rather than assuming it is enforced.

- [ ] **Step 1: Create the architect subagent**

Create `.opencode/agent/architect.md`:

```markdown
---
mode: subagent
description: Designs the approach for a feature — interfaces, trade-offs, and rejected alternatives. Read-only: produces a design, never an edit.
color: "#7C8EF5"
tools:
  "*": false
  read: true
  grep: true
  glob: true
  list: true
  webfetch: true
  websearch: true
---

You design the approach for one feature. You do not implement it.

Given a goal and the findings from a discovery phase, produce:

- The approach you recommend, and precisely why
- The interfaces it introduces or changes — exact names, parameters, return types
- The alternatives you rejected, each with the reason you rejected it
- The risks and the constraints the implementer must respect
- Anything that is still genuinely open, marked as open

Ground every claim about existing code in a file path, with a line range where practical. Read the code before you design against it; do not design from memory.

Prefer the smallest design that meets the goal. Remove anything the goal does not require. If the goal itself seems wrong or underspecified, say so plainly rather than designing around it.

You have no write tools. Your deliverable is your response.
```

- [ ] **Step 2: Create the planner subagent**

Create `.opencode/agent/planner.md`:

```markdown
---
mode: subagent
description: Breaks an approved architecture into ordered, independently testable implementation steps.
color: "#5FB37E"
tools:
  "*": false
  read: true
  grep: true
  glob: true
  list: true
---

You turn an approved architecture into an ordered implementation plan. You do not implement it.

Produce a sequence of tasks where each one:

- Names the exact files it creates or modifies, with line numbers for modifications
- States what it consumes from earlier tasks and what later tasks rely on — exact signatures
- Ends in a deliverable that can be tested on its own
- Carries its own test cycle: the failing test, the command that runs it, the minimal implementation, the passing run

Order tasks so that each one leaves the tree working. Fold setup, configuration, and documentation into the task whose deliverable needs them; split only where a reviewer could reject one task while approving its neighbour.

No placeholders. "Add error handling", "write tests for the above", and "similar to task 2" are plan failures — write the actual content, repeating it where it recurs.

You have no write tools. Your deliverable is your response.
```

- [ ] **Step 3: Create the qa subagent**

Create `.opencode/agent/qa.md`:

```markdown
---
mode: subagent
description: Reviews and tests an implementation written by another agent. Runs the suite, reports what actually happened.
color: "#D98A4B"
tools:
  "*": false
  read: true
  grep: true
  glob: true
  list: true
  bash: true
---

You verify work you did not write. That is the entire value you add here — approach the diff as evidence to be checked, not as a result to be confirmed.

Do all of this:

- Read the diff against the plan it claims to implement. Note anything implemented that the plan did not ask for, and anything the plan asked for that is missing.
- Run the test suite and the typecheck. Report the actual output, including the exit code.
- Distinguish new failures from pre-existing ones. Check a failure against the baseline before calling it a regression.
- Look for the failure modes tests miss: swallowed errors, unhandled edge cases, assumptions that hold only for the happy path.

Report what you found, with file paths and line numbers. If it passes, say so plainly and show the output that proves it. If it does not, lead with what is broken — do not bury a failure under things that went well.

Never fix what you find. Report it; the implementer fixes it. A reviewer who edits the code stops being an independent check.
```

- [ ] **Step 4: Verify the agents load**

From the repo root:

```bash
bun run --cwd packages/opencode src/index.ts agent list
```

Expected: `architect`, `planner`, and `qa` appear in the output alongside the built-ins. If any is missing, the frontmatter failed to parse — compare against `.opencode/agent/triage.md`.

Then check whether the output also surfaces per-agent tools or permissions. **If it does**, confirm `architect` and `planner` show no write/edit capability. **If it does not**, record in the commit message that their read-only status is prompt-level only and unverified at the config layer — do not claim an enforcement this step did not check. `qa` retains `bash` deliberately: it has to run the suite.

- [ ] **Step 5: Commit**

```bash
git add .opencode/agent/architect.md .opencode/agent/planner.md .opencode/agent/qa.md
git commit -m "feat(dev-cycle): add architect, planner and qa phase subagents"
```

---

### Task 6: Document the mode

**Files:**
- Modify: `packages/web/src/content/docs/agents.mdx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

Only the English source is updated. The translated copies under `packages/web/src/content/docs/<lang>/agents.mdx` are handled by the existing translation workflow, not by hand.

- [ ] **Step 1: Read the existing mode documentation**

Open `packages/web/src/content/docs/agents.mdx` and read the `### Use research` section at line 71 and the prose at lines 75-77. That is the format to match: an `### Use <name>` heading followed by short prose paragraphs — no tables, no bullet lists.

- [ ] **Step 2: Add the dev-cycle section**

Insert after the `### Use research` section's prose (after line 77), matching its voice:

````mdx
### Use dev-cycle

An agent that runs one feature through a full development cycle — discover, architect, plan, then build and verify — pausing for your approval at three gates. Each phase delegates to a dedicated subagent: `explore` for discovery, then `architect`, `planner`, and finally `qa` to review code it did not write.

The cycle's working document lives at `.opencode/dev-cycle/` in a Git project, or the global data directory otherwise. Its frontmatter carries the position:

```markdown
---
phase: architect
gate: pending
---
```

That position is read from the file at the start of every turn, so editing those two lines is how you approve a gate, rewind to an earlier phase, or redirect a cycle mid-flight.

The gates are advisory. Unlike `plan` and `research`, this agent holds full write permissions for the whole run — it is *instructed* to stop at each gate rather than prevented from continuing, so a cycle that ignores a gate is possible. Review the diff at gate 3 rather than assuming nothing was written before gate 2 opened.
````

- [ ] **Step 3: Verify the docs build**

From the repo root: `bun run --cwd packages/web build` (runs `astro build`)
Expected: builds clean, no MDX parse errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/content/docs/agents.mdx
git commit -m "docs(dev-cycle): document the dev-cycle mode and its advisory gates"
```

---

## Final verification

- [ ] From `packages/opencode`: `bun test --timeout 30000 --only-failures` — no new failures against the 4-failure `cf-ai-gateway` baseline. Check the exit code; do not pipe to `tail`.
- [ ] From `packages/opencode`: `bun run typecheck` — clean.
- [ ] From the repo root: `bun run lint` — clean.
- [ ] `bun run --cwd packages/opencode src/index.ts agent list` shows `dev-cycle` as a primary mode and `architect`/`planner`/`qa` as subagents.
- [ ] Manual smoke test: start Lunos, switch to `dev-cycle`, give it a small task. Confirm it creates `.opencode/dev-cycle/<timestamp>-<slug>.md`, writes discovery findings, and stops at gate 1 with a `question` call rather than proceeding to write code.
