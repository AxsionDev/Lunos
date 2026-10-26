import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AutoContinue } from "@/session/auto-continue"
import { DevCycle } from "@/session/dev-cycle"
import { ConfigPolicy } from "@/config/policy"
import DEV_CYCLE_MODE from "@/session/prompt/dev-cycle-mode.txt"

// XCOD-302: the stop classification, pure. The end-to-end behaviour on the live loop is in
// auto-continue-loop.test.ts.

let seq = 0
const id = () => `msg_${String(++seq).padStart(6, "0")}`

function user(text: string, metadata?: Record<string, unknown>, synthetic = false): SessionV1.WithParts {
  const info = { id: id(), role: "user", sessionID: "ses_1", time: { created: seq }, agent: "dev-cycle" }
  return {
    info,
    parts: [{ id: id(), messageID: info.id, sessionID: "ses_1", type: "text", text, synthetic, metadata }],
  } as unknown as SessionV1.WithParts
}

function assistant(
  parent: SessionV1.WithParts,
  input: {
    text?: string
    reasoning?: string
    tools?: { tool: string; status: string; answers?: string[][]; questions?: string[] }[]
  },
  info: Record<string, unknown> = {},
): SessionV1.WithParts {
  const message = {
    id: id(),
    role: "assistant",
    sessionID: "ses_1",
    parentID: parent.info.id,
    time: { created: seq },
    finish: "stop",
    ...info,
  }
  const parts: unknown[] = []
  if (input.reasoning) parts.push({ type: "reasoning", text: input.reasoning })
  for (const tool of input.tools ?? [])
    parts.push({
      type: "tool",
      tool: tool.tool,
      state: {
        status: tool.status,
        input: { questions: (tool.questions ?? []).map((question) => ({ question, header: "Question" })) },
        metadata: tool.answers ? { answers: tool.answers } : {},
      },
    })
  if (input.text !== undefined) parts.push({ type: "text", text: input.text })
  return { info: message, parts } as unknown as SessionV1.WithParts
}

const open: AutoContinue.Position = { unknown: false, done: false, pending: false, label: "plan approved → build" }

const classify = (messages: SessionV1.WithParts[], position = open, emptyStalls = true) =>
  AutoContinue.classify({ messages, position, emptyStalls })

describe("announces", () => {
  const stalls = [
    "Plan approved. Next I'll implement the IIS-deployable host vertical slice and verify it before progressing.",
    "Gate 2 is approved. I'll now start on step 1.",
    "Moving on to the build phase.",
    "Let me start with the first step.",
    "Proceeding with step 2 of the plan.",
    "I am going to write the migration next.",
    "Next I’ll implement the host.",
  ]
  const finished = [
    "Added GET /health; the tests pass.",
    "Verification\n✓ npm run build (14 s)\n✓ npm test: 128 passed\n✓ GET /api/health → 200\nApp is still running at http://localhost:4200",
    "Added the endpoint.\n\nNext steps: deploy to staging.",
    "Done. You can now run `npm start` to try it.",
    "Let me know if you want the cache too.",
    "I'll wait for your approval before building.",
    "I'll start building once you approve the plan.",
    "I'll implement it if you want.",
    "The plan is written to the cycle file and is waiting for your decision.",
    "I'll leave the review to the qa agent's report above.\n\nAll checks passed.",
  ]
  for (const text of stalls) test(`stall: ${text.slice(0, 50)}`, () => expect(AutoContinue.announces(text)).toBe(true))
  for (const text of finished)
    test(`finished: ${text.slice(0, 50).replace(/\n/g, " ")}`, () => expect(AutoContinue.announces(text)).toBe(false))
})

describe("asks", () => {
  test("a direct question at the end", () => {
    expect(AutoContinue.asks("I'll need a database. Should I use PostgreSQL or SQLite?")).toBe(true)
    expect(AutoContinue.asks("Which option do you prefer?**")).toBe(true)
  })
  test("a question mid-text isn't one", () => {
    expect(AutoContinue.asks("Why did it fail? The port was taken. Next I'll free it.")).toBe(false)
  })
})

