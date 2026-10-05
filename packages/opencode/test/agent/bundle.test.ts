import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter, BlobWriter } from "@zip.js/zip.js"
import { Schema } from "effect"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { AgentBundle } from "@/agent/bundle"
import { AgentImport } from "@/agent/import"
import { ConfigAgent } from "@/config/agent"
import { Permission } from "@/permission"

// XCOD-209 (slice (a) of XCOD-203): export and import an agent as a portable bundle.

const text = (value: string) => new TextEncoder().encode(value)
const agent = (raw: Record<string, unknown>) => Schema.decodeUnknownSync(ConfigAgentV1.Info)(raw)
const SECRET = "sk-live-0123456789abcdef"
const HEADER_SECRET = "Bearer hdr-9876543210"

async function entries(bytes: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes))
  const out: Record<string, string> = {}
  for (const entry of await reader.getEntries())
    if (!entry.directory) out[entry.filename] = new TextDecoder().decode(await entry.getData!(new Uint8ArrayWriter()))
  await reader.close()
  return out
}

/** A bundle built by hand, for the cases export would never produce. */
async function craft(
  files: Record<string, string>,
  options: { manifest?: Record<string, unknown>; attributes?: Record<string, number>; checksums?: boolean } = {},
) {
  const sums = Object.fromEntries(
    Object.entries(files).map(([file, body]) => [file, crypto.createHash("sha256").update(body).digest("hex")]),
  )
  const manifest = {
    format: AgentBundle.FORMAT,
    name: "crafted",
    mcp: [],
    skills: [],
    files: options.checksums === false ? {} : sums,
    ...options.manifest,
  }
  const zip = new ZipWriter(new BlobWriter("application/zip"))
  await zip.add("manifest.json", new Uint8ArrayReader(text(JSON.stringify(manifest))))
  for (const [file, body] of Object.entries(files))
    await zip.add(file, new Uint8ArrayReader(text(body)), {
      ...(options.attributes?.[file] !== undefined ? { externalFileAttributes: options.attributes[file] } : {}),
    })
  return new Uint8Array(await (await zip.close()).arrayBuffer())
}

const minimalAgent = JSON.stringify({ description: "d", prompt: "p" })

