/** @jsxImportSource @opentui/solid */
// XCOD-299: the sidebar's Subagents section, split into Working, Waiting for action and Completed,
// rendered in a headless 120x45 terminal against live, changeable state and the real kv.json.
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { KVProvider, useKV } from "../../src/context/kv"
import plugin, { groupsKey } from "../../src/feature-plugins/sidebar/subagents"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

const NOW = Date.now()
const ROOT = "ses_root"

type Part = { type: "tool"; tool: "task"; state: Record<string, unknown> }

function task(id: string, description: string, state: Record<string, unknown> = {}): Part {
  return {
    type: "tool",
    tool: "task",
    state: {
      status: "running",
      input: { subagent_type: "general", description },
      metadata: { sessionId: id },
      time: { start: NOW - 30_000 },
      ...state,
    },
  }
}

/** The ticket's fixture: 2 running, 1 queued, 2 waiting, 1 failed, 1 done. */
function fixture() {
  return {
    messages: { [ROOT]: [{ id: "msg_root" }] } as Record<string, { id: string }[]>,
    parts: {
      msg_root: [
        task("done1", "write the summary", { status: "completed", time: { start: NOW - 90_000, end: NOW - 80_000 } }),
        task("run_new", "update docs", { time: { start: NOW - 10_000 } }),
        task("wait1", "run tests"),
        task("queued1", "lint everything", {
          status: "completed",
          metadata: { sessionId: "queued1", background: true },
        }),
        task("run_old", "write tests", { time: { start: NOW - 72_000 } }),
        task("failed1", "deploy preview", {
          status: "error",
          error: "exit code 1: build failed",
          time: { start: NOW - 50_000, end: NOW - 40_000 },
        }),
        task("wait2", "pick a name"),
      ],
    } as Record<string, Part[]>,
    status: {
      run_new: { type: "busy" },
      run_old: { type: "busy" },
      wait1: { type: "busy" },
      wait2: { type: "busy" },
    } as Record<string, { type: string }>,
    sessions: { queued1: { metadata: { subagent: { queued: true } } } } as Record<string, any>,
    permission: {
      wait1: [
        { id: "per_1", sessionID: "wait1", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] },
      ],
    } as Record<string, any[]>,
    question: {
      wait2: [{ id: "que_1", sessionID: "wait2", questions: [{ question: "Which name?", header: "", options: [] }] }],
    } as Record<string, any[]>,
  }
}

type State = ReturnType<typeof fixture>

let tmp: Awaited<ReturnType<typeof tmpdir>>
let state: string
beforeEach(async () => {
  tmp = await tmpdir()
  state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ subagents_notice_shown: true }))
})
afterEach(async () => {
  delete process.env.NO_COLOR
  await tmp[Symbol.asyncDispose]()
})

/**
 * 120x45, as a terminal is. The sidebar scrolls in the app; `tall` shows all seven subagents at
 * once (each row is five lines) so their whole order can be read off one frame.
 */
