import { describe, expect, test } from "bun:test"
import { MemoryStorage } from "../src/memory-storage"

// XCOD-264: the "Where should memory be stored?" step's words and choices.

const env: MemoryStorage.Environment = {
  paths: { project: "/repo/.opencode/memory/graph" },
  model: { id: "mistral/ministral-8b", region: "EU" },
  docker: { tool: "docker", compose: true },
  localModels: [],
}

describe("cards", () => {
  test("on this computer: the real path, model and region; no card says embedded", () => {
    const cards = MemoryStorage.cards(env)
    expect(cards.map((card) => card.title)).toEqual([
      "On this computer",
      "Team database: Neo4j",
      "Team database: PostgreSQL",
      "Team database: Memgraph",
    ])
    const local = MemoryStorage.meaning(cards[0]).join("\n")
    expect(local).toContain(
      "Stored: in /repo/.opencode/memory/graph on this computer, in SQLite, LanceDB and a local graph.",
    )
    expect(local).toContain("sent to your model mistral/ministral-8b (EU) to pull out names and relationships")
    expect(local).toContain("Search embeddings are made on this computer.")
    expect(cards[0].recommended).toBe("recommended for one person")
    const text = [
      ...cards.flatMap((card) => [card.title, card.summary, card.recommended ?? "", ...MemoryStorage.meaning(card)]),
      ...MemoryStorage.compareLines(env),
    ].join("\n")
    expect(text.toLowerCase()).not.toContain("embedded")
  })

  test("Memgraph is Coming soon until it's supported", () => {
    expect(MemoryStorage.cards(env).find((card) => card.kind === "memgraph")?.unavailable).toBe("Coming soon")
    expect(
      MemoryStorage.cards(env, { memgraph: true }).find((card) => card.kind === "memgraph")?.unavailable,
    ).toBeUndefined()
  })

  test("a team database names the host and makes no model calls", () => {
    const neo4j = MemoryStorage.cards(env, { host: "graph.example.eu" })[1]
    expect(MemoryStorage.meaning(neo4j)).toContain(
      "Leaves the computer: the fact text, to your database at graph.example.eu only. No model calls.",
    )
  })

  test("with a local model nothing leaves the computer", () => {
    const local = {
      ...env,
      model: { id: "ollama/qwen3:4b", region: "on this computer" },
      localModels: ["ollama/qwen3:4b"],
    }
    expect(MemoryStorage.leaves("embedded", local)).toStartWith("nothing.")
  })
})

test("Compare has the seven rows, one column per supported option", () => {
  const table = MemoryStorage.compare(env)
  expect(table.rows).toEqual([
    "Where it's stored",
    "What leaves the computer",
    "Model calls",
    "Shared",
    "Search type",
    "Setup needed",
    "Offline use",
  ])
  expect(table.columns.map((column) => column.title)).toEqual([
    "On this computer",
    "Team database: Neo4j",
    "Team database: PostgreSQL",
  ])
  for (const column of table.columns) expect(column.values).toHaveLength(7)
})

describe("Help me choose", () => {
  test("just me → on this computer", () => {
    expect(MemoryStorage.choose({ who: "me", runs: "none" }).kind).toBe("embedded")
    expect(MemoryStorage.choose({ who: "me", runs: "postgres" }).kind).toBe("embedded")
  })
  test("team, we run Postgres → PostgreSQL; Neo4j → Neo4j; neither → PostgreSQL, with the Docker template", () => {
    expect(MemoryStorage.choose({ who: "team", runs: "postgres" }).kind).toBe("postgres")
    expect(MemoryStorage.choose({ who: "team", runs: "neo4j" }).kind).toBe("neo4j")
    const neither = MemoryStorage.choose({ who: "team", runs: "none" })
    expect(neither.kind).toBe("postgres")
    expect(neither.reason).toContain("PostgreSQL in Docker on this computer")
  })
})

