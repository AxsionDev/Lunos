// The Storage panel at the top of /memory's Overview, and `lunos memory status` / `storage set`.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { MemoryMove } from "../../src/memory/move"
import { MemoryStoragePanel } from "../../src/memory/storage-panel"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { cliIt } from "../lib/cli-process"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const SECRET = "s3cr3t-value-never-shown"

/** A fake `docker`: answers `ps` and `inspect` from a table, and records every call. */
function fakeDocker(containers: Record<string, { status: string; image: string }>) {
  const calls: string[][] = []
  const exec: MemoryStoragePanel.Exec = async (argv) => {
    calls.push(argv)
    if (argv[1] === "ps") return { code: 0, stdout: Object.keys(containers).join("\n") + "\n" }
    if (argv[1] === "inspect") {
      const found = containers[argv.at(-1)!]
      return found ? { code: 0, stdout: `${found.status}|${found.image}\n` } : { code: 1, stdout: "" }
    }
    if (argv[1] === "start") return { code: containers[argv[2]!] ? 0 : 1, stdout: "" }
    return { code: 1, stdout: "" }
  }
  return { exec, calls }
}

describe("container state, from docker or podman (faked)", () => {
  const project = "lunos-memory-neo4j-docker"
  const name = "lunos-memory-neo4j-docker-neo4j-1"

  test("running", async () => {
    const docker = fakeDocker({ [name]: { status: "running", image: "neo4j:5" } })
    expect(await MemoryStoragePanel.container({ tool: "docker", project, exec: docker.exec })).toEqual({
      tool: "docker",
      project,
      name,
      image: "neo4j:5",
      state: "running",
    })
    // Found by its compose project label, not by guessing the name.
    expect(docker.calls[0]).toContain(`label=com.docker.compose.project=${project}`)
  })

  test("stopped (exited), then started", async () => {
    const docker = fakeDocker({ [name]: { status: "exited", image: "neo4j:5" } })
    const box = await MemoryStoragePanel.container({ tool: "podman", project, exec: docker.exec })
    expect(box.state).toBe("stopped")
    expect(box.tool).toBe("podman")
    expect(await MemoryStoragePanel.start({ tool: "podman", name, exec: docker.exec })).toBe(true)
    expect(docker.calls.at(-1)).toEqual(["podman", "start", name])
  })

  test("missing, and no Docker at all", async () => {
    const docker = fakeDocker({})
    expect((await MemoryStoragePanel.container({ tool: "docker", project, exec: docker.exec })).state).toBe("missing")
    const none = fakeDocker({})
    expect((await MemoryStoragePanel.container({ tool: undefined, project, exec: none.exec })).state).toBe("no-docker")
    expect(none.calls).toEqual([])
  })
})

test("a URL is shown without credentials", () => {
  expect(MemoryStoragePanel.sanitize("postgres://me:pw@db.example.eu:5432/lunos")).toBe(
    "postgres://db.example.eu:5432/lunos",
  )
  expect(MemoryStoragePanel.sanitize("bolt://localhost:7687")).toBe("bolt://localhost:7687")
})

test("Move my facts: the count check fails a move that lost facts", () => {
  expect(MemoryMove.counted({ ok: true, output: "", facts: 3 }, 3).ok).toBe(true)
  // Already in the new storage (the preview's duplicates) counts as arrived.
  expect(MemoryMove.counted({ ok: true, output: "", facts: 1, already: 2 }, 3).ok).toBe(true)
  const lost = MemoryMove.counted({ ok: true, output: "", facts: 2 }, 3)
  expect(lost.ok).toBe(false)
  expect(lost.error).toContain("Only 2 of 3 fact(s)")
})

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)
const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))

