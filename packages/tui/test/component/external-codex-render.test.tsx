// XCOD-292: a Codex session shows its file changes as diffs, its plan updates as a checklist and its
// subagents' progress, in Lunos's own views and theme, and the status line adds the context in use
// when the tool reports it. The whole app runs headless at 120x45 on the session the server stored
// for the recorded Codex 0.160.1 turn (fixture/external/codex-0.160.1-turn.json, kept equal to what
// the server stores by packages/opencode/test/server/httpapi-external-session.test.ts).
import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, json } from "../fixture/tui-sdk"
import { externalBadge, externalContext } from "../../src/util/external"
import { formatExternalAgent, toolDisplay } from "../../src/routes/session"

const TURN = JSON.parse(
  readFileSync(path.join(import.meta.dir, "..", "fixture", "external", "codex-0.160.1-turn.json"), "utf8"),
)

// A connected Lunos provider, so the app doesn't open its "add a provider" dialog over the session.
const PROVIDER = {
  id: "fake",
  name: "Fake",
  source: "config",
  env: [],
  options: {},
  models: {
    "fake-1": {
      id: "fake-1",
      providerID: "fake",
      name: "Fake 1",
      api: { id: "fake-1", url: "", npm: "" },
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1000, output: 1000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

/** The stored session, with its marker's `context` replaced (undefined: the tool reported none). */
function stored(context?: Record<string, number>) {
  const { context: _, ...external } = TURN.session.metadata.external
  return {
    ...TURN.session,
    metadata: { ...TURN.session.metadata, external: context ? { ...external, context } : external },
  }
}

async function open(session: ReturnType<typeof stored>) {
  const setup = await createTestRenderer({ width: 120, height: 45, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const id = session.id as string
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/config/providers") return json({ providers: [PROVIDER], default: { fake: "fake-1" } })
    if (url.pathname === "/provider") return json({ all: [PROVIDER], default: { fake: "fake-1" }, connected: ["fake"] })
    if (url.pathname === `/session/${id}`) return json(session)
    if (url.pathname === `/session/${id}/message`) return json(TURN.messages)
    if (/^\/session\/[^/]+\/(todo|diff|children)$/.test(url.pathname)) return json([])
    if (["/permission", "/question"].includes(url.pathname)) return json([])
    if (/^\/project\/[^/]+\/directories$/.test(url.pathname)) return json([])
    if (url.pathname === "/experimental/external/tools")
      return json([{ tool: "codex", label: "Codex CLI", installed: true, loggedIn: true }])
  }, events)
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => (started = resolve))
  const { run } = await import("../../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory: session.directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args: { sessionID: id },
      pluginHost: {
        async start(input) {
          api = input.api
          // As the real host does: slots (the session's prompt is one) render once set up.
          input.runtime.setupSlots(input.api)
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  await ready
  const frame = () => setup.captureCharFrame()
  const until = async (fn: (screen: string) => boolean) => {
    for (let i = 0; i < 200; i++) {
      await setup.renderOnce()
      if (fn(frame())) return frame()
      await Bun.sleep(10)
    }
    throw new Error(`timed out; screen:\n${frame()}`)
  }
  return {
    until,
    async close() {
      api?.keymap.dispatchCommand("app.exit")
      await Promise.race([task.catch(() => undefined), Bun.sleep(2000)])
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      mock.restore()
    },
  }
}

test("Codex's tools map to Lunos's views: file changes to the patch view, the plan to the checklist", () => {
  expect(toolDisplay("codex:FileChange")).toBe("apply_patch")
  expect(toolDisplay("codex:Plan")).toBe("todowrite")
  expect(toolDisplay("codex:Agent")).toBe("external_agent")
  expect(toolDisplay("codex:Bash")).toBe("generic")
})

test("a subagent call says what Codex reported and nothing it didn't", () => {
  const [call, activity] = TURN.messages[1].parts.filter((part: any) => part.tool === "codex:Agent")
  expect(formatExternalAgent(call.state.input, call.state.metadata)).toEqual([
    "Spawned agent · 01a11700 · gpt-5.5-mini",
    "↳ Check note.txt says from codex",
    "↳ 01a11700: completed — note.txt says from codex",
  ])
  expect(formatExternalAgent(activity.state.input, activity.state.metadata)).toEqual(["checker started"])
  // A null prompt or model and no states: only the call; a call a newer Codex adds keeps its name.
  expect(formatExternalAgent({ kind: "call", tool: "wait", receivers: ["t1"] }, {})).toEqual(["Waited for agents · t1"])
  expect(formatExternalAgent({ kind: "call", tool: "forkAgent" }, {})).toEqual(["forkAgent"])
})

test("context in the status line only when the tool reports it; the share only with the window", () => {
  expect(externalContext({ used: 15273, window: 258400 })).toBe("15.3K (6%)")
  expect(externalContext({ used: 48986 })).toBe("49.0K")
  expect(externalContext(undefined)).toBeUndefined()
  expect(externalContext({ window: 258400 })).toBeUndefined()
  expect(externalBadge("codex", "gpt-5.5", undefined, externalContext({ used: 15273, window: 258400 }))).toBe(
    "Lunos · Codex · gpt-5.5 · 15.3K (6%)",
  )
  expect(externalBadge("codex", "gpt-5.5")).toBe("Lunos · Codex · gpt-5.5")
})

test("headless 120x45: the recorded Codex turn's diff, its plan as a checklist, the subagent's progress, context in the status line", async () => {
  const ui = await open(stored(TURN.session.metadata.external.context))
  try {
    const screen = await ui.until((text) => text.includes("# Created") && text.includes("Lunos · Codex"))
    // The accepted file change as a diff of the new file; the declined one as refused, not failed.
    expect(screen).toContain("# Created /work/note.txt")
    expect(screen).toMatch(/1 \+ from codex/)
    expect(screen).toContain("% Patch declined")
    expect(screen).not.toContain("Patch failed")
    // The plan as a checklist at each update, with Codex's explanation: in progress, then all done.
    expect(screen).toContain("Write the note, then check it.")
    expect(screen).toContain("[•] Create note.txt")
    expect(screen).toContain("[ ] Check its contents")
    expect(screen).toContain("# Plan")
    expect(screen).toContain("[✓] Check its contents")
    // The subagent: the call with its prompt and final state, then its activity.
    expect(screen).toContain("✓ Spawned agent · 01a11700 · gpt-5.5-mini")
    expect(screen).toContain("↳ Check note.txt says from codex")
    expect(screen).toContain("↳ 01a11700: completed — note.txt says from codex")
    expect(screen).toContain("✓ checker started")
    // The status line: Lunos · Codex · model · context in use, the hints beside it still whole.
    expect(screen).toContain("Lunos · Codex · gpt-5.5 · 15.3K (6%)")
    expect(screen).toContain("exit closes · /exit:lunos quits Lunos")
    expect(screen).toContain("ctrl+p commands")
  } finally {
    await ui.close()
  }
}, 30_000)

test("headless 120x45: no context in the status line when the tool reported none", async () => {
  const ui = await open(stored())
  try {
    const screen = await ui.until((text) => text.includes("Lunos · Codex"))
    expect(screen).toMatch(/Lunos · Codex · gpt-5\.5 {2}exit closes/)
    expect(screen).not.toContain("15.3K")
  } finally {
    await ui.close()
  }
}, 30_000)
