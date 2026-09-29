// XCOD-132: `lunos memory export` through the real CLI. The markdown format must stay byte-for-byte
// what XCOD-94 wrote; the bundle is the new default.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import Ajv2020 from "ajv/dist/2020"
import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js"
import { MemoryBundle } from "../../src/memory/bundle"
import { cliIt } from "../lib/cli-process"

const project = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    datasetID: "d-project",
    text: "The billing service owns the invoices table.",
    provenance: { sessionID: "ses_a", agent: "build", source: "user message", date: "2026-09-26T10:00:00.000Z" },
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    datasetID: "d-project",
    text: "Deploys go out on Tuesdays.\nNever on Fridays.",
    provenance: {
      sessionID: "ses_b",
      agent: "plan",
      source: 'docs/"release" notes.md',
      date: "2026-09-27T11:00:00.000Z",
    },
  },
]
const user = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    datasetID: "d-user",
    text: "Prefers tabs over spaces.",
    provenance: { sessionID: "ses_c", agent: "build", source: "user message", date: "2026-09-28T12:00:00.000Z" },
  },
]

const jsonl = (facts: object[]) => facts.map((fact) => JSON.stringify(fact) + "\n").join("")

async function seed(home: string) {
  const projectRoot = path.join(home, ".opencode", "memory", "graph")
  const userRoot = path.join(home, ".local", "share", "opencode", "memory", "user")
  await fs.mkdir(projectRoot, { recursive: true })
  await fs.mkdir(userRoot, { recursive: true })
  await fs.writeFile(path.join(projectRoot, "facts.jsonl"), jsonl(project))
  await fs.writeFile(path.join(userRoot, "facts.jsonl"), jsonl(user))
}

async function unzip(bytes: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)))
  const out: Record<string, string> = {}
  for (const entry of await reader.getEntries()) out[entry.filename] = await entry.getData!(new TextWriter())
  await reader.close()
  return out
}

async function tree(dir: string) {
  const out: Record<string, string> = {}
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    out[path.relative(dir, file).split(path.sep).join("/")] = await fs.readFile(file, "utf8")
  }
  return out
}