describe("approves", () => {
  for (const text of [
    "approved",
    "Approved.",
    "yes",
    "LGTM",
    "proceed",
    "go ahead",
    "approve the plan",
    "Yes, proceed",
  ])
    test(`approval: ${text}`, () => expect(AutoContinue.approves(text)).toBe(true))
  for (const text of [
    "Approve, but change the endpoint name",
    "not approved",
    "no",
    "revise the plan",
    "Approved?? why is step 3 there, wait",
    "what about caching",
    "Reject",
    "Revise",
  ])
    test(`not an approval: ${text}`, () => expect(AutoContinue.approves(text)).toBe(false))
  test("question-tool option labels", () => {
    expect(AutoContinue.approves("Approve")).toBe(true)
    expect(AutoContinue.approves("Approve plan (gate 2)")).toBe(true)
  })
})

describe("classify", () => {
  test("a stalled turn after approval continues, with its label", () => {
    const u = user("Approved.")
    expect(classify([u, assistant(u, { text: "Plan approved. Next I'll implement the host." })])).toEqual({
      kind: "stalled",
      label: "plan approved → build",
    })
  })

  test("reasoning is never read: only the words the model said", () => {
    const u = user("Approved.")
    const a = assistant(u, { reasoning: "I'll call glob next.", text: "Step 1 is built." })
    expect(classify([u, a])).toEqual({ kind: "finished" })
  })

  test("an empty turn stalls Dev-Cycle but finishes Build", () => {
    const u = user("Approved.")
    const a = assistant(u, { text: "" })
    expect(classify([u, a]).kind).toBe("stalled")
    expect(classify([u, a], open, false).kind).toBe("finished")
  })

  test("errors, interrupts and limits stop with the reason", () => {
    const u = user("Approved.")
    const text = "Next I'll implement it."
    expect(classify([u, assistant(u, { text }, { error: { name: "MessageAbortedError" } })])).toEqual({
      kind: "error",
      reason: "MessageAbortedError",
    })
    expect(classify([u, assistant(u, { text }, { finish: "length" })]).kind).toBe("error")
    expect(
      AutoContinue.classify({
        messages: [u, assistant(u, { text })],
        position: open,
        emptyStalls: true,
        limit: "step limit",
      }),
    ).toEqual({ kind: "error", reason: "step limit" })
  })

  test("a question waits", () => {
    const u = user("Approved.")
    expect(classify([u, assistant(u, { text: "Next I'll build it. Or should I wait?" })]).kind).toBe("question")
    expect(
      classify([u, assistant(u, { text: "Next I'll build.", tools: [{ tool: "question", status: "running" }] })]).kind,
    ).toBe("question")
  })

  test("an unknown position or a finished cycle never continues", () => {
    const u = user("Approved.")
    const a = assistant(u, { text: "Next I'll implement it." })
    expect(classify([u, a], { ...open, unknown: true }).kind).toBe("unknown")
    expect(classify([u, a], { ...open, done: true }).kind).toBe("done")
  })

  test("a pending gate holds unless the human approved this turn", () => {
    const gated: AutoContinue.Position = {
      unknown: false,
      done: false,
      pending: true,
      label: "plan",
      approved: { label: "plan approved → build", note: "record it" },
    }
    const stall = "Next I'll implement step 1."
    const asked = user("Write the plan.")
    expect(classify([asked, assistant(asked, { text: stall })], gated).kind).toBe("gate")

    // A typed approval counts only as the reply to a gate the turn before put to the human.
    const gateAsked = assistant(asked, {
      tools: [{ tool: "question", status: "error", questions: ["Approve the plan (gate 2)?"] }],
    })
    const typed = user("approved")
    expect(classify([asked, gateAsked, typed, assistant(typed, { text: stall })], gated)).toEqual({
      kind: "stalled",
      label: "plan approved → build",
      note: "record it",
    })
    const askedInText = assistant(asked, { text: "The plan is in the cycle file. Do you approve it?" })
    expect(classify([asked, askedInText, typed, assistant(typed, { text: stall })], gated).kind).toBe("stalled")

    const gate = ["Approve the plan?"]
    const picked = assistant(asked, {
      tools: [{ tool: "question", status: "completed", questions: gate, answers: [["Approve"]] }],
    })
    expect(classify([asked, picked, assistant(asked, { text: stall })], gated).kind).toBe("stalled")
    const rejected = assistant(asked, {
      tools: [{ tool: "question", status: "completed", questions: gate, answers: [["Revise"]] }],
    })
    expect(classify([asked, rejected, assistant(asked, { text: stall })], gated).kind).toBe("gate")
  })

  test("a nudge mid-phase, or a yes to another question, approves no gate", () => {
    const gated: AutoContinue.Position = { unknown: false, done: false, pending: true, approved: { label: "x" } }
    const stall = "Next I'll dispatch the architect subagent."
    const asked = user("Design it.")
    const nudge = user("proceed")
    const msgs = [asked, assistant(asked, { text: stall }), nudge, assistant(nudge, { text: stall })]
    expect(classify(msgs, gated).kind).toBe("gate")

    const other = assistant(asked, {
      tools: [{ tool: "question", status: "completed", questions: ["Include caching?"], answers: [["Yes"]] }],
    })
    expect(classify([asked, other, assistant(asked, { text: stall })], gated).kind).toBe("gate")
  })
})

