/** @jsxImportSource @opentui/solid */
// XCOD-265: /sessions' Stop all, Clear list, Undo, Stop all & clear, Show archived / Unarchive and
// Delete archived, driven by keys in a headless terminal against a fake server that keeps state.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import type { SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

let lastFrame: (() => string) | undefined
async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout)
      throw new Error(`timed out waiting for condition${lastFrame ? `; screen: ${lastFrame()}` : ""}`)
    await Bun.sleep(10)
  }
}

function row(id: string, extra: Partial<SessionOverviewItem> = {}): SessionOverviewItem {
  return {
    id,
    kind: "session",
    title: `title ${id}`,
    directory: "/work/alpha",
    project: { id: "proj_test", name: "alpha", worktree: "/work/alpha" },
    cost: 0,
    created: 1,
    updated: Date.now(),
    state: "finished",
    permissions: 0,
    questions: 0,
    ...extra,
  }
}

/** The acceptance fixture: 3 running, 2 waiting, 1 Claude Code, 1 in another Lunos and 4 finished. */
const fixture = () => [
  row("r1", { state: "running" }),
  row("r2", { state: "running" }),
  row("r3", { state: "running", project: { id: "proj_b", name: "beta", worktree: "/work/beta" } }),
  row("w1", { state: "waiting", permissions: 1 }),
  row("w2", { state: "waiting", questions: 1 }),
  row("external:cc", { kind: "external", tool: "claude", state: "running", title: "Claude Code · api" }),
  row("e1", { state: "running", elsewhere: true }),
  row("f1"),
  row("f2"),
  row("f3", { state: "idle" }),
  row("f4", { state: "failed" }),
]

/** A fake server: the overview, and the four bulk endpoints acting on it. */
function fakeServer(input: { sessions: SessionOverviewItem[]; unreachable?: string[] }) {
  const sessions = input.sessions
  const calls: { path: string; body: any }[] = []
  const stoppable = (item: SessionOverviewItem) =>
    item.id.startsWith("external:") ? item.state === "running" : item.state === "running" || item.state === "waiting"
  const stop = (ids: string[]) => {
    const result = { stopped: [] as string[], failed: [] as { id: string; reason: string }[] }
    for (const id of ids) {
      const item = sessions.find((each) => each.id === id)
      if (!item || !stoppable(item)) result.failed.push({ id, reason: "it isn't running" })
      else if (input.unreachable?.includes(id)) result.failed.push({ id, reason: "another Lunos didn't respond" })
      else {
        Object.assign(item, { state: "idle", permissions: 0, questions: 0, elsewhere: undefined })
        result.stopped.push(id)
      }
    }
    return result
  }
  const archive = (ids: string[], stopped: string[] = []) => {
    const result = { archived: [] as string[], skipped: [] as { id: string; reason: string }[] }
    for (const id of ids) {
      const item = sessions.find((each) => each.id === id)
      if (!item || (stoppable(item) && !stopped.includes(id))) result.skipped.push({ id, reason: "running" })
      else {
        item.archived = Date.now()
        result.archived.push(id)
      }
    }
    return result
  }
  const handler = async (url: URL, request?: Request) => {
    if (url.pathname === "/experimental/session-overview") {
      const archived = url.searchParams.get("archived") === "true"
      return json({ groups: [], sessions: sessions.filter((item) => !!item.archived === archived) })
    }
    if (!url.pathname.startsWith("/experimental/session-bulk/")) return undefined
    const body = await request!.json()
    calls.push({ path: url.pathname.split("/").pop()!, body })
    const ids: string[] = body.sessionIDs
    if (url.pathname.endsWith("/stop")) return json(stop(ids))
    if (url.pathname.endsWith("/archive")) {
      if (!body.stop) return json(archive(ids))
      const running = ids.filter((id) => {
        const item = sessions.find((each) => each.id === id)
        return item && stoppable(item)
      })
      const stopped = stop(running)
      const failed = new Set(stopped.failed.map((item) => item.id))
      return json({
        ...archive(
          ids.filter((id) => !failed.has(id)),
          stopped.stopped,
        ),
        ...stopped,
      })
    }
    if (url.pathname.endsWith("/unarchive")) {
      for (const id of ids) delete sessions.find((each) => each.id === id)!.archived
      return json({ archived: ids, skipped: [] })
    }
    if (url.pathname.endsWith("/delete")) {
      const deleted = ids.filter((id) => sessions.find((each) => each.id === id)?.archived)
      for (const id of deleted)
        sessions.splice(
          sessions.findIndex((each) => each.id === id),
          1,
        )
      return json({ deleted, skipped: [] })
    }
  }
  return { sessions, calls, handler }
}