async function mount(input: { store?: ReturnType<typeof createStore<State>>; tall?: boolean } = {}) {
  const [data, setData] = input.store ?? createStore(fixture())
  const calls: { path: string; body: unknown }[] = []
  const navigated: unknown[] = []
  let slot: ((ctx: unknown, props: { session_id: string }) => JSX.Element) | undefined
  const color = RGBA.fromInts(200, 200, 200)
  const api = {
    kv: undefined as unknown,
    theme: { current: new Proxy({}, { get: () => color }) },
    tuiConfig: createTuiResolvedConfig(),
    ui: { toast() {} },
    route: { navigate: (name: string, params: unknown) => navigated.push({ name, params }) },
    client: {
      permission: {
        reply: async (body: unknown) => (calls.push({ path: "permission.reply", body }), { data: true }),
      },
      question: {
        reject: async (body: unknown) => (calls.push({ path: "question.reject", body }), { data: true }),
      },
    },
    slots: {
      register(input: { slots: { sidebar_content: typeof slot } }) {
        slot = input.slots.sidebar_content
      },
    },
    state: {
      config: { subagent: { fun_names: false, mascots: true } },
      part: (messageID: string) => data.parts[messageID] ?? [],
      session: {
        messages: (sessionID: string) => data.messages[sessionID] ?? [],
        status: (sessionID: string) => data.status[sessionID],
        // Every child session exists, created in launch order.
        get: (sessionID: string) => ({ time: { created: 0, updated: NOW }, ...data.sessions[sessionID] }),
        permission: (sessionID: string) => data.permission[sessionID] ?? [],
        question: (sessionID: string) => data.question[sessionID] ?? [],
      },
    },
  }
  await plugin.tui(api as unknown as TuiPluginApi, undefined, {} as never)

  let ready = () => false
  function Host() {
    const kv = useKV()
    api.kv = kv
    ready = () => kv.ready
    return <box width={42}>{slot!({}, { session_id: ROOT })}</box>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <KVProvider>
          <Host />
        </KVProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: input.tall ? 100 : 45 },
  )
  const frame = () => app.captureCharFrame()
  const wait = async (fn: () => boolean, timeout = 3000) => {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeout) throw new Error(`timed out; screen:\n${frame()}`)
      await app.renderOnce()
      await Bun.sleep(10)
    }
  }
  await wait(() => ready() && frame().includes("Subagents"))
  /** Clicks the first cell of the first line that has this text. */
  const click = async (text: string) => {
    const lines = frame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    if (y < 0) throw new Error(`no "${text}" on screen:\n${frame()}`)
    const x = lines[y]!.indexOf(text)
    await app.mockMouse.click(x, y)
    await Bun.sleep(30)
    await app.renderOnce()
  }
  return {
    app,
    frame,
    wait,
    click,
    calls,
    navigated,
    data,
    setData,
    kv: () => api.kv as ReturnType<typeof useKV>,
    async settle() {
      await Bun.sleep(30)
      await app.renderOnce()
    },
    close: () => app.renderer.destroy(),
  }
}

const lineOf = (screen: string, text: string) => screen.split("\n").findIndex((line) => line.includes(text))
const columnOf = (screen: string, text: string) => screen.split("\n")[lineOf(screen, text)]!.indexOf(text)

test("the fixture: header, three nested sub-sections, the order inside each", async () => {
  const ui = await mount({ tall: true })
  try {
    const screen = ui.frame()
    expect(screen).toContain("Subagents (7 · 2 need you)")
    for (const text of ["Working (3)", "Waiting for action (2)", "Completed (2)"]) expect(screen).toContain(text)
    // Nested: every sub-section header sits further in than the Subagents header.
    const top = columnOf(screen, "Subagents")
    for (const text of ["Working (3)", "Waiting for action (2)", "Completed (2)"])
      expect(columnOf(screen, text)).toBeGreaterThan(top)
    // Working, then Waiting for action, then Completed.
    const at = (text: string) => lineOf(screen, text)
    expect(at("Working (3)")).toBeLessThan(at("Waiting for action (2)"))
    expect(at("Waiting for action (2)")).toBeLessThan(at("Completed (2)"))
    // Working: the longest-running first, then the other running one, then the queued one.
    expect(at("write tests")).toBeLessThan(at("update docs"))
    expect(at("update docs")).toBeLessThan(at("lint everything"))
    expect(at("lint everything")).toBeLessThan(at("Waiting for action"))
    // Waiting: both asks, with approve and deny.
    expect(screen).toContain("approve: bash npm test")
    expect(screen).toContain("asks: Which name?")
    expect(screen).toContain("[approve]")
    // Completed: failed first, with its reason, then done.
    expect(at("deploy preview")).toBeLessThan(at("write the summary"))
    expect(at("Completed (2)")).toBeLessThan(at("deploy preview"))
    expect(screen).toContain("exit code 1: build failed")
    // Rows sit further in than their sub-section header.
    expect(columnOf(screen, "write tests")).toBeGreaterThan(columnOf(screen, "Working (3)"))
  } finally {
    ui.close()
  }
})