describe("streak and approval history", () => {
  const cont = (n: number) =>
    user("Continue the current phase now.", { [AutoContinue.METADATA]: { label: "x", attempt: n } }, true)

  test("counts continuations in a row that made no progress", () => {
    const u = user("Approved.")
    const c1 = cont(1)
    const c2 = cont(2)
    const msgs = [
      u,
      assistant(u, { text: "Next I'll…" }),
      c1,
      assistant(c1, { text: "Next I'll…" }),
      c2,
      assistant(c2, { text: "Next I'll…" }),
    ]
    expect(AutoContinue.streak(msgs)).toBe(2)
    expect(AutoContinue.streak(msgs.slice(0, 2))).toBe(0)
  })

  test("a tool call is progress and resets it", () => {
    const u = user("Approved.")
    const c1 = cont(1)
    const c2 = cont(2)
    const msgs = [
      u,
      c1,
      assistant(c1, { tools: [{ tool: "glob", status: "completed" }] }),
      assistant(c1, { text: "Next I'll…" }),
      c2,
      assistant(c2, { text: "Next I'll…" }),
    ]
    expect(AutoContinue.streak(msgs)).toBe(1)
  })

  test("Lunos's own continuations and the Continue button are never approvals", () => {
    const first = user("Write the plan.")
    const ask = assistant(first, { text: "Gate 2: approve the plan?" })
    const u = user("approved")
    const c1 = cont(1)
    const msgs = [first, ask, u, assistant(u, { text: "…" }), c1, assistant(c1, { text: "…" })]
    expect(AutoContinue.approved(msgs)).toBe(true)
    // Approval read through Lunos's continuations still needs the gate the human replied to.
    expect(AutoContinue.approved(msgs.slice(2))).toBe(false)
    const resume = user("Continue.", { [AutoContinue.RESUME]: true })
    expect(AutoContinue.approved([resume, assistant(resume, { text: "…" })])).toBe(false)
  })
})

