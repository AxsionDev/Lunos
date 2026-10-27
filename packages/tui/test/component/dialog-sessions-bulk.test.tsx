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
function fakeServer(input: {
  sessions: SessionOverviewItem[]
  unreachable?: string[]
  /** XCOD-325: listed, but deleted by the time they are renamed. */
  deleted?: string[]
  /** XCOD-284: what experimental.sessionBulk.preview says per session, and whether sync is on. */
  preview?: Record<string, { messages?: number; children?: number; queued?: number; shared?: boolean; tool?: string }>
  sync?: boolean
}) {
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
  // XCOD-325: the three ways a row is renamed.
  const rename = async (id: string, request: Request) => {
    const body = await request.json()
    calls.push({ path: `rename ${id}`, body })
    const item = sessions.find((each) => each.id === id)
    if (!item || input.deleted?.includes(id))
      return json({ name: "NotFoundError", data: { message: "Session not found" } }, { status: 404 })
    if (input.unreachable?.includes(id))
      return json({ message: "the Lunos running it isn't responding" }, { status: 400 })
    item.title = body.title || `automatic ${id}`
    return json(id.startsWith("external:") ? true : item)
  }
  const handler = async (url: URL, request?: Request) => {
    const external = /^\/experimental\/external\/([^/]+)\/rename$/.exec(url.pathname)
    if (external) return rename(`external:${external[1]}`, request!)
    const peer = /^\/experimental\/peer\/([^/]+)\/rename$/.exec(url.pathname)
    if (peer) return rename(peer[1]!, request!)
    const own = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (own && request?.method === "PATCH") return rename(own[1]!, request)
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
    if (url.pathname.endsWith("/preview"))
      return json({
        items: ids.map((id) => ({ id, messages: 0, children: 0, queued: 0, shared: false, ...input.preview?.[id] })),
        sync: !!input.sync,
      })
    // XCOD-284: Delete in /sessions reaches listed sessions; running ones are stopped first or skipped.
    if (url.pathname.endsWith("/delete") && body.archivedOnly === false) {
      const result = { deleted: [] as string[], skipped: [] as { id: string; reason: string }[] }
      const running = ids.filter((id) => {
        const item = sessions.find((each) => each.id === id)
        return item && stoppable(item)
      })
      const stopped = body.stop ? stop(running) : { stopped: [], failed: [] }
      for (const id of ids) {
        const failure = stopped.failed.find((item) => item.id === id)
        if (failure) result.skipped.push({ id, reason: failure.reason })
        else if (running.includes(id) && !body.stop)
          result.skipped.push({ id, reason: "it's running or waiting; stop it first" })
        else {
          sessions.splice(
            sessions.findIndex((each) => each.id === id),
            1,
          )
          result.deleted.push(id)
        }
      }
      return json({ ...result, ...(body.stop ? { stopped: stopped.stopped } : {}) })
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
  "dialog.sessions.delete_all": "alt+8",
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
  // (Or Show archived, which the view keeps from a previous test: mountList leaves it.)
  await wait(
    () =>
      (frame().includes("Sessions — all projects") && frame().includes("title ")) ||
      frame().includes("Archived sessions — all projects"),
  )
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
    async key(name: string, modifiers?: { ctrl?: boolean }) {
      app.mockInput.pressKey(name, modifiers)
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

/** XCOD-284: mounted on the list (not Show archived, which a test above leaves open: the view keeps it). */
async function mountList(server: ReturnType<typeof fakeServer>) {
  const ui = await mountSessions(server)
  if (ui.frame().includes("Archived sessions")) {
    await ui.press("dialog.sessions.archived")
    await wait(() => ui.frame().includes("Sessions — all projects") && ui.frame().includes("title "))
  }
  return ui
}
// XCOD-284: Delete in /sessions. Rows here are newest first under the Ungrouped heading: d1, d2, d3, d4.
// The marked rows outlive a view (as in the app), so the test that marks rows uses ids of its own.
const finished = (extra: Partial<SessionOverviewItem>[] = [], prefix = "d") =>
  [1, 2, 3, 4].map((n, index) => row(`${prefix}${n}`, { updated: Date.now() - index * 60_000, ...extra[index] }))

test("XCOD-284: ctrl+d on one session asks once, Cancel first (Enter cancels), then deletes just it", async () => {
  const server = fakeServer({ sessions: finished(), preview: { d1: { messages: 42 } } })
  const ui = await mountList(server)
  try {
    // The cursor starts on the Ungrouped heading.
    ui.app.mockInput.pressArrow("down")
    await ui.key("d", { ctrl: true })
    await wait(() => ui.frame().includes(`Delete "title d1" (project alpha, 42 messages)? This can't be undone.`))
    expect(ui.frame()).toContain("Removed: its history and messages.")
    expect(ui.frame()).toContain("Files the agent changed in your projects are never touched.")
    expect(ui.frame()).toContain("Want it back later? Use Clear list (archive) instead.")
    // Cancel is the default: Enter deletes nothing.
    await ui.enter()
    await Bun.sleep(100)
    expect(server.calls.map((call) => call.path)).toEqual(["preview"])
    await wait(() => ui.frame().includes("Sessions — all projects"))

    await ui.key("d", { ctrl: true })
    await wait(() => ui.frame().includes(`Delete "title d1"`))
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => server.calls.some((call) => call.path === "delete"))
    expect(server.calls.find((call) => call.path === "delete")!.body).toEqual({
      sessionIDs: ["d1"],
      archivedOnly: false,
      stop: false,
      keepCloud: false,
      origin: "single",
    })
    await wait(() => ui.toast() === "Deleted 1 session")
    await wait(() => !ui.frame().includes("title d1"))
    expect(ui.frame()).toContain("title d2")
  } finally {
    ui.cleanup()
  }
})

test("XCOD-284: space marks rows (n selected), ctrl+d deletes exactly those after the typed count", async () => {
  const server = fakeServer({ sessions: finished([], "m") })
  const ui = await mountList(server)
  try {
    for (const step of ["down", "space", "down", "space", "down", "down", "space"]) {
      if (step === "space") ui.app.mockInput.pressKey(" ")
      else ui.app.mockInput.pressArrow("down")
      await Bun.sleep(40)
    }
    await wait(() => ui.frame().includes("3 selected"))
    expect(ui.frame()).toContain("[x] title m1")
    expect(ui.frame()).toContain("[x] title m2")
    expect(ui.frame()).not.toContain("[x] title m3")
    expect(ui.frame()).toContain("[x] title m4")
    // Unmark and mark again: a toggle.
    ui.app.mockInput.pressKey(" ")
    await wait(() => ui.frame().includes("2 selected"))
    ui.app.mockInput.pressKey(" ")
    await wait(() => ui.frame().includes("3 selected"))

    await ui.key("d", { ctrl: true })
    await wait(() => ui.frame().includes("Delete 3 sessions? This can't be undone."))
    expect(ui.frame()).toContain("By project: alpha 3.")
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => ui.frame().includes("Type 3 to delete 3 sessions"))
    // A wrong count deletes nothing, and the marks stay.
    await ui.app.mockInput.typeText("4")
    await ui.enter()
    await wait(() => ui.toast() === "Nothing was deleted: the count didn't match.")
    expect(server.calls.some((call) => call.path === "delete")).toBe(false)
    await wait(() => ui.frame().includes("3 selected"))

    await ui.key("d", { ctrl: true })
    await wait(() => ui.frame().includes("Delete 3 sessions?"))
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => ui.frame().includes("Type 3 to delete 3 sessions"))
    await ui.app.mockInput.typeText("3")
    await ui.enter()
    await wait(() => server.calls.some((call) => call.path === "delete"))
    const call = server.calls.find((each) => each.path === "delete")!
    expect(call.body.sessionIDs.toSorted()).toEqual(["m1", "m2", "m4"])
    expect(call.body.origin).toBe("bulk")
    await wait(() => ui.toast() === "Deleted 3 sessions")
    await wait(() => !ui.frame().includes("title m1"))
    expect(server.sessions.map((item) => item.id)).toEqual(["m3"])
    expect(ui.frame()).not.toContain("selected")
  } finally {
    ui.cleanup()
  }
})

test("XCOD-284: Delete all shown deletes only what the search shows; space still types while searching", async () => {
  const server = fakeServer({
    sessions: [
      ...finished(),
      row("b1", { title: "beta one", project: { id: "proj_b", name: "beta", worktree: "/work/beta" } }),
      row("b2", { title: "beta two", project: { id: "proj_b", name: "beta", worktree: "/work/beta" } }),
    ],
  })
  const ui = await mountList(server)
  try {
    // Typed key by key, as a person types (space included: it isn't "select" while searching). The
    // search box takes focus a moment after the view opens: the first key is sent until it lands.
    // (The search follows the header's view switch, "View: Groups | Projects · ctrl+y".)
    const searched = (text: string) => ui.frame().includes(`6 sessions View: Groups | Projects · ctrl+y ${text} `)
    for (let attempt = 0; attempt < 20 && !searched("b"); attempt++) {
      ui.app.mockInput.pressKey("b")
      await wait(() => searched("b"), 300).catch(() => undefined)
    }
    for (const ch of "eta t") {
      ui.app.mockInput.pressKey(ch)
      await Bun.sleep(40)
    }
    await wait(() => ui.frame().includes("beta two") && !ui.frame().includes("title d1"))
    expect(ui.frame()).toContain("Sessions — all projects · 6 sessions")
    expect(searched("beta t")).toBe(true)
    expect(ui.frame()).not.toContain("beta one")
    // Backspace to "beta": both beta rows, nothing else.
    ui.app.mockInput.pressBackspace()
    ui.app.mockInput.pressBackspace()
    await wait(() => ui.frame().includes("beta one") && ui.frame().includes("beta two"))
    await ui.press("dialog.sessions.delete_all")
    await wait(() => ui.frame().includes("Delete 2 sessions?"))
    expect(ui.frame()).toContain("By project: beta 2.")
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => ui.frame().includes("Type 2 to delete 2 sessions"))
    await ui.app.mockInput.typeText("2")
    await ui.enter()
    await wait(() => server.calls.some((call) => call.path === "delete"))
    expect(server.calls.find((call) => call.path === "delete")!.body.sessionIDs.toSorted()).toEqual(["b1", "b2"])
    expect(server.sessions.map((item) => item.id).toSorted()).toEqual(["d1", "d2", "d3", "d4"])
  } finally {
    ui.cleanup()
  }
})