// Bound in the test only: they ship unbound and are reached from the Tab menu (dialog-select test).
const keys = {
  "dialog.sessions.stop_all": "alt+1",
  "dialog.sessions.clear": "alt+2",
  "dialog.sessions.stop_all_clear": "alt+3",
  "dialog.sessions.undo": "alt+4",
  "dialog.sessions.archived": "alt+5",
  "dialog.sessions.unarchive": "alt+6",
  "dialog.sessions.delete_archived": "alt+7",
} as const

async function mountSessions(server: ReturnType<typeof fakeServer>) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const base = createFetch(undefined, events)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const handled = await server.handler(new URL(request.url), request)
    return handled ?? base.fetch(request)
  }) as typeof globalThis.fetch

  const [
    { DialogProvider, useDialog },
    { DialogSessions },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, useToast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { SDKProvider },
    { ProjectProvider, useProject },
    { RouteProvider },
    { ArgsProvider },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/component/dialog-sessions"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
    import("../../src/context/sdk"),
    import("../../src/context/project"),
    import("../../src/context/route"),
    import("../../src/context/args"),
  ])

  let toast!: ReturnType<typeof useToast>
  function Open() {
    const dialog = useDialog()
    const project = useProject()
    toast = useToast()
    // The app's bootstrap loads the project; "this project only" compares against it.
    onMount(() => void project.sync().then(() => dialog.replace(() => <DialogSessions />)))
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: keys, leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                  <ProjectProvider>
                    <RouteProvider>
                      <ThemeProvider mode="dark">
                        <ToastProvider>
                          <DialogProvider>
                            <Open />
                          </DialogProvider>
                        </ToastProvider>
                      </ThemeProvider>
                    </RouteProvider>
                  </ProjectProvider>
                </SDKProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 120, height: 45 })
  // Wrapped lines joined, and the dialog's "esc" hint taken out, so sentences read whole.
  const frame = () => app.captureCharFrame().replace(/ esc /g, " ").replace(/\s+/g, " ")
  lastFrame = frame
  await wait(() => frame().includes("Sessions — all projects") && frame().includes("title "))
  return {
    app,
    frame,
    toast: () => toast.currentToast?.message,
    /** One of the test-bound alt+<n> keys. */
    async press(command: keyof typeof keys) {
      app.mockInput.pressKey(keys[command].slice(-1), { meta: true })
      await Bun.sleep(80)
    },
    async enter() {
      app.mockInput.pressEnter()
      await Bun.sleep(80)
    },
    cleanup() {
      app.renderer.destroy()
      void tmp[Symbol.asyncDispose]()
    },
  }
}

test("Stop all (mixed kinds) asks once with the right counts and stops all 7", async () => {
  const server = fakeServer({ sessions: fixture() })
  const ui = await mountSessions(server)
  try {
    await ui.press("dialog.sessions.stop_all")
    await wait(() => ui.frame().includes("Stop 7 sessions?"))
    expect(ui.frame()).toContain("4 running, 2 waiting for an answer, 1 Claude Code.")
    expect(ui.frame()).toContain("1 of them runs in another Lunos window.")
    // Two projects in view: "this project only" is offered too.
    expect(ui.frame()).toContain("Stop all in this project only")
    await ui.enter()
    await wait(() => server.calls.length === 1)
    expect(server.calls[0]).toEqual({
      path: "stop",
      body: { sessionIDs: ["r1", "r2", "r3", "w1", "w2", "external:cc", "e1"] },
    })
    await wait(() => ui.toast() === "Stopped 7")
  } finally {
    ui.cleanup()
  }
})

