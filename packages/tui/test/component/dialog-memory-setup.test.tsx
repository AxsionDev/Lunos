/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

// XCOD-264: the setup wizard's "Where should memory be stored?" step, rendered headlessly with the
// server mocked: the cards and "What this means", Compare (c), Help me choose (?), PostgreSQL setup
// with Test connection, switching storage (Move my facts), and Docker templates without Docker.

const ENVIRONMENT = {
  environment: {
    paths: { project: "/tmp/opencode/.opencode/memory/graph" },
    model: { id: "mistral/ministral-8b", region: "EU" },
    localModels: [],
  },
  templates: [
    {
      name: "just-me",
      title: "Just me, on this computer",
      leaves: "the fact text, to your model, to pull out names and relationships",
      memory: { backend: { type: "embedded" }, encryption: "os-keychain" },
    },
    {
      name: "neo4j-docker",
      title: "Neo4j in Docker on this computer",
      leaves: "nothing: no model calls, and the database runs on this computer",
      requires: ["docker"],
      memory: { backend: { type: "neo4j" } },
      unavailable: "Docker or Podman not found (install: https://docs.docker.com/get-docker/)",
    },
  ],
}

type Call = { path: string; body?: any }

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(input: { root: string; memory?: Record<string, unknown>; test?: Record<string, unknown> }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const calls: Call[] = []
  const events = createEventSource()
  const base = createFetch((url) => {
    if (url.pathname === "/config") return json({ memory: input.memory })
    if (url.pathname === "/memory/setup/environment") return json(ENVIRONMENT)
    if (url.pathname === "/memory/setup/test")
      return json(input.test ?? { ok: true, ms: 12, server: "PostgreSQL 17 at db.example.eu", warnings: [] })
    if (url.pathname === "/memory/setup/move") return json({ ok: true, facts: 3 })
    if (url.pathname === "/config/settings") return json({ ok: true, restart: true })
    if (url.pathname === "/api/event") return events.response()
    return undefined
  }, events)
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const text = req.method === "GET" ? "" : await req.clone().text()
    calls.push({ path: new URL(req.url).pathname, body: text ? JSON.parse(text) : undefined })
    return base.fetch(req)
  }) as typeof globalThis.fetch

  const [
    { ArgsProvider },
    { KVProvider },
    { SDKProvider },
    { SyncProvider, useSync },
    { ProjectProvider },
    { PermissionProvider },
    { ExitProvider },
    { DialogProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { useMemorySetup },
  ] = await Promise.all([
    import("../../src/context/args"),
    import("../../src/context/kv"),
    import("../../src/context/sdk"),
    import("../../src/context/sync"),
    import("../../src/context/project"),
    import("../../src/context/permission"),
    import("../../src/context/exit"),
    import("../../src/ui/dialog"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
    import("../../src/component/dialog-memory-setup"),
  ])
  let exited = false

  function Start() {
    const sync = useSync()
    const setup = useMemorySetup()
    onMount(async () => {
      await wait(() => sync.status === "complete")
      setup({ scope: "user", rows: [], onExit: () => (exited = true) })
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TestTuiContexts directory={input.root} paths={{ home: input.root, state, worktree: input.root }}>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
              <PermissionProvider>
                <ProjectProvider>
                  <ExitProvider exit={() => {}}>
                    <SyncProvider>
                      <OpencodeKeymapProvider keymap={keymap}>
                        <TuiConfigProvider config={config}>
                          <ThemeProvider mode="dark">
                            <ToastProvider>
                              <DialogProvider>
                                <Start />
                              </DialogProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </TuiConfigProvider>
                      </OpencodeKeymapProvider>
                    </SyncProvider>
                  </ExitProvider>
                </ProjectProvider>
              </PermissionProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 120, height: 45, kittyKeyboard: true })
  const frame = () => app.captureCharFrame()
  const see = async (text: string) => {
    try {
      await wait(() => frame().includes(text))
    } catch {
      throw new Error(`"${text}" never appeared. Last frame:\n${frame()}`)
    }
  }
  return {
    app,
    calls,
    frame,
    see,
    exited: () => exited,
    async enter() {
      app.mockInput.pressEnter()
      await Bun.sleep(60)
    },
    async down(times = 1) {
      for (let i = 0; i < times; i++) {
        app.mockInput.pressArrow("down")
        await Bun.sleep(30)
      }
    },
    async key(key: string, modifiers?: { shift?: boolean }) {
      app.mockInput.pressKey(key, modifiers)
      await Bun.sleep(60)
    },
    async type(text: string) {
      await app.mockInput.typeText(text)
      await Bun.sleep(30)
    },
    cleanup: () => app.renderer.destroy(),
  }
}

/** Step 1 (turn memory on), then step 2's "Choose storage myself". */
async function toCards(ui: Awaited<ReturnType<typeof mount>>) {
  await ui.see("Turn on memory?")
  await ui.enter()
  await ui.see("Choose storage myself")
  await ui.enter()
  await ui.see("What this means")
}

test("the cards explain each option with this machine's path, model and region; Memgraph is greyed out", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path })
  try {
    await toCards(ui)
    const frame = ui.frame()
    expect(frame).toContain("What this means — On this computer")
    expect(frame).toContain("/tmp/opencode/.opencode/memory/graph")
    expect(frame).toContain("mistral/ministral-8b (EU)")
    expect(frame).toContain("recommended for one person")
    expect(frame).toContain("Team database: PostgreSQL")
    expect(frame).toContain("Coming soon")
    // No UI text says "embedded".
    expect(frame.toLowerCase()).not.toContain("embedded")
    await ui.down()
    await ui.see("What this means — Team database: Neo4j")
    expect(ui.frame()).toContain("No model calls")
    await ui.down(2)
    await ui.see("What this means — Team database: Memgraph")
    expect(ui.frame()).toContain("(Coming soon)")
    // Picking it does nothing but say why.
    await ui.enter()
    await ui.see("What this means — Team database: Memgraph")
    expect(ui.calls.some((call) => call.path === "/memory/setup/test")).toBe(false)
  } finally {
    ui.cleanup()
  }
})