describe("AgentBundle export (AC2: no secrets)", () => {
  test("round-trips an agent, its MCP servers and skills, with no secret value anywhere in the bundle", async () => {
    const bytes = await AgentBundle.write({
      name: "reviewer",
      agent: agent({
        description: "Reviews code",
        prompt: "Review it.",
        model: "mistral/mistral-large-latest",
        permission: { bash: "allow" },
        steps: 12,
      }),
      mcp: {
        github: { type: "local", command: ["npx", "-y", "gh-mcp"], environment: { GITHUB_TOKEN: SECRET } },
        docs: { type: "remote", url: "https://docs.example.com/mcp", headers: { Authorization: HEADER_SECRET } },
      },
      skills: {
        "code-review": {
          "SKILL.md": text("---\nname: code-review\ndescription: d\n---\nbody"),
          "ref/notes.md": text("notes"),
        },
      },
      lunos: "1.18.45",
    })

    // Grep the decompressed entries: the zip itself is deflated, so a raw grep would always pass.
    const files = await entries(bytes)
    const all = Object.values(files).join("\n")
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain("hdr-9876543210")
    expect(Object.keys(files).sort()).toEqual([
      "agent.json",
      "manifest.json",
      "skills/code-review/SKILL.md",
      "skills/code-review/ref/notes.md",
    ])

    const bundle = await AgentBundle.read(bytes)
    expect(bundle.manifest.name).toBe("reviewer")
    expect(bundle.manifest.mcp).toEqual([
      expect.objectContaining({
        name: "github",
        type: "local",
        command: ["npx", "-y", "gh-mcp"],
        environment: ["GITHUB_TOKEN"],
      }),
      expect.objectContaining({
        name: "docs",
        type: "remote",
        url: "https://docs.example.com/mcp",
        headers: ["Authorization"],
      }),
    ])
    expect(bundle.agent).toMatchObject({
      description: "Reviews code",
      model: "mistral/mistral-large-latest",
      steps: 12,
    })
    expect(Object.keys(bundle.skills["code-review"]).sort()).toEqual(["SKILL.md", "ref/notes.md"])
  })

  test("a secret that can't become a name is refused, naming where it is", async () => {
    const base = { name: "a", agent: agent({ prompt: "p" }), skills: {} }
    await expect(
      AgentBundle.write({ ...base, mcp: { s: { type: "remote", url: "https://x.example/mcp?api_key=abc" } } }),
    ).rejects.toThrow(/api_key/)
    await expect(
      AgentBundle.write({ ...base, mcp: { s: { type: "remote", url: "https://user:pw@x.example/mcp" } } }),
    ).rejects.toThrow(/credentials in its URL/)
    await expect(
      AgentBundle.write({
        ...base,
        mcp: { s: { type: "remote", url: "https://x.example/mcp", oauth: { clientSecret: "shh" } } },
      }),
    ).rejects.toThrow(/client secret/)
    await expect(
      AgentBundle.write({ ...base, agent: agent({ prompt: "p", options: { apiKey: "k" } }), mcp: {} }),
    ).rejects.toThrow(/options.apiKey/)
    await expect(
      AgentBundle.write({ ...base, agent: agent({ prompt: "p", options: { baseURL: "https://elsewhere" } }), mcp: {} }),
    ).rejects.toThrow(/options.baseURL/)
    // The token dropped from env is still in a command argument.
    await expect(
      AgentBundle.write({
        ...base,
        mcp: { s: { type: "local", command: ["srv", `--token=${SECRET}`], environment: { TOKEN: SECRET } } },
      }),
    ).rejects.toThrow(/also appears in mcp\[0\]\.command\[1\]/)
  })

  test("an {env:NAME} reference isn't a secret; a substitution token elsewhere is refused on export", async () => {
    const bytes = await AgentBundle.write({
      name: "a",
      agent: agent({ prompt: "p" }),
      mcp: { s: { type: "local", command: ["srv"], environment: { GITHUB_TOKEN: "{env:GITHUB_TOKEN}" } } },
      skills: {},
    })
    expect((await AgentBundle.read(bytes)).manifest.mcp[0]).toMatchObject({ environment: ["GITHUB_TOKEN"] })
    await expect(
      AgentBundle.write({ name: "a", agent: agent({ prompt: "read {file:~/.ssh/id_rsa}" }), mcp: {}, skills: {} }),
    ).rejects.toThrow(/can't be exported.*agent\.prompt/)
  })

  test("credential options are refused at any depth", async () => {
    await expect(
      AgentBundle.write({
        name: "a",
        agent: agent({ prompt: "p", options: { provider: { headers: { x: "y" } } } }),
        mcp: {},
        skills: {},
      }),
    ).rejects.toThrow(/options\.provider\.headers/)
  })
})

describe("AgentBundle import hardening", () => {
  test("paths that leave the bundle are refused", async () => {
    for (const bad of ["../evil.md", "skills/x/../../evil", "/etc/passwd", "C:/evil", "skills\\x\\evil"])
      await expect(AgentBundle.read(await craft({ "agent.json": minimalAgent, [bad]: "x" }))).rejects.toThrow(
        /unsafe path/,
      )
  })

  test("symbolic links, unlisted files, bad checksums and missing files are refused", async () => {
    const link = await craft(
      { "agent.json": minimalAgent, "skills/s/SKILL.md": "x" },
      { manifest: { skills: ["s"] }, attributes: { "skills/s/SKILL.md": (0o120777 << 16) >>> 0 } },
    )
    await expect(AgentBundle.read(link)).rejects.toThrow(/symbolic link/)
    await expect(AgentBundle.read(await craft({ "agent.json": minimalAgent }, { checksums: false }))).rejects.toThrow(
      /manifest doesn't list/,
    )
    await expect(
      AgentBundle.read(
        await craft({ "agent.json": minimalAgent }, { manifest: { files: { "agent.json": "0".repeat(64) } } }),
      ),
    ).rejects.toThrow(/checksum/)
    await expect(
      AgentBundle.read(
        await craft(
          { "agent.json": minimalAgent },
          {
            manifest: {
              files: {
                "agent.json": crypto.createHash("sha256").update(minimalAgent).digest("hex"),
                "gone.md": "a".repeat(64),
              },
            },
          },
        ),
      ),
    ).rejects.toThrow(/missing "gone.md"/)
  })

  test("hooks, unknown manifest fields, unknown agent fields and other formats are refused", async () => {
    await expect(
      AgentBundle.read(await craft({ "agent.json": minimalAgent }, { manifest: { hooks: [] } })),
    ).rejects.toThrow(/hooks/)
    await expect(
      AgentBundle.read(await craft({ "agent.json": minimalAgent }, { manifest: { extra: 1 } })),
    ).rejects.toThrow(/doesn't know: "extra"/)
    await expect(
      AgentBundle.read(await craft({ "agent.json": JSON.stringify({ prompt: "p", tools: { bash: true } }) })),
    ).rejects.toThrow(/can't carry: "tools"/)
    await expect(
      AgentBundle.read(await craft({ "agent.json": minimalAgent }, { manifest: { format: "lunos-agent/9" } })),
    ).rejects.toThrow(/lunos-agent\/9/)
    await expect(AgentBundle.read(text("not a zip"))).rejects.toThrow(/not a zip/)
  })

  test("substitution tokens anywhere in the bundle are refused", async () => {
    await expect(
      AgentBundle.read(await craft({ "agent.json": JSON.stringify({ prompt: "read {file:~/.ssh/id_rsa}" }) })),
    ).rejects.toThrow(/substitution token.*agent\.prompt/)
    await expect(
      AgentBundle.read(
        await craft(
          { "agent.json": minimalAgent, "skills/s/SKILL.md": "---\nname: s\n---\n{env:AWS_SECRET_ACCESS_KEY}" },
          { manifest: { skills: ["s"] } },
        ),
      ),
    ).rejects.toThrow(/skills\/s\/SKILL\.md/)
  })

  test("endpoint and credential options are refused on import too", async () => {
    await expect(
      AgentBundle.read(
        await craft({ "agent.json": JSON.stringify({ prompt: "p", options: { baseURL: "https://x" } }) }),
      ),
    ).rejects.toThrow(/options.baseURL/)
  })

  test("an entry that understates its size is stopped at the real limit, not inflated whole", async () => {
    const zip = new ZipWriter(new BlobWriter("application/zip"))
    const big = new Uint8Array(AgentBundle.LIMITS.file + 1024)
    await zip.add("agent.json", new Uint8ArrayReader(big))
    const bytes = new Uint8Array(await (await zip.close()).arrayBuffer())
    // Patch the central directory's uncompressed size (offset 24 from its signature) down to 10.
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < bytes.length - 4; i++)
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 10, true)
    await expect(AgentBundle.read(bytes)).rejects.toThrow(/too large/)
  })

  test("too many files is refused before anything is unpacked", async () => {
    const files: Record<string, string> = { "agent.json": minimalAgent }
    for (let i = 0; i <= AgentBundle.LIMITS.files; i++) files[`skills/s/f${i}`] = "x"
    await expect(AgentBundle.read(await craft(files, { manifest: { skills: ["s"] } }))).rejects.toThrow(/more than/)
  })
})

describe("AgentBundle.untrusted", () => {
  // Checked by evaluating the result the way the runtime does, not by its shape: rules match
  // last-wins, and both the permission name and the pattern can be wildcards.
  const PATTERNS = ["*", "rm -rf /", "git push", "src/index.ts", "general"]
  const decide = (permission: unknown, tool: string, pattern: string) =>
    Permission.evaluate(tool, pattern, Permission.fromConfig(permission as never)).action

  const bypasses: [string, unknown][] = [
    ["a bare allow", "allow"],
    ["a wildcard allow", { "*": "allow" }],
    ["a wildcard after a narrower rule", { "*": "allow", bash: { "git *": "allow" } }],
    ["a wildcard permission name", { "b*": "allow", "?dit": "allow", "t*": "allow" }],
    ["a wildcard object", { "*": { "*": "allow" } }],
    ["direct allows", { bash: "allow", edit: { "src/*": "allow" }, task: { "*": "allow" } }],
  ]
  for (const [label, input] of bypasses)
    test(`${label}: bash, edit and task are never allowed`, () => {
      const { permission } = AgentBundle.untrusted(input)
      for (const tool of AgentBundle.UNTRUSTED)
        for (const pattern of PATTERNS)
          expect([tool, pattern, decide(permission, tool, pattern)]).not.toContainEqual("allow")
    })

  test("denies stay denied, other permissions are untouched, and the changed ones are reported", () => {
    const input = { "*": "allow", read: "allow", bash: { "rm *": "deny" }, edit: "deny" }
    const { permission, changed } = AgentBundle.untrusted(input)
    expect(decide(permission, "bash", "rm -rf /")).toBe("deny")
    expect(decide(permission, "bash", "ls")).toBe("ask")
    expect(decide(permission, "edit", "src/index.ts")).toBe("deny")
    expect(decide(permission, "read", "src/index.ts")).toBe("allow")
    expect(decide(permission, "webfetch", "https://x")).toBe("allow")
    expect(changed).toEqual(["bash", "edit", "task"])
  })

  test("a bundle that allows none of them is left as it is", () => {
    const input = { read: "allow", bash: "deny" }
    expect(AgentBundle.untrusted(input)).toEqual({ permission: input, changed: [] })
  })
})

describe("AgentImport", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "xcod-209-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const ctx = (overrides: Partial<AgentImport.Context> = {}): AgentImport.Context => ({
    config: {},
    target: {
      agents: path.join(dir, "agents"),
      skills: path.join(dir, "skills"),
      config: path.join(dir, "opencode.json"),
    },
    configMcp: {},
    existing: { agents: [], skills: [] },
    env: {},
    trust: false,
    ...overrides,
  })

  const sample = () =>
    AgentBundle.write({
      name: "reviewer",
      agent: agent({
        description: "Reviews code",
        prompt: "Review it.",
        model: "openai/gpt-5",
        permission: { bash: "allow" },
      }),
      mcp: { github: { type: "local", command: ["npx", "-y", "gh-mcp"], environment: { GITHUB_TOKEN: SECRET } } },
      skills: { "code-review": { "SKILL.md": text("---\nname: code-review\ndescription: Reviews\n---\nbody") } },
    }).then(AgentBundle.read)

  test("the preview shows permissions, MCP servers, residency and unset variables; building it writes nothing (AC3)", async () => {
    const plan = await AgentImport.plan(await sample(), ctx())
    const preview = plan.preview.join("\n")
    expect(preview).toContain("bash changed from allow to ask")
    expect(preview).toContain("MCP server github: runs npx -y gh-mcp; needs $GITHUB_TOKEN")
    expect(preview).toContain("start for every agent and session")
    expect(preview).toContain("model: openai/gpt-5 (provider openai, region us")
    expect(preview).toContain("skill code-review: 1 file(s)")
    expect(plan.unset).toEqual(["GITHUB_TOKEN"])
    // Planning (and cancelling at the prompt) leaves the disk untouched.
    expect(await fs.readdir(dir)).toEqual([])
  })

  test("apply writes the agent, its skill and {env:NAME} references, and the agent loads", async () => {
    const plan = await AgentImport.plan(await sample(), ctx({ env: { GITHUB_TOKEN: "set" } }))
    expect(plan.unset).toEqual([])
    await plan.apply()
    const config = JSON.parse(await fs.readFile(path.join(dir, "opencode.json"), "utf8"))
    expect(config.mcp.github).toEqual({
      type: "local",
      command: ["npx", "-y", "gh-mcp"],
      enabled: true,
      environment: { GITHUB_TOKEN: "{env:GITHUB_TOKEN}" },
    })
    expect(await fs.readFile(path.join(dir, "skills", "code-review", "SKILL.md"), "utf8")).toContain(
      "name: code-review",
    )
    const loaded = await ConfigAgent.load(dir)
    expect(loaded.reviewer).toMatchObject({ description: "Reviews code", model: "openai/gpt-5", prompt: "Review it." })
    expect(loaded.reviewer.permission).toMatchObject({ bash: { "*": "ask" } })
  })

  test("--trust keeps the bundled permissions", async () => {
    const plan = await AgentImport.plan(await sample(), ctx({ trust: true }))
    await plan.apply()
    expect((await ConfigAgent.load(dir)).reviewer.permission).toMatchObject({ bash: "allow" })
  })

  test("an EU-only policy refuses an agent whose model runs outside the EU (AC6)", async () => {
    await expect(AgentImport.plan(await sample(), ctx({ config: { residency: { allow: ["eu"] } } }))).rejects.toThrow(
      /region "us".*allows only eu/,
    )
    const eu = await AgentBundle.read(
      await AgentBundle.write({
        name: "eu",
        agent: agent({ prompt: "p", model: "mistral/mistral-large-latest" }),
        mcp: {},
        skills: {},
      }),
    )
    const plan = await AgentImport.plan(eu, ctx({ config: { residency: { allow: ["eu"] } } }))
    expect(plan.preview.join("\n")).toContain("region eu")
  })

  test("a bundle can't take a built-in agent's name, hidden ones included", async () => {
    for (const name of ["build", "compaction", "title"]) {
      const bundle = await AgentBundle.read(
        await AgentBundle.write({ name, agent: agent({ prompt: "p" }), mcp: {}, skills: {} }),
      )
      await expect(
        AgentImport.plan(bundle, ctx({ existing: { agents: ["build", "plan", "compaction", "title"], skills: [] } })),
      ).rejects.toThrow(`An agent named "${name}" already exists`)
    }
  })

  test("a skill must call itself by its bundled name, and can't shadow one that exists elsewhere", async () => {
    const mismatched = await AgentBundle.read(
      await AgentBundle.write({
        name: "a",
        agent: agent({ prompt: "p" }),
        mcp: {},
        skills: { shown: { "SKILL.md": text("---\nname: actually-other\ndescription: d\n---\n") } },
      }),
    )
    await expect(AgentImport.plan(mismatched, ctx())).rejects.toThrow(/calls itself "actually-other"/)
    await expect(
      AgentImport.plan(await sample(), ctx({ existing: { agents: [], skills: ["code-review"] } })),
    ).rejects.toThrow(/skill named "code-review" already exists/)
  })

  test("the preview shows the agent's mode, and when it's hidden", async () => {
    const hidden = await AgentBundle.read(
      await AgentBundle.write({
        name: "h",
        agent: agent({ prompt: "p", mode: "subagent", hidden: true }),
        mcp: {},
        skills: {},
      }),
    )
    expect((await AgentImport.plan(hidden, ctx())).preview).toContain(
      "mode: subagent, hidden from the @ menu (other agents can still start it)",
    )
  })

  test("existing agents, MCP servers and skills are never overwritten", async () => {
    const bundle = await sample()
    await expect(AgentImport.plan(bundle, ctx({ config: { agent: { reviewer: {} } } }))).rejects.toThrow(/--name/)
    await expect(
      AgentImport.plan(bundle, ctx({ configMcp: { github: { type: "remote", url: "https://other" } } })),
    ).rejects.toThrow(/configured as a different server/)
    // The same server with its own credentials is kept, and its variables aren't reported as unset.
    const kept = await AgentImport.plan(
      bundle,
      ctx({
        configMcp: {
          github: { type: "local", command: ["npx", "-y", "gh-mcp"], environment: { GITHUB_TOKEN: "literal" } },
        },
      }),
    )
    expect(kept.preview.join("\n")).toContain("already configured here, kept as is")
    expect(kept.unset).toEqual([])
    await fs.mkdir(path.join(dir, "skills", "code-review"), { recursive: true })
    await expect(AgentImport.plan(bundle, ctx())).rejects.toThrow(/skill named "code-review" already exists/)
    // --name avoids the agent clash.
    await fs.rm(path.join(dir, "skills"), { recursive: true })
    const renamed = await AgentImport.plan(bundle, ctx({ config: { agent: { reviewer: {} } }, rename: "reviewer-2" }))
    expect(renamed.name).toBe("reviewer-2")
  })

  test("a failed write leaves nothing behind", async () => {
    const bundle = await sample()
    const plan = await AgentImport.plan(
      bundle,
      ctx({
        target: {
          agents: path.join(dir, "agents"),
          skills: path.join(dir, "skills"),
          config: path.join(dir, "missing-dir", "nested", "opencode.json"),
        },
      }),
    )
    // The config file's directory is replaced by a file, so the config write fails after the
    // skill and agent files were created.
    await fs.writeFile(path.join(dir, "missing-dir"), "not a directory")
    await expect(plan.apply()).rejects.toThrow()
    expect((await fs.readdir(dir)).sort()).toEqual(["missing-dir"])
  })

  test("a Claude Code subagent file imports with a report of mapped and unmapped fields (AC4)", async () => {
    const file = path.join(dir, "helper.md")
    await fs.writeFile(
      file,
      "---\nname: helper\ndescription: Helps\ntools: Read, Grep, mcp__github__search\nmodel: sonnet\ncolor: cyan\npermissionMode: plan\n---\nYou help.\n",
    )
    const { bundle, mapped, unmapped } = await AgentImport.fromClaudeFile(file)
    expect(mapped.sort()).toEqual(["description", "name", "tools"])
    expect(unmapped).toEqual([
      'model ("sonnet": no Lunos equivalent, left unset)',
      'color ("cyan": no Lunos equivalent, left unset)',
      "permissionMode",
      "tools: mcp__github__search (Claude Code MCP tool name; Lunos names MCP tools <server>_<tool>)",
    ])
    expect(bundle.agent).toMatchObject({
      prompt: "You help.",
      permission: { "*": "deny", read: "allow", grep: "allow" },
    })
    expect(bundle.agent.model).toBeUndefined()
  })
})
