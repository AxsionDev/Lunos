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
  input: { text?: string; reasoning?: string; tools?: { tool: string; status: string; answers?: string[][] }[] },
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
      state: { status: tool.status, metadata: tool.answers ? { answers: tool.answers } : {} },
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

    const typed = user("approved")
    expect(classify([typed, assistant(typed, { text: stall })], gated)).toEqual({
      kind: "stalled",
      label: "plan approved → build",
      note: "record it",
    })

    const picked = assistant(asked, { tools: [{ tool: "question", status: "completed", answers: [["Approve"]] }] })
    expect(classify([asked, picked, assistant(asked, { text: stall })], gated).kind).toBe("stalled")
    const rejected = assistant(asked, { tools: [{ tool: "question", status: "completed", answers: [["Revise"]] }] })
    expect(classify([asked, rejected, assistant(asked, { text: stall })], gated).kind).toBe("gate")
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
    const u = user("approved")
    const c1 = cont(1)
    expect(AutoContinue.approved([u, assistant(u, { text: "…" }), c1, assistant(c1, { text: "…" })])).toBe(true)
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