describe("templates", () => {
  test("the built-in six, each saying what leaves the computer; Fully local only with a local model", () => {
    expect(MemoryStorage.BUILTIN.map((item) => item.name)).toEqual([
      "just-me",
      "fully-local",
      "neo4j-docker",
      "postgres-docker",
      "team-hosted",
      "managed-cloud",
    ])
    for (const item of MemoryStorage.BUILTIN) expect(item.leaves.length).toBeGreaterThan(3)
    expect(MemoryStorage.templates(env).map((item) => item.name)).not.toContain("fully-local")
    const local = MemoryStorage.templates({ ...env, localModels: ["ollama/qwen3:4b"] })
    expect(local.map((item) => item.name)).toContain("fully-local")
    expect(
      MemoryStorage.memoryOf(MemoryStorage.find(local, "fully-local")!, { localModel: "ollama/qwen3:4b" }),
    ).toMatchObject({
      model: "ollama/qwen3:4b",
      backend: { type: "embedded" },
    })
  })

  test("without Docker the Docker templates stay listed but can't be used", () => {
    const none = MemoryStorage.templates({ ...env, docker: undefined })
    expect(MemoryStorage.find(none, "neo4j-docker")?.unavailable).toStartWith("Docker or Podman not found")
    expect(MemoryStorage.find(none, "postgres-docker")?.unavailable).toStartWith("Docker or Podman not found")
    expect(MemoryStorage.find(none, "just-me")?.unavailable).toBeUndefined()
    const noCompose = MemoryStorage.templates({ ...env, docker: { tool: "podman", compose: false } })
    expect(MemoryStorage.find(noCompose, "neo4j-docker")?.unavailable).toStartWith("Docker Compose not found")
  })

  test("an organisation's template is listed first; a hidden built-in isn't listed", () => {
    const list = MemoryStorage.templates(env, {
      custom: [
        {
          name: "acme-neo4j",
          title: "Our team Neo4j",
          leaves: "the fact text, to Acme's Neo4j in Frankfurt",
          memory: { backend: { type: "neo4j", url: "bolt+s://graph.acme.eu:7687", jurisdiction: "EU-DE" } },
        },
      ],
      hide: ["neo4j-docker", "managed-cloud"],
    })
    expect(list[0]).toMatchObject({ name: "acme-neo4j", organisation: true })
    expect(list.map((item) => item.name)).not.toContain("neo4j-docker")
    expect(list.map((item) => item.name)).not.toContain("managed-cloud")
  })

  test("Docker templates: localhost only, credentials as {env:} references, the password only in the env file", () => {
    for (const name of ["neo4j-docker", "postgres-docker"]) {
      const item = MemoryStorage.find(MemoryStorage.templates(env), name)!
      const memory = MemoryStorage.memoryOf(item, {})
      const backend = memory.backend as Record<string, string>
      expect(backend.username).toMatch(/^\{env:[A-Z0-9_]+\}$/)
      expect(backend.password).toMatch(/^\{env:[A-Z0-9_]+\}$/)
      expect(new URL(backend.url).hostname).toBe("localhost")
      const files = MemoryStorage.files(item, { password: "s3cret-password-value-1234", project: "p" })
      expect(files.compose).not.toContain("s3cret")
      expect(files.example).not.toContain("s3cret")
      expect(files.env).toContain("s3cret-password-value-1234")
      // Every published port is bound to 127.0.0.1.
      const ports = files.compose.split("\n").filter((line) => /^\s+- "[\d.]*:?\$?\{?[\w:-]*\}?:\d+"$/.test(line))
      expect(ports.length).toBeGreaterThan(0)
      for (const line of ports) expect(line).toContain('"127.0.0.1:')
    }
  })

  test("team templates ask for the database, URL and region", () => {
    const item = MemoryStorage.find(MemoryStorage.templates(env), "team-hosted")!
    expect(item.ask).toEqual(["vendor", "url", "jurisdiction"])
    expect(
      MemoryStorage.memoryOf(item, { vendor: "postgres", url: "postgres://db:5432/x", jurisdiction: "EU-DE" }).backend,
    ).toEqual({
      type: "postgres",
      url: "postgres://db:5432/x",
      username: "{env:POSTGRES_USER}",
      password: "{env:POSTGRES_PASSWORD}",
      jurisdiction: "EU-DE",
    })
  })
})

test("labels", () => {
  expect(MemoryStorage.label("embedded")).toBe("On this computer")
  expect(MemoryStorage.label(undefined)).toBe("On this computer")
  expect(MemoryStorage.short({ type: "postgres", host: "db", jurisdiction: "EU-DE" })).toBe("PostgreSQL at db (EU-DE)")
  expect(MemoryStorage.short(undefined)).toBe("on this computer")
})

test("the Memory templates page shows each Docker template's compose file as generated", async () => {
  const page = await Bun.file(new URL("../../../docs/memory-templates.md", import.meta.url)).text()
  for (const name of ["neo4j-docker", "postgres-docker"]) {
    const item = MemoryStorage.BUILTIN.find((entry) => entry.name === name)!
    const files = MemoryStorage.files(item, { password: "<generated>", project: `lunos-memory-${name}` })
    expect(page).toContain(files.compose)
  }
})