test("XCOD-284: a running session offers Stop and delete, which stops it first", async () => {
  const server = fakeServer({
    sessions: [row("r1", { state: "running", updated: Date.now() }), ...finished().slice(0, 2)],
  })
  const ui = await mountList(server)
  try {
    ui.app.mockInput.pressArrow("down")
    await ui.key("d", { ctrl: true })
    await wait(() => ui.frame().includes(`Delete "title r1"`))
    expect(ui.frame()).toContain("It's running or waiting: Stop and delete stops it first.")
    expect(ui.frame()).toContain("Stop and delete")
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => server.calls.some((call) => call.path === "delete"))
    expect(server.calls.find((call) => call.path === "delete")!.body).toMatchObject({ sessionIDs: ["r1"], stop: true })
    await wait(() => ui.toast() === "Deleted 1 session")
  } finally {
    ui.cleanup()
  }
})

test("XCOD-284: several with some running also offer Skip running ones, and the count typed is what's deleted", async () => {
  const server = fakeServer({
    sessions: [row("r2", { state: "running", updated: Date.now() }), ...finished().slice(0, 2)],
  })
  const ui = await mountList(server)
  try {
    await ui.press("dialog.sessions.delete_all")
    await wait(() => ui.frame().includes("Delete 3 sessions?"))
    expect(ui.frame()).toContain("1 is running or waiting")
    expect(ui.frame()).toContain("Stop 1 and delete 3")
    expect(ui.frame()).toContain("Skip running ones (delete 2)")
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => ui.frame().includes("Type 2 to delete 2 sessions"))
    await ui.app.mockInput.typeText("2")
    await ui.enter()
    await wait(() => server.calls.some((call) => call.path === "delete"))
    const body = server.calls.find((call) => call.path === "delete")!.body
    expect(body.sessionIDs.toSorted()).toEqual(["d1", "d2"])
    expect(body.stop).toBe(false)
    expect(server.sessions.map((item) => item.id)).toEqual(["r2"])
  } finally {
    ui.cleanup()
  }
})

