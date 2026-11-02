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

// /memory's Storage panel, rendered headlessly at 120x45 with the server mocked: each storage
// type, a stopped container, Test connection, a locked backend, memory off, and Change storage…
// with Move my facts and with Start empty.

const STATS = {
  version: 1,
  generatedAt: "2026-10-20T12:00:00.000Z",
  rangeDays: 30,
  since: "2026-09-20T12:00:00.000Z",
  status: {
    on: true,
    reason: null,
    backend: { type: "embedded", host: null, jurisdiction: null },
    encryption: "off",
    retentionDays: null,
    graceDays: 7,
    health: [],
  },
  scopes: [
    {
      scope: "project",
      counts: { active: 3, outdated: 0, expiring: 0, expired: 0, quarantined: 0 },
      lastWrite: "2026-10-01T10:00:00.000Z",
      error: null,
      chars: 80,
      tokens: 20,
    },
  ],
  maxTokens: 1500,
  sources: { source: {}, agent: {}, kind: {}, native: 3, imported: {} },
  growth: [],
  recall: {
    audit: false,
    dataSince: null,
    total: 0,
    perDay: [],
    origin: {},
    hitRate: null,
    avgFacts: null,
    truncatedRate: null,
  },
  top: [],
  supersession: { count: 0, chains: [] },
  facts: {},
  groups: {},
}

const NOW = new Date(Date.now() - 2 * 60_000).toISOString()

const EMBEDDED = {
  on: true,
  place: "embedded",
  vendor: "embedded",
  locked: false,
  leaves: "the fact text, sent to your model mistral/ministral-8b (EU) to pull out names and relationships.",
  encryption: "os-keychain",
  retentionDays: 90,
  paths: ["/tmp/opencode/.opencode/memory/graph"],
  bytes: 3 * 1024 * 1024,
  model: { id: "mistral/ministral-8b", region: "EU" },
  status: { state: "unchecked" },
}

const DOCKER = {
  on: true,
  place: "docker",
  vendor: "neo4j",
  template: { name: "neo4j-docker", title: "Neo4j in Docker on this computer", scope: "user" },
  locked: false,
  leaves: "nothing: no model calls, and the database runs on this computer.",
  encryption: "off",
  url: "bolt://localhost:7687",
  host: "localhost",
  jurisdiction: "local",
  tls: "none",
  credentials: ["NEO4J_USER", "NEO4J_PASSWORD"],
  container: {
    tool: "docker",
    name: "lunos-memory-neo4j-docker-neo4j-1",
    image: "neo4j:5",
    state: "running",
    project: "lunos-memory-neo4j-docker",
  },
  status: { state: "connected", at: NOW, server: "Neo4j 5.26" },
}

const TEAM = {
  on: true,
  place: "team",
  vendor: "postgres",
  template: { name: "team-hosted", title: "Team database we host", scope: "user" },
  locked: false,
  leaves: "the fact text, to your database.",
  encryption: "off",
  url: "postgres://db.example.eu:5432/lunos",
  host: "db.example.eu",
  jurisdiction: "EU-DE",
  tls: "verified",
  readOnly: false,
  credentials: ["POSTGRES_USER", "POSTGRES_PASSWORD"],
  status: { state: "connected", at: NOW, server: "PostgreSQL 17" },
}

const CLOUD = {
  ...TEAM,
  place: "cloud",
  vendor: "neo4j",
  template: { name: "managed-cloud", title: "Managed cloud database", scope: "user" },
  url: "neo4j+s://abcd1234.databases.neo4j.io",
  host: "abcd1234.databases.neo4j.io",
  provider: "Neo4j Aura",
  residency: { allowed: true },
  credentials: ["NEO4J_USER", "NEO4J_PASSWORD"],
}

const TEAM_CONFIG = {
  enabled: true,
  encryption: "off",
  template: "team-hosted",
  backend: {
    type: "postgres",
    url: "postgres://db.example.eu:5432/lunos",
    username: "{env:POSTGRES_USER}",
    password: "{env:POSTGRES_PASSWORD}",
    jurisdiction: "EU-DE",
  },
}

const ENVIRONMENT = {
  environment: { paths: { project: "/tmp/opencode/.opencode/memory/graph" }, localModels: [] },
  templates: [
    {
      name: "just-me",
      title: "Just me, on this computer",
      leaves: "the fact text, to your model, to pull out names and relationships",
      memory: { backend: { type: "embedded" }, encryption: "os-keychain" },
    },
  ],
}