// The Storage panel at the top of /memory's Overview, and `lunos memory status`'s block.
describe("storage panel", () => {
  const now = Date.parse("2026-10-20T12:00:00Z")
  const base = {
    on: true,
    locked: false,
    encryption: "off" as const,
    status: { state: "connected" as const, at: "2026-10-20T11:58:00Z", ms: 12, server: "Neo4j 5.26" },
  }

  test("on this computer: the path, size, model and region, encryption and retention", () => {
    const text = MemoryStorage.panelText(
      {
        ...base,
        place: "embedded",
        encryption: "os-keychain",
        retentionDays: 90,
        leaves: MemoryStorage.leaves("embedded", env),
        paths: ["/repo/.opencode/memory/graph"],
        bytes: 3 * 1024 * 1024,
        model: { id: "mistral/ministral-8b", region: "EU" },
        status: { state: "unchecked" },
      },
      now,
    )
    expect(text[0]).toBe("Storage   On this computer   ○ not checked yet")
    expect(text).toContain("          Path: /repo/.opencode/memory/graph · 3.0 MB on disk")
    expect(text).toContain("          Model: mistral/ministral-8b (EU)")
    expect(text).toContain("          Template: Custom · encryption: on (OS keychain) · kept 90 days")
  })

  test("a Docker template: the template, URL, container name and image, and its state", () => {
    const panel: MemoryStorage.Panel = {
      ...base,
      place: "docker",
      vendor: "neo4j",
      template: { name: "neo4j-docker", title: "Neo4j in Docker on this computer", scope: "user" },
      leaves: "nothing: no model calls, and the database runs on this computer.",
      url: "bolt://localhost:7687",
      host: "localhost",
      jurisdiction: "local",
      credentials: ["NEO4J_USER", "NEO4J_PASSWORD"],
      container: {
        tool: "docker",
        name: "lunos-memory-neo4j-docker-neo4j-1",
        image: "neo4j:5",
        state: "running",
        project: "lunos-memory-neo4j-docker",
      },
    }
    const text = MemoryStorage.panelText(panel, now)
    expect(text[0]).toBe("Storage   Neo4j in Docker on this computer   ● connected")
    expect(text).toContain("          bolt://localhost:7687")
    expect(text).toContain("          Container: lunos-memory-neo4j-docker-neo4j-1 (neo4j:5) · ● running")
    expect(text).toContain("          Status: connected to Neo4j 5.26 · checked 2 min ago (12 ms)")
    expect(text).toContain(
      "          Template: neo4j-docker · scope: user · encryption: n/a (on the server) · kept until removed",
    )
    const stopped = MemoryStorage.panelLines({ ...panel, container: { ...panel.container!, state: "stopped" } }, now)
    expect(stopped).toContain("Container: lunos-memory-neo4j-docker-neo4j-1 (neo4j:5) · ○ stopped")
  })

  test("a team database: host, jurisdiction, TLS and the credentials' variable names only", () => {
    const lines = MemoryStorage.panelLines(
      {
        ...base,
        place: "team",
        vendor: "postgres",
        leaves: MemoryStorage.leaves("postgres", undefined, "db.example.eu"),
        url: "postgres://db.example.eu:5432/lunos",
        host: "db.example.eu",
        jurisdiction: "EU-DE",
        tls: "verified",
        readOnly: true,
        credentials: ["POSTGRES_USER", "file ~/.pg-password"],
        status: {
          state: "unreachable",
          at: "2026-10-20T11:00:00Z",
          error: { stage: "connect", message: "ECONNREFUSED", fix: "Check the URL and port." },
        },
      },
      now,
    )
    expect(MemoryStorage.panelTitle({ ...base, place: "team", vendor: "postgres", leaves: "" })).toBe(
      "Team database: PostgreSQL",
    )
    expect(lines).toContain("Host: db.example.eu · jurisdiction EU-DE · TLS on · read-only")
    expect(lines).toContain("Credentials: from POSTGRES_USER and file ~/.pg-password (never shown)")
    expect(lines).toContain("Status: unreachable · checked 1 h ago")
    expect(lines).toContain("✗ connect: ECONNREFUSED")
    expect(lines).toContain("Fix: Check the URL and port.")
  })

  test("managed cloud: provider, region and the residency result", () => {
    const panel: MemoryStorage.Panel = {
      ...base,
      place: "cloud",
      vendor: "neo4j",
      leaves: "the fact text, to the provider, in the region you pick.",
      host: "abcd1234.databases.neo4j.io",
      jurisdiction: "EU-DE",
      tls: "verified",
      provider: MemoryStorage.cloudProvider("neo4j", "abcd1234.databases.neo4j.io"),
      residency: { allowed: false, reason: "EU-DE isn't in residency.allow" },
    }
    expect(MemoryStorage.panelTitle(panel)).toBe("Managed cloud database: Neo4j Aura")
    expect(MemoryStorage.panelLines(panel, now)).toContain(
      "Provider: Neo4j Aura · region EU-DE · residency: blocked (EU-DE isn't in residency.allow)",
    )
  })

  test("locked by the organisation, and memory off", () => {
    const locked = MemoryStorage.panelLines({ ...base, place: "embedded", leaves: "x", locked: true }, now)
    expect(locked.at(-1)).toBe("Set by your organisation")
    const off = MemoryStorage.panelText(
      {
        ...base,
        on: false,
        reason: "LUNOS_DISABLE_MEMORY is set",
        place: "embedded",
        leaves: "",
        status: { state: "off" },
      },
      now,
    )
    expect(off).toEqual([
      "Storage   Memory is off   ○ memory off",
      "          LUNOS_DISABLE_MEMORY is set. Nothing is remembered or recalled.",
    ])
  })

  test("a reference shows its name; a literal value is never shown", () => {
    expect(MemoryStorage.reference("{env:NEO4J_PASSWORD}")).toBe("NEO4J_PASSWORD")
    expect(MemoryStorage.reference("{file:~/pw}")).toBe("file ~/pw")
    expect(MemoryStorage.reference("hunter2")).toBeUndefined()
    expect(MemoryStorage.ago("2026-10-17T12:00:00Z", now)).toBe("3 days ago")
  })
})