test("XCOD-284: the confirmation says the share link goes first, Claude Code keeps its copy, and the synced copy box toggles", async () => {
  const server = fakeServer({
    sessions: [
      row("s1", { updated: Date.now() }),
      row("external:cc", { kind: "external", tool: "claude", title: "Claude Code · api", updated: Date.now() - 1000 }),
    ],
    preview: { s1: { shared: true, messages: 3, children: 2, queued: 1 } },
    sync: true,
  })
  const ui = await mountList(server)
  try {
    ui.app.mockInput.pressArrow("down")
    await ui.key("d", { ctrl: true })
    await wait(() => ui.frame().includes(`Delete "title s1" (project alpha, 3 messages)?`))
    expect(ui.frame()).toContain("Removed: its history and messages, 2 subagent sessions, 1 queued prompt never sent.")
    expect(ui.frame()).toContain("Its share link is removed first.")
    expect(ui.frame()).toContain("[x] Also delete the synced copy on Lunos Cloud")
    // Untick it (Cancel, Delete, then the box), then Delete: the synced copy is kept.
    ui.app.mockInput.pressArrow("down")
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => ui.frame().includes("[ ] Also delete the synced copy on Lunos Cloud"))
    ui.app.mockInput.pressArrow("up")
    await ui.enter()
    await wait(() => server.calls.some((call) => call.path === "delete"))
    expect(server.calls.find((call) => call.path === "delete")!.body).toMatchObject({
      sessionIDs: ["s1"],
      keepCloud: true,
    })
    await wait(() => !ui.frame().includes("title s1"))

    // A Claude Code row: only the Lunos record goes; with the box left ticked the synced copy goes too.
    server.calls.length = 0
    ui.app.mockInput.pressArrow("down")
    await ui.key("d", { ctrl: true })
    await wait(() => ui.frame().includes(`Delete "Claude Code · api" (project alpha)?`))
    expect(ui.frame()).toContain("Claude Code keeps its own copy; only the Lunos record goes.")
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => server.calls.some((call) => call.path === "delete"))
    expect(server.calls.find((call) => call.path === "delete")!.body).toMatchObject({
      sessionIDs: ["external:cc"],
      keepCloud: false,
    })
  } finally {
    ui.cleanup()
  }
})