type Call = { path: string; method: string; body?: any }

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(input: {
  root: string
  panel: Record<string, unknown>
  memory?: Record<string, unknown>
  statsOn?: boolean
  test?: Record<string, unknown>
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const calls: Call[] = []
  const events = createEventSource()
  const stats = { ...STATS, status: { ...STATS.status, on: input.statsOn ?? true } }
  const base = createFetch((url) => {
    if (url.pathname === "/config") return json({ memory: input.memory ?? { enabled: true } })
    if (url.pathname === "/memory") return json({ on: input.statsOn ?? true, facts: [] })
    if (url.pathname === "/memory/stats") return json(stats)
    if (url.pathname === "/memory/storage") return json(input.panel)
    if (url.pathname === "/memory/storage/test")
      return json(input.test ?? { state: "connected", at: new Date().toISOString(), ms: 42, server: "PostgreSQL 17" })
    if (url.pathname === "/memory/storage/start") return json({ ok: true })
    if (url.pathname === "/memory/setup/environment") return json(ENVIRONMENT)
    if (url.pathname === "/memory/setup/move") return json({ ok: true, facts: 3, expected: 3 })
    if (url.pathname === "/memory/setup/check") return json({ ok: true, scope: "project", ms: 900 })
    if (url.pathname === "/api/event") return events.response()
    return undefined
  }, events)
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const text = req.method === "GET" ? "" : await req.clone().text()
    const pathname = new URL(req.url).pathname
    calls.push({ path: pathname, method: req.method, body: text ? JSON.parse(text) : undefined })
    if (pathname === "/config/settings")
      return req.method === "GET"
        ? json({ rows: [{ key: "memory.backend.type", source: "user" }] })
        : json({ ok: true, restart: true })
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
    { DialogProvider, useDialog },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { DialogMemory },
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
    import("../../src/component/dialog-memory"),
  ])

  function Start() {
    const sync = useSync()
    const dialog = useDialog()
    onMount(async () => {
      await wait(() => sync.status === "complete")
      dialog.replace(() => <DialogMemory />)
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
    cleanup: () => app.renderer.destroy(),
  }
}

test("on this computer: the path, size, model and region, encryption and retention", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: EMBEDDED })
  try {
    await ui.see("On this computer")
    const frame = ui.frame()
    expect(frame).toContain("○ not checked yet")
    expect(frame).toContain("Path: /tmp/opencode/.opencode/memory/graph · 3.0 MB on disk")
    expect(frame).toContain("Model: mistral/ministral-8b (EU)")
    expect(frame).toContain("encryption: on (OS keychain) · kept 90 days")
    expect(frame).toContain("Template: Custom")
    // The actions, first in the list; the old status rows are gone.
    expect(frame).toContain("Change storage…")
    expect(frame).toContain("Test connection")
    expect(frame).toContain("Open in Settings")
    expect(frame).not.toContain("Set up memory in Settings")
  } finally {
    ui.cleanup()
  }
})

test("a Docker template: the template, URL, container name and image, running", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: DOCKER })
  try {
    await ui.see("Neo4j in Docker on this computer")
    const frame = ui.frame()
    expect(frame).toContain("● connected")
    expect(frame).toContain("bolt://localhost:7687")
    expect(frame).toContain("Container: lunos-memory-neo4j-docker-neo4j-1 (neo4j:5) · ● running")
    expect(frame).toContain("Template: neo4j-docker · scope: user")
    expect(frame).toContain("checked 2 min ago")
    expect(frame).not.toContain("Start container")
  } finally {
    ui.cleanup()
  }
})

test("a stopped container shows stopped and Start container, which starts it after confirming", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({
    root: tmp.path,
    panel: {
      ...DOCKER,
      container: { ...DOCKER.container, state: "stopped" },
      status: { state: "unreachable", at: NOW, error: { stage: "connect", message: "ECONNREFUSED 127.0.0.1:7687" } },
    },
  })
  try {
    await ui.see("○ stopped")
    expect(ui.frame()).toContain("✗ unreachable")
    expect(ui.frame()).toContain("✗ connect: ECONNREFUSED 127.0.0.1:7687")
    // Change storage…, Test connection, Start container.
    await ui.down(2)
    await ui.enter()
    await ui.see("Run docker start lunos-memory-neo4j-docker-neo4j-1?")
    expect(ui.calls.some((call) => call.path === "/memory/storage/start")).toBe(false)
    await ui.enter()
    await wait(() => ui.calls.some((call) => call.path === "/memory/storage/start" && call.method === "POST"))
  } finally {
    ui.cleanup()
  }
})

test("a team database: host, jurisdiction, TLS, credential names and never a password", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: TEAM })
  try {
    await ui.see("Team database: PostgreSQL")
    const frame = ui.frame()
    expect(frame).toContain("Host: db.example.eu · jurisdiction EU-DE · TLS on")
    expect(frame).toContain("Credentials: from POSTGRES_USER and POSTGRES_PASSWORD (never")
    expect(frame).not.toContain("password:")
  } finally {
    ui.cleanup()
  }
})

test("managed cloud: provider, region and the residency result", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: CLOUD })
  try {
    await ui.see("Managed cloud database: Neo4j Aura")
    expect(ui.frame()).toContain("Provider: Neo4j Aura · region EU-DE · residency: allowed")
  } finally {
    ui.cleanup()
  }
})

test("Test connection shows the result and updates checked", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: EMBEDDED })
  try {
    await ui.see("○ not checked yet")
    await ui.down()
    await ui.enter()
    await ui.see("● connected")
    expect(ui.frame()).toContain("checked just now (42 ms)")
    expect(ui.calls.some((call) => call.path === "/memory/storage/test" && call.method === "POST")).toBe(true)
  } finally {
    ui.cleanup()
  }
})