test("Stop all marks the rows another Lunos didn't stop", async () => {
  const server = fakeServer({ sessions: fixture(), unreachable: ["e1"] })
  const ui = await mountSessions(server)
  try {
    await ui.press("dialog.sessions.stop_all")
    await wait(() => ui.frame().includes("Stop 7 sessions?"))
    await ui.enter()
    await wait(() => ui.toast() === "Stopped 6 · 1 couldn't be stopped (another Lunos didn't respond)")
    await wait(() => ui.frame().includes("couldn't stop: another Lunos didn't respond"))
  } finally {
    ui.cleanup()
  }
})

test("Stop all with the filter on waiting stops only the waiting sessions; Esc cancels", async () => {
  const server = fakeServer({ sessions: fixture() })
  const ui = await mountSessions(server)
  try {
    ui.app.mockInput.pressKey("f", { ctrl: true }) // state filter: waiting
    await wait(() => ui.frame().includes("state: waiting"))
    await ui.press("dialog.sessions.stop_all")
    await wait(() => ui.frame().includes("Stop 2 sessions? 2 waiting for an answer."))
    ui.app.mockInput.pressEscape()
    await Bun.sleep(100)
    expect(server.calls).toEqual([])
    await ui.press("dialog.sessions.stop_all")
    await wait(() => ui.frame().includes("Stop 2 sessions?"))
    await ui.enter()
    await wait(() => server.calls.length === 1)
    expect(server.calls[0]!.body.sessionIDs).toEqual(["w1", "w2"])
    // The filter outlives the view (as in the app): cycle it back to "all" for the next test.
    await wait(() => ui.frame().includes("state: waiting"))
    for (let i = 0; i < 6; i++) {
      ui.app.mockInput.pressKey("f", { ctrl: true })
      await Bun.sleep(30)
    }
    await wait(() => !ui.frame().includes("state:"))
  } finally {
    ui.cleanup()
  }
})

test("Clear archives only finished, idle and failed rows, says what stays, and Undo brings them back", async () => {
  const server = fakeServer({ sessions: fixture() })
  const ui = await mountSessions(server)
  try {
    await ui.press("dialog.sessions.clear")
    await wait(() => ui.frame().includes("Clear 4 sessions from the list?"))
    expect(ui.frame()).toContain("7 running sessions stay; stop them first, or use Stop all & clear.")
    await ui.enter()
    await wait(() => server.calls.length === 1)
    expect(server.calls[0]).toEqual({ path: "archive", body: { sessionIDs: ["f1", "f2", "f3", "f4"] } })
    await wait(() => !ui.frame().includes("title f1"))
    expect(ui.frame()).toContain("title r1")
    expect(ui.toast()).toContain("Cleared 4 from the list")
    // Undo is offered right after, and restores the whole batch.
    await wait(() => ui.frame().includes("undo"))
    await ui.press("dialog.sessions.undo")
    await wait(() => server.calls.length === 2)
    expect(server.calls[1]).toEqual({ path: "unarchive", body: { sessionIDs: ["f1", "f2", "f3", "f4"] } })
    await wait(() => ui.frame().includes("title f1"))
  } finally {
    ui.cleanup()
  }
})

test("Stop all & clear: one confirmation listing both steps, then everything is stopped and archived", async () => {
  const server = fakeServer({ sessions: fixture() })
  const ui = await mountSessions(server)
  try {
    await ui.press("dialog.sessions.stop_all_clear")
    await wait(() => ui.frame().includes("Stop 7 sessions and clear 11 from the list?"))
    expect(ui.frame()).toContain("1. Stop 4 running, 2 waiting for an answer, 1 Claude Code")
    expect(ui.frame()).toContain("2. Archive all 11")
    await ui.enter()
    await wait(() => server.calls.length === 1)
    expect(server.calls[0]!.path).toBe("archive")
    expect(server.calls[0]!.body.stop).toBe(true)
    expect(server.calls[0]!.body.sessionIDs).toHaveLength(11)
    await wait(() => ui.frame().includes("No sessions yet"))
    expect(ui.toast()).toContain("Stopped 7 · Cleared 11 from the list")
  } finally {
    ui.cleanup()
  }
})