describe("GET /memory/storage", () => {
  it.instance(
    "a team Neo4j: host, jurisdiction and the credentials' variable names, never their values",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      process.env.LUNOS_PANEL_TEST_PASSWORD = SECRET
      try {
        const response = yield* requestInDirectory("/memory/storage", directory)
        expect(response.status).toBe(200)
        const text = JSON.stringify(yield* response.json)
        expect(text).not.toContain(SECRET)
        const panel = JSON.parse(text)
        expect(panel).toMatchObject({
          on: false,
          place: "team",
          vendor: "neo4j",
          host: "graph.example.eu",
          jurisdiction: "EU-DE",
          tls: "verified",
          locked: false,
          credentials: ["LUNOS_PANEL_TEST_USER", "LUNOS_PANEL_TEST_PASSWORD"],
          template: { name: "team-hosted", title: "Team database we host" },
          status: { state: "off" },
        })
      } finally {
        delete process.env.LUNOS_PANEL_TEST_PASSWORD
      }
    }),
    {
      config: {
        memory: {
          template: "team-hosted",
          backend: {
            type: "neo4j",
            url: "bolt+s://graph.example.eu:7687",
            username: "{env:LUNOS_PANEL_TEST_USER}",
            password: "{env:LUNOS_PANEL_TEST_PASSWORD}",
            jurisdiction: "EU-DE",
          },
        },
      },
    },
  )

  it.instance(
    "on this computer: the memory path and its size, and Custom without a template",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const graph = path.join(directory, ".opencode", "memory", "graph")
      yield* Effect.promise(async () => {
        await fs.mkdir(graph, { recursive: true })
        await fs.writeFile(path.join(graph, "facts.jsonl"), "x".repeat(2048))
      })
      const response = yield* requestInDirectory("/memory/storage", directory)
      const panel = (yield* response.json) as Record<string, any>
      expect(panel.place).toBe("embedded")
      expect(panel.paths).toEqual([graph])
      expect(panel.bytes).toBe(2048)
      expect(panel.template).toBeUndefined()
      expect(panel.status).toEqual({ state: "off" })
    }),
  )
})

describe("lunos memory status / storage set (subprocess)", () => {
  const team = {
    memory: {
      enabled: true,
      template: "team-hosted",
      backend: {
        type: "neo4j",
        url: "bolt+s://127.0.0.1:9",
        username: "{env:NEO4J_USER}",
        password: "{env:NEO4J_PASSWORD}",
        jurisdiction: "EU-DE",
      },
      encryption: "off",
    },
  }
  const env = { NEO4J_USER: "neo4j", NEO4J_PASSWORD: SECRET, LUNOS_DISABLE_MEMORY: "1" }
  // The harness turns project config off: this is the user config.
  const userConfig = (home: string) => path.join(home, ".config", "opencode", "opencode.json")
  const writeConfig = (home: string) =>
    Effect.promise(async () => {
      await fs.mkdir(path.dirname(userConfig(home)), { recursive: true })
      await fs.writeFile(userConfig(home), JSON.stringify(team))
    })

  cliIt.live("status prints the Storage block, with variable names and never the password", ({ opencode, home }) =>
    Effect.gen(function* () {
      yield* writeConfig(home)
      const result = yield* opencode.spawn(["memory", "status"], { env })
      opencode.expectExit(result, 0, "status")
      expect(result.stdout).toContain("Storage   Memory is off   ○ memory off")
      expect(result.stdout).not.toContain(SECRET)
      // With memory on, the block names the storage, its template and where the credentials come from.
      const on = yield* opencode.spawn(["memory", "status"], { env: { ...env, LUNOS_DISABLE_MEMORY: "" } })
      expect(on.stdout).toContain("Storage   Team database: Neo4j   ✗ unreachable")
      expect(on.stdout).toContain("Host: 127.0.0.1 · jurisdiction EU-DE · TLS on")
      expect(on.stdout).toContain("Credentials: from NEO4J_USER and NEO4J_PASSWORD (never shown)")
      expect(on.stdout).toContain("Template: team-hosted")
      expect(on.stdout + on.stderr).not.toContain(SECRET)
    }),
  )

  cliIt.live(
    "storage set: switching needs --move or --empty with --yes; --empty leaves the old one",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* writeConfig(home)
        const refused = yield* opencode.spawn(["memory", "storage", "set", "--backend", "embedded", "--yes"], { env })
        expect(refused.exitCode).not.toBe(0)
        expect(refused.stderr + refused.stdout).toContain("add --move")
        const empty = yield* opencode.spawn(
          ["memory", "storage", "set", "--backend", "embedded", "--empty", "--yes", "--no-check"],
          { env },
        )
        opencode.expectExit(empty, 0, "storage set --empty")
        expect(empty.stdout).toContain(
          "Start empty: the new storage starts with no facts; the old ones stay, untouched, in Team database: Neo4j at 127.0.0.1:9.",
        )
        const saved = yield* Effect.promise(() => fs.readFile(userConfig(home), "utf8"))
        expect(saved).toContain('"embedded"')
        // Chosen by hand: the template is no longer recorded.
        expect(saved).not.toContain("team-hosted")
      }),
  )
})