test("collapse is kept per session in kv.json, across a restart", async () => {
  const store = createStore(fixture())
  const first = await mount({ store })
  try {
    await first.click("Completed (2)")
    await first.wait(() => first.frame().includes("✕ 1 failed · ✓ 1 done"))
    expect(first.frame()).not.toContain("deploy preview")
    await first.click("Working (3)")
    await first.wait(() => first.frame().includes("◐ 2 running · ◌ 1 queued"))
    expect(first.kv().get(groupsKey(ROOT))).toEqual({ completed: false, working: false })
    await Bun.sleep(100)
  } finally {
    first.close()
  }
  const saved = await Bun.file(path.join(state, "kv.json")).json()
  expect(saved[groupsKey(ROOT)]).toEqual({ completed: false, working: false })

  // Restart: a new TUI reads kv.json.
  const second = await mount({ store })
  try {
    await second.wait(() => second.frame().includes("✕ 1 failed · ✓ 1 done"))
    expect(second.frame()).not.toContain("write tests")
    expect(second.frame()).not.toContain("deploy preview")
    expect(second.frame()).toContain("approve: bash npm test")
  } finally {
    second.close()
  }
})

test("a new ask opens a collapsed Waiting for action again", async () => {
  const ui = await mount()
  try {
    await ui.click("Waiting for action (2)")
    await ui.wait(() => !ui.frame().includes("approve: bash npm test"))
    expect(ui.frame()).toContain("! 2 waiting")
    // A subagent that was working asks for approval.
    ui.setData(
      produce((draft) => {
        draft.permission.run_new = [
          { id: "per_2", sessionID: "run_new", permission: "edit", patterns: ["README.md"], metadata: {}, always: [] },
        ]
      }),
    )
    await ui.wait(() => ui.frame().includes("approve: edit README.md"))
    expect(ui.frame()).toContain("Waiting for action (3)")
    expect(ui.frame()).toContain("Working (2)")
    expect(ui.frame()).toContain("Subagents (7 · 3 need you)")
    await ui.wait(() => ui.kv().get(groupsKey(ROOT)).waiting === undefined)
  } finally {
    ui.close()
  }
})

test("subagents move between sub-sections live", async () => {
  const ui = await mount({ tall: true })
  try {
    // queued → working
    ui.setData(
      produce((draft) => {
        draft.sessions.queued1 = { metadata: {} }
        draft.status.queued1 = { type: "busy" }
      }),
    )
    await ui.settle()
    await ui.wait(() => ui.frame().includes("Working (3)") && !ui.frame().includes("◌ queued"))
    // working → completed
    ui.setData(
      produce((draft) => {
        const part = draft.parts.msg_root!.find((each) => (each.state.metadata as any).sessionId === "run_new")!
        part.state.status = "completed"
        part.state.time = { start: NOW - 10_000, end: NOW }
      }),
    )
    await ui.wait(() => ui.frame().includes("Working (2)") && ui.frame().includes("Completed (3)"))
    const screen = ui.frame()
    expect(lineOf(screen, "update docs")).toBeGreaterThan(lineOf(screen, "Completed (3)"))
  } finally {
    ui.close()
  }
})

test("approve and deny from a Waiting row", async () => {
  const ui = await mount()
  try {
    await ui.click("[approve]")
    await ui.wait(() => ui.calls.length === 1)
    expect(ui.calls[0]).toEqual({ path: "permission.reply", body: { requestID: "per_1", reply: "once" } })
    // The approve click doesn't also open the subagent.
    expect(ui.navigated).toEqual([])
    // The question's deny is the second [deny] on screen.
    const lines = ui.frame().split("\n")
    const y = lines.findIndex((line, i) => line.includes("[deny]") && i > lineOf(ui.frame(), "asks: Which name?"))
    await ui.app.mockMouse.click(lines[y]!.indexOf("[deny]"), y)
    await ui.wait(() => ui.calls.length === 2)
    expect(ui.calls[1]).toEqual({ path: "question.reject", body: { requestID: "que_1" } })
    // A click on the row opens it.
    await ui.click("write tests")
    expect(ui.navigated).toEqual([{ name: "session", params: { sessionID: "run_old" } }])
  } finally {
    ui.close()
  }
})