test("an organisation-locked backend: Set by your organisation, and no Change storage…", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: { ...TEAM, locked: true } })
  try {
    await ui.see("Set by your organisation")
    expect(ui.frame()).not.toContain("Change storage…")
    expect(ui.frame()).toContain("Test connection")
  } finally {
    ui.cleanup()
  }
})

test("memory off: Memory is off, with Set up memory… and What memory does", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({
    root: tmp.path,
    statsOn: false,
    memory: {},
    panel: { ...EMBEDDED, on: false, reason: "memory is off", status: { state: "off" } },
  })
  try {
    await ui.see("Memory is off")
    expect(ui.frame()).toContain("○ memory off")
    expect(ui.frame()).toContain("Set up memory…")
    expect(ui.frame()).toContain("What memory does")
    await ui.enter()
    // The wizard, from its first step.
    await ui.see("Turn on memory?")
  } finally {
    ui.cleanup()
  }
})

/** Change storage… → "Where should memory be stored?" → Choose storage myself → On this computer. */
async function changeToThisComputer(ui: Awaited<ReturnType<typeof mount>>) {
  await ui.see("Change storage…")
  await ui.enter()
  // Straight to the storage step: no "Turn on memory?".
  await ui.see("Choose storage myself")
  expect(ui.frame()).toContain("Change storage · Where should")
  expect(ui.frame()).not.toContain("Turn on memory?")
  await ui.enter()
  await ui.see("What this means")
  // The team PostgreSQL is the current storage; "On this computer" is two up.
  ui.app.mockInput.pressArrow("up")
  await Bun.sleep(30)
  ui.app.mockInput.pressArrow("up")
  await ui.see("What this means — On this computer")
  await ui.enter()
  await ui.see("The small model")
  await ui.enter()
  await ui.see("Download now")
  // Download now: the check runs before the summary.
  await ui.enter()
  await ui.see("Keep facts until I remove them")
  await ui.enter()
  await ui.see("Encrypt the fact")
  await ui.down()
  await ui.enter()
  await ui.see("Run the check")
  await ui.enter()
  await ui.see("Continue")
  await ui.enter()
  await ui.see("Save and move my facts")
}

test("Change storage… with Move my facts: moves before saving, then removes the template", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: TEAM, memory: TEAM_CONFIG })
  try {
    await changeToThisComputer(ui)
    expect(ui.calls.some((call) => call.path === "/memory/setup/check")).toBe(true)
    await ui.enter()
    await wait(() => ui.calls.some((call) => call.path === "/config/settings" && call.method !== "GET"))
    const writes = ui.calls.filter((call) => call.path === "/config/settings" && call.method !== "GET")
    const move = ui.calls.findIndex((call) => call.path === "/memory/setup/move")
    expect(move).toBeGreaterThan(-1)
    expect(move).toBeLessThan(ui.calls.indexOf(writes[0]!))
    await wait(() => ui.calls.filter((call) => call.path === "/config/settings" && call.method !== "GET").length >= 2)
    const keys = ui.calls
      .filter((call) => call.path === "/config/settings" && call.method !== "GET")
      .map((call) => call.body.settingsSetInput?.key ?? call.body.key)
    expect(keys).toContain("memory.backend.type")
    expect(keys).toContain("memory.template")
  } finally {
    ui.cleanup()
  }
})

test("Change storage… with Start empty: names where the old facts stay, and moves nothing", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: TEAM, memory: TEAM_CONFIG })
  try {
    await changeToThisComputer(ui)
    expect(ui.frame()).toContain("the old ones stay, untouched,")
    expect(ui.frame()).toContain("in Team database: PostgreSQL at db.example.eu:5432.")
    await ui.down()
    await ui.enter()
    await wait(() => ui.calls.some((call) => call.path === "/config/settings" && call.method !== "GET"))
    expect(ui.calls.some((call) => call.path === "/memory/setup/move")).toBe(false)
  } finally {
    ui.cleanup()
  }
})

test("Esc and ← on the storage step go back to /memory", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, panel: TEAM, memory: TEAM_CONFIG })
  try {
    await ui.see("Change storage…")
    await ui.enter()
    await ui.see("Choose storage myself")
    ui.app.mockInput.pressEscape()
    await ui.see("Host: db.example.eu")
    await ui.enter()
    await ui.see("Choose storage myself")
    // Deeper in: Esc still comes back to /memory, nothing is saved.
    await ui.enter()
    await ui.see("What this means")
    ui.app.mockInput.pressEscape()
    await ui.see("Host: db.example.eu")
    await ui.enter()
    await ui.see("Choose storage myself")
    ui.app.mockInput.pressArrow("left")
    await ui.see("Host: db.example.eu")
    expect(ui.calls.some((call) => call.path === "/config/settings" && call.method !== "GET")).toBe(false)
  } finally {
    ui.cleanup()
  }
})