describe("Dev-Cycle position", () => {
  const file = (phase: string, gate: string) => `---\nphase: ${phase}\ngate: ${gate}\n---\n\n# Cycle\n`

  test("no cycle file yet is discover, which has no gate", () => {
    expect(DevCycle.position({ exists: false })).toMatchObject({
      unknown: false,
      done: false,
      pending: false,
      label: "discover",
    })
  })

  test("after an approval: the label names the gate passed", () => {
    expect(DevCycle.position({ exists: true, contents: file("build", "approved") })).toMatchObject({
      pending: false,
      label: "plan approved → build",
    })
    expect(DevCycle.position({ exists: true, contents: file("plan", "approved") }).label).toBe(
      "architect approved → plan",
    )
  })

  test("a pending gate holds, and says what approving it means", () => {
    const position = DevCycle.position({ exists: true, contents: file("plan", "pending") })
    expect(position.pending).toBe(true)
    expect(position.approved?.label).toBe("plan approved → build")
    expect(position.approved?.note).toContain("advance `phase:` to build")
  })

  test("gate 3 approved is done; unreadable frontmatter is unknown", () => {
    expect(DevCycle.position({ exists: true, contents: file("verify", "approved") }).done).toBe(true)
    expect(DevCycle.position({ exists: true, contents: file("Architect", "pending") }).unknown).toBe(true)
  })
})

describe("prompt hardening and settings", () => {
  test("dev-cycle-mode.txt carries the new rules, and keeps the gate rules", () => {
    expect(DEV_CYCLE_MODE).toContain(
      "After an approval, start the next phase in the same turn: the first thing you do is a tool call, not an announcement.",
    )
    expect(DEV_CYCLE_MODE).toContain(
      "Never end a turn with a statement of what you'll do next. Either do it, or ask a question with the `question` tool.",
    )
    expect(DEV_CYCLE_MODE).toContain("3. Call the `question` tool to put the decision to the human.\n4. END YOUR TURN.")
  })

  test("the continuation and the stop message", () => {
    expect(AutoContinue.prompt({ gated: true })).toBe(
      "Continue the current phase now. Don't stop to announce next steps; stop only at a gate, a real question, the end, or an error.",
    )
    expect(AutoContinue.line("Dev-Cycle", "plan approved → build")).toBe(
      "Dev-Cycle continued automatically (plan approved → build)",
    )
    expect(AutoContinue.gaveUp("Dev-Cycle")).toBe("Dev-Cycle stopped making progress after 3 retries.")
  })

  test("an organisation can lock both switches", () => {
    expect(ConfigPolicy.isKnown("dev_cycle")).toBe(true)
    expect(ConfigPolicy.isKnown("dev_cycle.auto_continue")).toBe(true)
    expect(ConfigPolicy.isKnown("agent.build.auto_continue")).toBe(true)
    const resolved = ConfigPolicy.apply(
      { dev_cycle: { auto_continue: true }, agent: { build: { auto_continue: true } } },
      { dev_cycle: { auto_continue: false }, agent: { build: { auto_continue: false } } },
      ["dev_cycle.auto_continue", "agent.build.auto_continue"],
    )
    expect(resolved.dev_cycle).toEqual({ auto_continue: false })
    expect(resolved.agent).toEqual({ build: { auto_continue: false } })
  })
})