describe("lunos memory export (subprocess)", () => {
  cliIt.live("--format markdown writes exactly what XCOD-94 wrote", ({ opencode, home }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seed(home))
      const out = path.join(home, "md")
      const result = yield* opencode.spawn(["memory", "export", "--format", "markdown", "--dir", out])
      opencode.expectExit(result, 0, "export")
      expect(result.stdout).toBe(`Wrote 3 fact(s) to ${out}\n`)
      expect(yield* Effect.promise(() => tree(out))).toEqual({
        "project/11111111-1111-4111-8111-111111111111.md": [
          "---",
          "id: 11111111-1111-4111-8111-111111111111",
          "scope: project",
          "date: 2026-09-26T10:00:00.000Z",
          'source: "user message"',
          "session: ses_a",
          "agent: build",
          "---",
          "",
          "The billing service owns the invoices table.",
          "",
        ].join("\n"),
        "project/22222222-2222-4222-8222-222222222222.md": [
          "---",
          "id: 22222222-2222-4222-8222-222222222222",
          "scope: project",
          "date: 2026-09-27T11:00:00.000Z",
          'source: "docs/\\"release\\" notes.md"',
          "session: ses_b",
          "agent: plan",
          "---",
          "",
          "Deploys go out on Tuesdays.\nNever on Fridays.",
          "",
        ].join("\n"),
        "user/33333333-3333-4333-8333-333333333333.md": [
          "---",
          "id: 33333333-3333-4333-8333-333333333333",
          "scope: user",
          "date: 2026-09-28T12:00:00.000Z",
          'source: "user message"',
          "session: ses_c",
          "agent: build",
          "---",
          "",
          "Prefers tabs over spaces.",
          "",
        ].join("\n"),
      })
    }),
  )

  cliIt.live(
    "the default is a bundle; every sha256 verifies and it validates against the schema in SCHEMA.md",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seed(home))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(home, ".opencode", "memory", "team.md"), "# Team\n\nWe deploy on Tuesdays.\n"),
        )
        const out = path.join(home, "bundle")
        const result = yield* opencode.spawn(["memory", "export", "--no-graph", "--out", out])
        opencode.expectExit(result, 0, "export")
        expect(result.stdout).toContain(
          `Exported 3 fact(s) (2 project, 1 user), 1 note file(s), 0 entities and 0 relationships to ${out}`,
        )
        expect(result.stdout).toContain("The graph was not included: left out with --no-graph.")
        const files = yield* Effect.promise(() => tree(out))
        expect(Object.keys(files).toSorted()).toEqual([
          "SCHEMA.md",
          "facts.jsonl",
          "graph.json",
          "manifest.json",
          "notes/team.md",
        ])
        const manifest = JSON.parse(files["manifest.json"])
        expect(manifest).toMatchObject({
          format: "lunos-memory/1",
          scopes: ["project", "user"],
          filters: { since: null },
          counts: { facts: { total: 3, project: 2, user: 1, fromNotes: 0 }, notes: 1, entities: 0, relations: 0 },
          graph: { included: false, reason: "left out with --no-graph" },
          index: { included: false },
        })
        expect(manifest.files.map((file: { path: string }) => file.path).toSorted()).toEqual(
          Object.keys(files)
            .filter((file) => file !== "manifest.json")
            .toSorted(),
        )
        for (const file of manifest.files) {
          const bytes = yield* Effect.promise(() => fs.readFile(path.join(out, file.path)))
          expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(file.sha256)
          expect(bytes.byteLength).toBe(file.bytes)
        }
        expect(files["notes/team.md"]).toBe("# Team\n\nWe deploy on Tuesdays.\n")

        const facts = files["facts.jsonl"]
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(facts[0]).toEqual({
          id: project[0].id,
          scope: "project",
          text: project[0].text,
          status: "active",
          kind: null,
          provenance: project[0].provenance,
          engine: { name: "cognee", datasetID: "d-project" },
        })
        expect(facts.map((fact) => fact.scope)).toEqual(["project", "project", "user"])

        // The schema a third-party tool would use: the one published in the bundle's own SCHEMA.md.
        const published = JSON.parse(files["SCHEMA.md"].match(/```json\n([\s\S]*?)\n```/)![1])
        const ajv = new Ajv2020({ strict: false, validateFormats: false })
        ajv.addSchema(published)
        const check = (def: string, value: unknown) => {
          const valid = ajv.validate(`${published.$id}#/$defs/${def}`, value)
          if (!valid) throw new Error(`${def}: ${ajv.errorsText()}`)
        }
        check("manifest", manifest)
        for (const fact of facts) check("fact", fact)
        check("graph", JSON.parse(files["graph.json"]))
        // And it isn't a schema that accepts anything.
        expect(ajv.validate(`${published.$id}#/$defs/fact`, { ...facts[0], status: "gone" })).toBe(false)
      }),
  )

  cliIt.live("--scope, --since and --zip", ({ opencode, home }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seed(home))
      const out = path.join(home, "project.zip")
      const result = yield* opencode.spawn([
        "memory",
        "export",
        "--no-graph",
        "--scope",
        "project",
        "--since",
        "2026-09-27",
        "--zip",
        "--out",
        out,
      ])
      opencode.expectExit(result, 0, "export")
      const bytes = yield* Effect.promise(() => fs.readFile(out))
      expect(bytes.subarray(0, 2).toString()).toBe("PK")
      const unzipped = yield* Effect.promise(() => unzip(bytes))
      const manifest = JSON.parse(unzipped["manifest.json"])
      expect(manifest.scopes).toEqual(["project"])
      expect(manifest.filters.since).toBe("2026-09-27T00:00:00.000Z")
      expect(manifest.counts.facts).toEqual({ total: 1, project: 1, user: 0, fromNotes: 0 })
      const facts = unzipped["facts.jsonl"]
      expect(facts).toContain(project[1].id)
      expect(facts).not.toContain(project[0].id)

      const bad = yield* opencode.spawn(["memory", "export", "--since", "last week", "--no-graph"])
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stderr).toContain("--since must be a date")
    }),
  )

  cliIt.live(
    "--encrypt: unreadable without the passphrase, and the documented openssl command decrypts it",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seed(home))
        const out = path.join(home, "memory.zip.enc")
        const passphrase = "correct horse battery staple"
        const result = yield* opencode.spawn(["memory", "export", "--no-graph", "--encrypt", "--out", out], {
          env: { LUNOS_MEMORY_PASSPHRASE: passphrase },
        })
        opencode.expectExit(result, 0, "export")
        expect(result.stdout).toContain(`Decrypt with: ${MemoryBundle.decryptCommand("memory.zip.enc")}`)
        expect(result.stdout + result.stderr).not.toContain(passphrase)
        const bytes = yield* Effect.promise(() => fs.readFile(out))
        expect(bytes.subarray(0, 8).toString()).toBe("Salted__")
        for (const plain of ["billing", "facts.jsonl", "manifest", "PK"]) expect(bytes.includes(plain)).toBe(false)
        expect(() => MemoryBundle.decrypt(bytes, "wrong passphrase")).toThrow()
        if (!Bun.which("openssl")) return
        const zip = path.join(home, "memory.zip")
        const [command, ...rest] = MemoryBundle.decryptCommand(out, zip).split(" ")
        // A wrong passphrase fails CBC's padding check, or (about 1 in 256) yields garbage, never the zip.
        const wrong = Bun.spawnSync([command, ...rest, "-pass", "pass:wrong passphrase"])
        if (wrong.exitCode === 0)
          expect((yield* Effect.promise(() => fs.readFile(zip))).subarray(0, 2).toString()).not.toBe("PK")
        const ok = Bun.spawnSync([command, ...rest, "-pass", `pass:${passphrase}`])
        expect(ok.exitCode).toBe(0)
        const files = yield* Effect.promise(async () => unzip(await fs.readFile(zip)))
        expect(files["facts.jsonl"]).toContain("The billing service owns the invoices table.")
        expect(JSON.parse(files["manifest.json"]).counts.facts.total).toBe(3)
      }),
  )

  cliIt.live(
    "a fact that looks like a secret stops the export, which names it and writes nothing",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seed(home))
        // Written straight into the ledger, past the write guard, as if an older version had let it in.
        yield* Effect.promise(() =>
          fs.appendFile(
            path.join(home, ".opencode", "memory", "graph", "facts.jsonl"),
            JSON.stringify({
              id: "44444444-4444-4444-8444-444444444444",
              datasetID: "d-project",
              text: "The deploy token is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
              provenance: {
                sessionID: "ses_d",
                agent: "build",
                source: "user message",
                date: "2026-09-28T00:00:00.000Z",
              },
            }) + "\n",
          ),
        )
        const out = path.join(home, "bundle")
        const result = yield* opencode.spawn(["memory", "export", "--no-graph", "--out", out])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Nothing was exported")
        expect(result.stderr).toContain("44444444-4444-4444-8444-444444444444")
        expect(result.stderr).not.toContain("sk-ant-api03")
        expect((yield* Effect.promise(() => fs.readdir(home))).filter((name) => name.startsWith("bundle"))).toEqual([])
      }),
  )

  cliIt.live(
    "with memory off, the graph can't be read: the export says so and names --no-graph",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seed(home))
        const result = yield* opencode.spawn(["memory", "export", "--out", path.join(home, "bundle")])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Could not read the project memory graph: Memory is off")
        expect(result.stderr).toContain("--no-graph")
        // Off means off: no sidecar was installed to find that out.
        expect(
          yield* Effect.promise(() =>
            fs.stat(path.join(home, ".local", "share", "opencode", "memory", "sidecar")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
  )

  cliIt.live(
    "--include-index copies the engine's files and records its versions; it refuses --since",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seed(home))
        const graph = path.join(home, ".opencode", "memory", "graph")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(graph, "system", "databases"), { recursive: true })
          await fs.mkdir(path.join(graph, "logs"), { recursive: true })
          await fs.writeFile(path.join(graph, "system", "databases", "graph.db"), "engine bytes")
          await fs.writeFile(path.join(graph, "logs", "cognee.log"), "log line")
        })
        const out = path.join(home, "with-index")
        const result = yield* opencode.spawn(["memory", "export", "--no-graph", "--include-index", "--out", out])
        opencode.expectExit(result, 0, "export")
        const files = yield* Effect.promise(() => tree(out))
        expect(Object.keys(files).filter((file) => file.startsWith("index/"))).toEqual([
          "index/project/system/databases/graph.db",
        ])
        expect(JSON.parse(files["manifest.json"]).index).toEqual({
          included: true,
          engine: "cognee",
          engineVersion: "1.6.1",
          embedding: { model: "sentence-transformers/all-MiniLM-L6-v2", dimensions: 384 },
          scopes: ["project"],
        })

        const both = yield* opencode.spawn([
          "memory",
          "export",
          "--no-graph",
          "--include-index",
          "--since",
          "2026-09-01",
        ])
        expect(both.exitCode).not.toBe(0)
        expect(both.stderr).toContain("--since can't be combined with --include-index")

        const dir = yield* opencode.spawn(["memory", "export", "--no-graph", "--dir", path.join(home, "x")])
        expect(dir.exitCode).not.toBe(0)
        expect(dir.stderr).toContain("--dir is for --format markdown")
      }),
  )
})