test("c compares the options side by side; ? helps choose: just me → this computer, team on Postgres → PostgreSQL", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path })
  try {
    await toCards(ui)
    await ui.key("c")
    await ui.see("Compare where memory can be stored")
    for (const row of [
      "Where it's stored",
      "What leaves the computer",
      "Model calls",
      "Shared",
      "Search type",
      "Setup needed",
      "Offline use",
    ])
      expect(ui.frame()).toContain(row)
    await ui.enter()
    await ui.see("What this means")

    await ui.key("?")
    await ui.see("Just you, or your team?")
    await ui.enter()
    await ui.see("Recommended: On this computer.")
    expect(ui.frame()).toContain("What this means — On this computer")

    await ui.key("?")
    await ui.see("Just you, or your team?")
    await ui.down()
    await ui.enter()
    await ui.see("Do you already run one")
    await ui.enter()
    await ui.see("Recommended: Team database: PostgreSQL.")
    expect(ui.frame()).toContain("What this means — Team database: PostgreSQL")
  } finally {
    ui.cleanup()
  }
})

test("PostgreSQL: URL, region, references, Test connection, then the summary repeats what it means", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path })
  try {
    await toCards(ui)
    await ui.down(2)
    await ui.see("What this means — Team database: PostgreSQL")
    await ui.enter()
    await ui.see("Team database: PostgreSQL: URL")
    await ui.type("postgres://db.example.eu:5432/lunos")
    await ui.enter()
    await ui.see("Where it runs")
    await ui.type("EU-DE")
    await ui.enter()
    await ui.see("Username")
    await ui.enter()
    await ui.see("Password")
    await ui.enter()
    // Test connection passed: on to retention (no model or download step for a team database).
    await ui.see("Keep facts until I remove them")
    const tested = ui.calls.find((call) => call.path === "/memory/setup/test")
    expect(tested?.body.memory.backend).toEqual({
      type: "postgres",
      url: "postgres://db.example.eu:5432/lunos",
      jurisdiction: "EU-DE",
      username: "{env:POSTGRES_USER}",
      password: "{env:POSTGRES_PASSWORD}",
    })
    await ui.enter()
    await ui.see("Encrypt the fact")
    await ui.enter()
    await ui.see("Summary")
    expect(ui.frame()).toContain("memory.backend.type = postgres")
    expect(ui.frame()).toContain("Stored: Team database: PostgreSQL. What this means:")
    expect(ui.frame()).toContain("db.example.eu")
  } finally {
    ui.cleanup()
  }
})