// XCOD-324: in a Dynamic workflow the open work decides, not the wording of the turn's last line.
describe("open work (Dynamic workflows)", () => {
  const STATUS = "QA found 5 blocking gaps. The cycle remains in the build phase while I address them."
  const failedQa =
    "Verification\n✓ npm run build (4 s)\n✗ empty email accepted\n✗ 500 on /signup\n✗ no error text\n✗ missing aria-label\n✗ npm test: 2 failed"
  const passedQa = "Verification\n✓ npm run build (4 s)\n✓ npm test: 12 passed\n✓ POST /signup → 400 on empty email"

  /** An assistant message carrying the given tool parts, finished like a real turn. */
  function calls(parent: SessionV1.WithParts, parts: unknown[], text?: string): SessionV1.WithParts {
    const message = assistant(parent, { text })
    return { ...message, parts: [...parts, ...message.parts] } as unknown as SessionV1.WithParts
  }
  let sub = 0
  const task = (
    agent: string,
    description: string,
    result: { output?: string; error?: string; task_id?: string; background?: boolean },
  ) => ({
    type: "tool",
    tool: "task",
    state: {
      status: result.error !== undefined ? "error" : "completed",
      input: { subagent_type: agent, description, prompt: "…", ...(result.task_id ? { task_id: result.task_id } : {}) },
      metadata: { sessionId: result.task_id ?? `ses_sub_${++sub}`, ...(result.background ? { background: true } : {}) },
      ...(result.error !== undefined
        ? { error: result.error }
        : {
            output: result.background
              ? `<task id="ses_sub_${sub}" state="running">\n<task_result>\nworking\n</task_result>\n</task>`
              : `<task id="ses_sub_${sub}" state="completed">\n<task_result>\n${result.output ?? ""}\n</task_result>\n</task>`,
          }),
    },
  })
  const todos = (...statuses: string[]) => ({
    type: "tool",
    tool: "todowrite",
    state: {
      status: "completed",
      input: { todos: statuses.map((status, i) => ({ content: `step ${i}`, status, priority: "high" })) },
    },
  })
  const dyn = (messages: SessionV1.WithParts[], extra: Partial<AutoContinue.Input> = {}) =>
    AutoContinue.classify({ messages, position: open, emptyStalls: false, dynamic: true, ...extra })

  test("the reported bug: qa failed, the turn ends with a status report, and it continues", () => {
    const u = user("Approved.")
    const msgs = [
      u,
      calls(u, [task("general", "build", { output: "Done." }), task("qa", "verify", { output: failedQa })], STATUS),
    ]
    expect(AutoContinue.announces(STATUS)).toBe(false)
    const stop = dyn(msgs)
    expect(stop.kind).toBe("stalled")
    if (stop.kind !== "stalled") return
    expect(stop.work?.gaps).toHaveLength(5)
    expect(stop.work?.check).toEqual({ passing: 1, total: 6 })
    expect(AutoContinue.status(stop.work!)).toBe("Working on 5 gaps · check: 1/6 passing")
    const text = AutoContinue.prompt({ gated: true, work: stop.work, maxParallel: 2 })
    expect(text).toContain("qa reported 5 blocking gaps")
    expect(text).toContain("- ✗ 500 on /signup")
    expect(text).toContain("Turn each gap into an item in the todo list")
    expect(text).toContain("at most 2 at once")
    expect(text).toContain("dispatch qa again")
    // Without Dynamic workflows (the opt-out) it's today's behaviour: a status report finishes.
    expect(classify(msgs, open, false).kind).toBe("finished")
  })

  test("the main agent's own Verification block never counts: only qa's", () => {
    const u = user("Build it.")
    expect(dyn([u, calls(u, [], `Here is where it stands.\n\n${failedQa}`)]).kind).toBe("finished")
  })

  test("a later passing qa report clears the gaps", () => {
    const u = user("Approved.")
    const msgs = [
      u,
      calls(
        u,
        [
          task("qa", "verify", { output: failedQa }),
          task("general", "fix", { output: "Fixed." }),
          task("qa", "verify", { output: passedQa }),
        ],
        "All checks pass.",
      ),
    ]
    expect(dyn(msgs).kind).toBe("finished")
  })

  test("a background qa result, landing as a message of its own, counts", () => {
    const u = user("Approved.")
    const dispatched = calls(u, [task("qa", "verify", { background: true })], "qa is running.")
    const id = (dispatched.parts[0] as unknown as { state: { metadata: { sessionId: string } } }).state.metadata
      .sessionId
    const landed = user(
      `<task id="${id}" state="completed">\n<summary>Background task completed: verify</summary>\n<task_result>\n${failedQa}\n</task_result>\n</task>`,
      undefined,
      true,
    )
    const stop = dyn([u, dispatched, landed, assistant(landed, { text: STATUS })])
    expect(stop.kind === "stalled" && stop.work?.gaps.length).toBe(5)
  })

  test("open todos continue; all done or cancelled finishes", () => {
    const u = user("Build it.")
    const stop = dyn([u, calls(u, [todos("completed", "in_progress", "pending")], "Step 1 is done.")])
    expect(stop.kind === "stalled" && stop.work?.todos).toBe(2)
    expect(AutoContinue.prompt({ gated: false, work: stop.kind === "stalled" ? stop.work : undefined })).toContain(
      "2 items in the todo list aren't done",
    )
    expect(dyn([u, calls(u, [todos("completed", "cancelled")], "Done.")]).kind).toBe("finished")
  })

  test("mid-phase continues only while a subagent's work hasn't passed qa", () => {
    const u = user("Approved.")
    const built = [u, calls(u, [task("general", "build", { output: "Built." })], "Step 1 is built.")]
    expect(dyn(built, { midPhase: true }).kind).toBe("stalled")
    expect(
      AutoContinue.prompt({ gated: true, work: (dyn(built, { midPhase: true }) as { work: AutoContinue.Work }).work }),
    ).toContain("Dispatch the `qa` subagent")
    expect(dyn(built, { midPhase: false }).kind).toBe("finished")
    // A plain answer in the build phase finishes; so does work qa has passed.
    expect(dyn([u, assistant(u, { text: "It returns false." })], { midPhase: true }).kind).toBe("finished")
    const checked = [
      u,
      calls(
        u,
        [task("general", "build", { output: "Built." }), task("qa", "verify", { output: passedQa })],
        "Built and verified.",
      ),
    ]
    expect(dyn(checked, { midPhase: true }).kind).toBe("finished")
  })

  test("a failed subagent step continues while it may be re-dispatched", () => {
    const u = user("Build it.")
    const stop = dyn([
      u,
      calls(
        u,
        [task("general", "build", { error: "Subagent failed (task_id: x): tsc exited 2" })],
        "The build step failed.",
      ),
    ])
    expect(stop.kind).toBe("stalled")
    if (stop.kind !== "stalled") return
    expect(stop.work?.failed).toEqual([
      { description: "build", error: "Subagent failed (task_id: x): tsc exited 2", exhausted: false },
    ])
    expect(AutoContinue.prompt({ gated: false, work: stop.work })).toContain("pass its task_id")
    // Retried and passed: nothing open.
    const retried = [
      u,
      calls(
        u,
        [task("general", "build", { error: "tsc exited 2" }), task("general", "build", { output: "Fixed." })],
        "Built.",
      ),
    ]
    expect(dyn(retried).kind).toBe("finished")
  })

  test("a subtask a command started isn't the main agent's step: its failure doesn't continue", () => {
    const u = user("/review")
    const subtask = calls(u, [task("general", "review", { error: "subtask failed" })])
    const sub = { ...subtask, info: { ...subtask.info, agent: "general" } } as SessionV1.WithParts
    const main = assistant(u, { text: "The review failed." }, { agent: "build" })
    expect(dyn([u, sub, main]).kind).toBe("finished")
    const own = { ...subtask, info: { ...subtask.info, agent: "build" } } as SessionV1.WithParts
    expect(dyn([u, own, main]).kind).toBe("stalled")
  })

  describe("human-needed stops, each with its one line", () => {
    const u = user("Approved.")
    const end = (parts: unknown[], text = STATUS) => [u, calls(u, parts, text)]

    test("a missing secret or .env value reported by a subagent", () => {
      const secret = dyn(
        end([
          task("qa", "verify", {
            output: "Verification\n✓ build\n✗ Couldn't start the worker: REDIS_URL isn't set (.env.example has it)",
          }),
        ]),
      )
      expect(secret).toEqual({
        kind: "secret",
        reason: "Couldn't start the worker: REDIS_URL isn't set (.env.example has it)",
      })
      expect(AutoContinue.why("Dev-Cycle", secret)).toBe(
        "Dev-Cycle needs a value only you have: Couldn't start the worker: REDIS_URL isn't set (.env.example has it)",
      )
      expect(dyn(end([task("general", "deploy", { error: "STRIPE_SECRET_KEY is not set" })])).kind).toBe("secret")
      // Mixed with gaps it can fix, it fixes those and leaves the secret to the user.
      const mixed = dyn(
        end([task("qa", "verify", { output: "Verification\n✗ 500 on /signup\n✗ the API key is missing from .env" })]),
      )
      expect(mixed.kind).toBe("stalled")
      const text = AutoContinue.prompt({ gated: true, work: mixed.kind === "stalled" ? mixed.work : undefined })
      expect(text).toContain("qa reported 1 blocking gap;")
      expect(text).toContain("Leave these for the user")
    })

    test("a failed check that only mentions a token isn't a missing secret", () => {
      expect(AutoContinue.needsSecret("POST /token returns 401: no Authorization header")).toBe(false)
      expect(AutoContinue.needsSecret("the password field accepts an empty value")).toBe(false)
      expect(AutoContinue.needsSecret("OPENAI_API_KEY isn't set")).toBe(true)
      expect(AutoContinue.needsSecret("no API key in .env")).toBe(true)
    })

    test("a step re-dispatched MAX_REDISPATCH times, or qa failing round after round", () => {
      const refused = 'The step "fix" was re-dispatched 3 times; don\'t dispatch it again.'
      const exhausted = dyn(end([task("general", "fix", { error: refused })]))
      expect(exhausted).toEqual({ kind: "exhausted", reason: '"fix" failed after 3 re-dispatches' })
      expect(AutoContinue.why("Build", exhausted)).toBe('Build needs you: "fix" failed after 3 re-dispatches.')
      const fails = Array.from({ length: 4 }, () => task("qa", "verify", { output: failedQa }))
      expect(dyn(end(fails))).toEqual({ kind: "exhausted", reason: "qa still fails after 3 rounds of fixes" })
      expect(dyn(end(fails.slice(1))).kind).toBe("stalled")
    })

    test("a gate, a question, a pending permission or question, a limit, an error", () => {
      const failing = [task("qa", "verify", { output: failedQa })]
      const gated: AutoContinue.Position = { unknown: false, done: false, pending: true, label: "verify" }
      const gate = dyn(end(failing), { position: gated })
      expect(gate.kind).toBe("gate")
      expect(AutoContinue.why("Dev-Cycle", gate)).toBe("Dev-Cycle is waiting for your approval.")
      const question = dyn(end(failing, "Two gaps need a design decision. Should the API return 400 or 422?"))
      expect(question.kind).toBe("question")
      expect(AutoContinue.why("Build", question)).toBe("Build is waiting for your answer.")
      expect(
        dyn(end([...failing, { type: "tool", tool: "question", state: { status: "running", input: {} } }])).kind,
      ).toBe("question")
      const limit = dyn(end(failing), { limit: "step limit" })
      expect(limit).toEqual({ kind: "error", reason: "step limit" })
      expect(AutoContinue.why("Build", limit)).toBe("Build stopped: step limit.")
      const aborted = [u, assistant(u, { text: STATUS }, { error: { name: "MessageAbortedError" } })]
      expect(dyn(aborted).kind).toBe("error")
      expect(AutoContinue.why("Build", { kind: "finished" })).toBeUndefined()
    })
  })

  test("progress: a changed check result counts, the same one doesn't", () => {
    const cont = (n: number) =>
      user("Continue the current phase now.", { [AutoContinue.METADATA]: { label: "x", attempt: n } }, true)
    const u = user("Approved.")
    const c1 = cont(1)
    const c2 = cont(2)
    const msgs = [
      u,
      calls(u, [task("qa", "verify", { output: failedQa })], STATUS),
      c1,
      assistant(c1, { text: STATUS }),
      c2,
      assistant(c2, { text: STATUS }),
    ]
    expect(AutoContinue.streak(msgs)).toBe(2)
    // A qa result (or any tool call) in the continued turn is progress.
    const c3 = cont(3)
    const changed = [...msgs, c3, calls(c3, [task("qa", "verify", { output: passedQa })], "Passing now.")]
    expect(AutoContinue.streak(changed)).toBe(0)
  })

  test("verification() reads the last block, with or without markdown", () => {
    expect(AutoContinue.verification("**Verification**\n- ✓ build\n- ✗ test\n\nNotes after.")).toEqual([
      { ok: true, text: "build" },
      { ok: false, text: "test" },
    ])
    expect(AutoContinue.verification("No block here.")).toBeUndefined()
  })
})