test("empty sub-sections show (0), collapsed, in the same place", async () => {
  const store = createStore(fixture())
  store[1](
    produce((draft) => {
      draft.parts.msg_root = draft.parts.msg_root!.filter((part) =>
        ["done1", "failed1"].includes((part.state.metadata as any).sessionId),
      )
    }),
  )
  const ui = await mount({ store })
  try {
    const screen = ui.frame()
    expect(screen).toContain("Subagents (2)")
    expect(screen).toContain("▶ Working (0)")
    expect(screen).toContain("▶ Waiting for action (0)")
    expect(screen).toContain("▼ Completed (2)")
    expect(lineOf(screen, "Working (0)")).toBeLessThan(lineOf(screen, "Waiting for action (0)"))
    expect(lineOf(screen, "Waiting for action (0)")).toBeLessThan(lineOf(screen, "Completed (2)"))
    // Clicking an empty one does nothing.
    await ui.click("Working (0)")
    expect(ui.frame()).toContain("▶ Working (0)")
  } finally {
    ui.close()
  }
})

test("nested subagents are indented under their parent, in the sub-section of their own state", async () => {
  const store = createStore(fixture())
  store[1](
    produce((draft) => {
      draft.messages.run_old = [{ id: "msg_child" }]
      draft.parts.msg_child = [task("grand1", "check one file", { time: { start: NOW - 5000 } })]
      draft.status.grand1 = { type: "busy" }
      draft.messages.run_new = [{ id: "msg_child2" }]
      draft.parts.msg_child2 = [task("grand2", "ask about it")]
      draft.permission.grand2 = [
        { id: "per_3", sessionID: "grand2", permission: "bash", patterns: ["ls"], metadata: {}, always: [] },
      ]
    }),
  )
  const ui = await mount({ store, tall: true })
  try {
    const screen = ui.frame()
    expect(screen).toContain("Subagents (9 · 3 need you)")
    expect(screen).toContain("Working (4)")
    // Right under its parent, one level further in.
    expect(lineOf(screen, "check one file")).toBeGreaterThan(lineOf(screen, "write tests"))
    expect(lineOf(screen, "check one file")).toBeLessThan(lineOf(screen, "update docs"))
    expect(columnOf(screen, "check one file")).toBeGreaterThan(columnOf(screen, "write tests"))
    // Its parent works, so the waiting grandchild is under Waiting for action.
    expect(lineOf(screen, "ask about it")).toBeGreaterThan(lineOf(screen, "Waiting for action (3)"))
    expect(lineOf(screen, "ask about it")).toBeLessThan(lineOf(screen, "Completed"))
  } finally {
    ui.close()
  }
})

test("NO_COLOR: the states and headers read as text", async () => {
  process.env.NO_COLOR = "1"
  const ui = await mount({ tall: true })
  try {
    const section = ui
      .frame()
      .split("\n")
      .map((line) => line.trimEnd())
    const start = section.findIndex((line) => line.includes("Subagents"))
    // Elapsed times move with the clock; the snapshot is about the words and the layout.
    const text = section
      .slice(start)
      .filter((line) => line.trim())
      .join("\n")
      .replace(/\b(\d+m )?\d+s\b/g, "<elapsed>")
    expect(text).toMatchSnapshot()
    for (const word of ["◐ running", "◌ queued", "! approve: bash npm test", "✕ failed", "✓ done"])
      expect(text).toContain(word)
  } finally {
    ui.close()
  }
})