// XCOD-269: Delete archived says when prompts queued for those sessions, never sent, go with them
// (with none, it says nothing: the test above).
test("Delete archived says how many queued prompts it also deletes", async () => {
  const server = fakeServer({
    sessions: [
      row("a1", { archived: Date.now() - 1000, queued: 2, ownerClosed: true }),
      row("a2", { archived: Date.now() - 1000 }),
      row("live", { state: "finished" }),
    ],
  })
  const ui = await mountSessions(server)
  try {
    await ui.press("dialog.sessions.archived")
    await wait(() => ui.frame().includes("title a1"))
    ui.app.mockInput.pressArrow("down")
    await Bun.sleep(50)
    ui.app.mockInput.pressArrow("up")
    await Bun.sleep(50)
    await ui.press("dialog.sessions.delete_archived")
    await wait(() => ui.frame().includes("Delete 2 archived sessions?"))
    expect(ui.frame()).toContain("Also deletes 2 queued prompts that were never sent.")
    // Leave nothing deleted, and the list (not the archived view) for the next test.
    ui.app.mockInput.pressEscape()
    await wait(() => ui.frame().includes("Archived sessions"))
    await ui.press("dialog.sessions.archived")
    await wait(() => ui.frame().includes("title live"))
    expect(server.calls).toHaveLength(0)
  } finally {
    ui.cleanup()
  }
})

test("Show archived lists them; Unarchive restores one; Delete archived needs the typed count", async () => {
  const server = fakeServer({
    sessions: [
      row("a1", { archived: Date.now() - 1000 }),
      row("a2", { archived: Date.now() - 1000, project: { id: "proj_b", name: "beta", worktree: "/work/beta" } }),
      row("a3", { archived: Date.now() - 1000 }),
      row("live", { state: "finished" }),
    ],
  })
  const ui = await mountSessions(server)
  try {
    expect(ui.frame()).not.toContain("title a1")
    await ui.press("dialog.sessions.archived")
    await wait(() => ui.frame().includes("Archived sessions"))
    await wait(() => ui.frame().includes("title a1"))
    expect(ui.frame()).not.toContain("title live")
    expect(ui.frame()).toContain("delete archived")

    // The cursor is on the first archived row (newest first: a1).
    ui.app.mockInput.pressArrow("down")
    await Bun.sleep(50)
    ui.app.mockInput.pressArrow("up")
    await Bun.sleep(50)
    await ui.press("dialog.sessions.unarchive")
    await wait(() => server.calls.length === 1)
    expect(server.calls[0]!.path).toBe("unarchive")
    expect(server.calls[0]!.body.sessionIDs).toHaveLength(1)
    const restored = server.calls[0]!.body.sessionIDs[0]
    await wait(() => !ui.frame().includes(`title ${restored}`))

    // A wrong count deletes nothing.
    await ui.press("dialog.sessions.delete_archived")
    await wait(() => ui.frame().includes("Delete 2 archived sessions?"))
    expect(ui.frame()).toContain("Their history is deleted for good; this can't be undone. Projects: beta, alpha")
    expect(ui.frame()).not.toContain("queued prompt")
    await ui.app.mockInput.typeText("3")
    await ui.enter()
    await wait(() => ui.toast() === "Nothing was deleted: the count didn't match.")
    expect(server.calls).toHaveLength(1)

    await wait(() => ui.frame().includes("Archived sessions"))
    await ui.press("dialog.sessions.delete_archived")
    await wait(() => ui.frame().includes("Delete 2 archived sessions"))
    await ui.app.mockInput.typeText("2")
    await ui.enter()
    await wait(() => server.calls.length === 2)
    expect(server.calls[1]!.path).toBe("delete")
    expect(server.calls[1]!.body.sessionIDs).toHaveLength(2)
    expect(server.sessions.map((item) => item.id).toSorted()).toEqual([restored, "live"].toSorted())
    await wait(() => ui.frame().includes("No archived sessions"))
  } finally {
    ui.cleanup()
  }
})