test("a residency refusal at Test connection can't be saved", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({
    root: tmp.path,
    test: {
      ok: false,
      error: {
        type: "residency",
        stage: "residency",
        message: 'Blocked by data-residency policy. memory.backend declares jurisdiction "US"',
        fix: "Pick a database in a region your residency policy allows.",
      },
    },
  })
  try {
    await toCards(ui)
    await ui.down(2)
    await ui.enter()
    await ui.see("URL")
    await ui.type("postgres://db.example.com:5432/lunos")
    await ui.enter()
    await ui.see("Where it runs")
    await ui.type("US")
    await ui.enter()
    await ui.see("Username")
    await ui.enter()
    await ui.see("Password")
    await ui.enter()
    await ui.see("✗ residency: Blocked by data-residency policy")
    expect(ui.frame()).toContain("Pick a database in a region your residency policy")
    expect(ui.frame()).toContain("Change the settings")
    expect(ui.frame()).not.toContain("Use these settings anyway")
  } finally {
    ui.cleanup()
  }
})

test("switching from a team Neo4j to this computer offers Move or Start empty; Move runs before saving", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({
    root: tmp.path,
    memory: {
      enabled: true,
      encryption: "off",
      backend: {
        type: "neo4j",
        url: "bolt+s://graph.example.eu:7687",
        username: "{env:NEO4J_USER}",
        password: "{env:NEO4J_PASSWORD}",
        jurisdiction: "EU-DE",
      },
    },
  })
  try {
    await toCards(ui)
    // Neo4j is the current storage; go up to "On this computer".
    await ui.app.mockInput.pressArrow("up")
    await ui.see("What this means — On this computer")
    await ui.enter()
    await ui.see("The small model")
    await ui.enter()
    await ui.see("Download now")
    await ui.down()
    await ui.enter()
    await ui.see("Keep facts until I remove them")
    await ui.enter()
    await ui.see("Encrypt the fact")
    await ui.enter()
    await ui.see("Summary")
    expect(ui.frame()).toContain("Save and move my facts")
    expect(ui.frame()).toContain("Save and start empty")
    expect(ui.frame()).toContain("You're switching storage.")
    await ui.enter()
    await wait(() => ui.calls.some((call) => call.path === "/config/settings"))
    const paths = ui.calls.map((call) => call.path)
    expect(paths.indexOf("/memory/setup/move")).toBeGreaterThan(-1)
    expect(paths.indexOf("/memory/setup/move")).toBeLessThan(paths.indexOf("/config/settings"))
    expect(ui.calls.find((call) => call.path === "/memory/setup/move")!.body.memory).toMatchObject({ enabled: true })
  } finally {
    ui.cleanup()
  }
})

test("without Docker, the Docker templates say so and can't be applied", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path })
  try {
    await ui.see("Turn on memory?")
    await ui.enter()
    await ui.see("Start from a template")
    await ui.down()
    await ui.enter()
    await ui.see("Leaves the computer: the fact text, to your model")
    await ui.down()
    await ui.see("Can't be used: Docker or Podman not found")
    await ui.enter()
    await Bun.sleep(100)
    expect(ui.calls.some((call) => call.path.startsWith("/memory/setup/template"))).toBe(false)
  } finally {
    ui.cleanup()
  }
})