test("XCOD-284: a session that couldn't be deleted stays, marked with why, and the toast says so", async () => {
  const server = fakeServer({
    sessions: [row("e1", { state: "running", elsewhere: true, updated: Date.now() }), ...finished().slice(0, 1)],
    unreachable: ["e1"],
  })
  const ui = await mountList(server)
  try {
    await ui.press("dialog.sessions.delete_all")
    await wait(() => ui.frame().includes("Delete 2 sessions?"))
    expect(ui.frame()).toContain("(1 in another Lunos)")
    ui.app.mockInput.pressArrow("down")
    await ui.enter()
    await wait(() => ui.frame().includes("Type 2 to delete 2 sessions"))
    await ui.app.mockInput.typeText("2")
    await ui.enter()
    await wait(() => ui.toast() === "Deleted 1 · 1 couldn't be deleted (another Lunos didn't respond)")
    await wait(() => ui.frame().includes("couldn't delete: another Lunos didn't respond"))
    expect(ui.frame()).toContain("title e1")
    expect(ui.frame()).not.toContain("title d1")
  } finally {
    ui.cleanup()
  }
})

// XCOD-325: ctrl+r renames any row: this Lunos's, another Lunos's, a Claude Code one, an archived one.
// Mounted afresh, the cursor is on the Ungrouped heading: `row` counts from 1 under it (newest first).
async function renameRow(server: ReturnType<typeof fakeServer>, row: number, title: string, name: string) {
  const ui = await mountList(server)
  for (let i = 0; i < row; i++) ui.app.mockInput.pressArrow("down")
  await Bun.sleep(80)
  await ui.key("r", { ctrl: true })
  await wait(() => ui.frame().includes("Rename session"))
  expect(ui.frame()).toContain("Leave it empty to go back to the automatic name.")
  // Prefilled with the current name: cleared, then the new one typed.
  expect(ui.frame()).toContain(title)
  for (let i = 0; i < title.length + 2; i++) ui.app.mockInput.pressBackspace()
  await Bun.sleep(40)
  await ui.app.mockInput.typeText(name)
  await ui.enter()
  return ui
}

test("XCOD-325: the footer shows the rename key, on a Claude Code row and in Show archived too", async () => {
  const server = fakeServer({
    sessions: [
      row("external:cc", { kind: "external", tool: "claude", title: "Claude Code · api", updated: Date.now() }),
      row("f9", { updated: Date.now() - 1000 }),
      row("a1", { archived: Date.now() - 1000 }),
    ],
  })
  const ui = await mountList(server)
  try {
    // On the Claude Code row (no longer dimmed: it can be renamed too).
    ui.app.mockInput.pressArrow("down")
    await wait(() => ui.frame().includes("rename ctrl+r"))
    await ui.press("dialog.sessions.archived")
    await wait(() => ui.frame().includes("title a1"))
    expect(ui.frame()).toContain("rename ctrl+r")
    await ui.press("dialog.sessions.archived")
    await wait(() => ui.frame().includes("Sessions — all projects"))
  } finally {
    ui.cleanup()
  }
})

test("XCOD-325: a Lunos session, another Lunos's and a Claude Code session are each renamed the right way", async () => {
  const server = fakeServer({
    sessions: [
      row("own", { updated: Date.now() }),
      row("e1", { state: "running", elsewhere: true, updated: Date.now() - 1000 }),
      row("external:cc", { kind: "external", tool: "claude", title: "Claude Code · api", updated: Date.now() - 2000 }),
      // Keeps its name: the view is ready once a "title …" row is listed.
      row("keep", { updated: Date.now() - 3000 }),
    ],
  })
  for (const [index, title, name] of [
    [1, "title own", "Mine"],
    [2, "title e1", "Theirs"],
    [3, "Claude Code · api", "API work"],
  ] as const) {
    const ui = await renameRow(server, index, title, name)
    try {
      await wait(() => ui.frame().includes(name))
    } finally {
      ui.cleanup()
    }
  }
  expect(server.calls).toEqual([
    { path: "rename own", body: { title: "Mine" } },
    { path: "rename e1", body: { title: "Theirs" } },
    { path: "rename external:cc", body: { title: "API work" } },
  ])
})

test("XCOD-325: a rename that can't be saved keeps the old name and the row says why", async () => {
  const server = fakeServer({
    sessions: [row("e2", { state: "running", elsewhere: true, updated: Date.now() })],
    unreachable: ["e2"],
  })
  const ui = await renameRow(server, 1, "title e2", "Never saved")
  try {
    await wait(() => ui.frame().includes("Couldn't rename: the Lunos running it isn't responding"))
    expect(ui.frame()).toContain("title e2")
    expect(ui.frame()).not.toContain("Never saved")
  } finally {
    ui.cleanup()
  }
})

test("XCOD-325: renaming a session deleted meanwhile says so", async () => {
  const server = fakeServer({ sessions: [row("gone", { updated: Date.now() })], deleted: ["gone"] })
  const ui = await renameRow(server, 1, "title gone", "Too late")
  try {
    await wait(() => ui.frame().includes("Couldn't rename: the session was deleted"))
    expect(ui.frame()).toContain("title gone")
  } finally {
    ui.cleanup()
  }
})
