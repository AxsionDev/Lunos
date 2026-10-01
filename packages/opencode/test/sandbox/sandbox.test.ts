import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Config } from "@opencode-ai/core/config"
import { Global } from "@opencode-ai/core/global"
import { SandboxConfig } from "../../src/sandbox/config"
import { SandboxDocker } from "../../src/sandbox/docker"
import { SandboxGit } from "../../src/sandbox/git"
import { Sandbox } from "../../src/sandbox"
import { tmpdir } from "../fixture/fixture"

// XCOD-144 slice 1. The docker-driven lifecycle is verified with real runs (see the PR); these cover
// the parts that don't need a Docker daemon: config, the isolation flags, copy mode and the handoff.

const sandbox = {
  enabled: true,
  image: "lunos-sandbox:local",
  workspace: "copy",
  on_finish: "retain",
  resources: { cpus: 1.5, memory: "2g", pids: 256, tmp: "512m" },
} as const

describe("sandbox config", () => {
  test("sandbox decodes through the live ConfigV1.Info path", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox })
    expect(decoded.sandbox).toEqual(sandbox)
  })

  test("sandbox decodes through the v2 Config.Info schema too", () => {
    const decoded = Schema.decodeUnknownSync(Config.Info)({ sandbox })
    expect(decoded.sandbox?.on_finish).toBe("retain")
  })

  test("unknown lifecycle policies are rejected", () => {
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: { on_finish: "sometimes" } })).toThrow()
  })

  test("defaults: destroy, copy, the version-matched image", () => {
    const resolved = SandboxConfig.resolve({})
    expect(resolved.on_finish).toBe("destroy")
    expect(resolved.workspace).toBe("copy")
    expect(resolved.enabled).toBe(false)
    expect(resolved.resources).toEqual({ cpus: 2, memory: "4g", pids: 512, tmp: "1g" })
    expect(SandboxConfig.defaultImage("1.18.42")).toBe("ghcr.io/axsiondev/lunos:1.18.42")
    expect(SandboxConfig.defaultImage("0.0.0-dev-202609291645")).toBe(SandboxConfig.LOCAL_IMAGE)
  })

  test("project config overrides global config, key by key", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(Global.Path.config, { recursive: true })
    const global = path.join(Global.Path.config, "opencode.json")
    const saved = await Bun.file(global)
      .text()
      .catch(() => undefined)
    await Bun.write(
      global,
      JSON.stringify({ sandbox: { enabled: true, on_finish: "retain", resources: { cpus: 4, memory: "8g" } } }),
    )
    try {
      await Bun.write(
        path.join(tmp.path, "opencode.jsonc"),
        `{ // project
          "sandbox": { "enabled": false, "image": "example/img:1", "resources": { "memory": "1g" } } }`,
      )
      const resolved = SandboxConfig.load(tmp.path)
      expect(resolved.on_finish).toBe("retain")
      expect(resolved.image).toBe("example/img:1")
      expect(resolved.resources.cpus).toBe(4)
      expect(resolved.resources.memory).toBe("1g")
      // A repository can't switch off a sandbox the user turned on.
      expect(resolved.enabled).toBe(true)
    } finally {
      if (saved === undefined) await fs.rm(global, { force: true })
      else await Bun.write(global, saved)
    }
  })
})

describe("sandbox container", () => {
  const args = SandboxDocker.createArgs({
    id: "abcd1234",
    project: "/repo",
    image: { ref: "lunos-sandbox:local", id: "sha256:feed" },
    resources: SandboxConfig.resolve({}).resources,
    workdir: "/sandbox/workspace",
    env: { HOME: "/sandbox/home" },
  })
  const pairs = args.flatMap((arg, i) => (arg.startsWith("--") ? [[arg, args[i + 1]] as const] : []))
  const has = (flag: string, value: string) => pairs.some(([f, v]) => f === flag && v === value)

  test("runs non-root with no capabilities, no privilege escalation and a read-only root", () => {
    expect(has("--user", "1000:1000")).toBe(true)
    expect(has("--cap-drop", "ALL")).toBe(true)
    expect(has("--security-opt", "no-new-privileges")).toBe(true)
    expect(args).toContain("--read-only")
    expect(args).not.toContain("--privileged")
    expect(args.some((arg) => arg.includes("seccomp"))).toBe(false)
    expect(args.some((arg) => arg.includes("--cap-add"))).toBe(false)
  })

  test("the only writable mounts are the sandbox volume and two tmpfs; never the Docker socket or the host tree", () => {
    const volumes = pairs.filter(([flag]) => flag === "--volume").map(([, value]) => value)
    // XCOD-157: the policy volume (managed config, sandbox marker) is mounted read-only.
    expect(volumes).toEqual(["lunos-sandbox-abcd1234:/sandbox", "lunos-sandbox-abcd1234-policy:/etc/lunos:ro"])
    expect(args.some((arg) => arg.includes("docker.sock"))).toBe(false)
    expect(args).not.toContain("--mount")
    const tmpfs = pairs.filter(([flag]) => flag === "--tmpfs").map(([, value]) => value)
    expect(tmpfs).toHaveLength(2)
    expect(tmpfs[0]).toStartWith("/tmp:")
    // The runtime tmpfs: private to the sandbox user, and nothing on it can be executed.
    expect(tmpfs[1]).toStartWith("/run/lunos:")
    expect(tmpfs[1]).toContain("mode=0700")
    expect(tmpfs[1]).toContain("uid=1000")
    expect(tmpfs[1]).toContain("noexec")
  })

  test("applies the resource limits and publishes the server on loopback only", () => {
    expect(has("--cpus", "2")).toBe(true)
    expect(has("--memory", "4g")).toBe(true)
    expect(has("--pids-limit", "512")).toBe(true)
    expect(has("--publish", "127.0.0.1::4096")).toBe(true)
  })

  test("pins the image by ID and carries no secret, only where the runtime file will be", () => {
    expect(args).toContain("sha256:feed")
    expect(args).not.toContain("lunos-sandbox:local")
    expect(has("--env", "HOME=/sandbox/home")).toBe(true)
    expect(has("--env", "LUNOS_SANDBOX_RUNTIME=/run/lunos/runtime.json")).toBe(true)
    const env = pairs.filter(([flag]) => flag === "--env").map(([, value]) => value)
    // XCOD-157: secrets used to be passed by name (-e NAME); `docker inspect` then showed their values.
    expect(env.every((value) => value.includes("="))).toBe(true)
    expect(env.some((value) => /API_KEY|AUTH_CONTENT|PASSWORD/.test(value))).toBe(false)
  })

  test("provider keys are picked up by the *_API_KEY convention", () => {
    expect(Sandbox.providerEnv({ ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "b", EMPTY_API_KEY: "", PATH: "/bin" })).toEqual(
      {
        ANTHROPIC_API_KEY: "a",
      },
    )
  })
})

describe("docker workspace adapter", () => {
  test("list reads host metadata only, so a workspace sync never waits on Docker", async () => {
    const { DockerAdapter } = await import("../../src/control-plane/adapters/docker")
    const started = Date.now()
    const listed = await DockerAdapter.list!({
      instance: { directory: "/nowhere", worktree: "/nowhere", project: { id: "prj_test" } } as never,
    })
    expect(listed).toEqual([])
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("copy mode and the result handoff", () => {
  test("the seed holds HEAD plus uncommitted changes, and the branch gets exactly the agent's edits", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
    // core.autocrlf=true is Windows' default, and a fresh repo (the seed) picks it up from global
    // config. The seed must still check files out with LF, for the Linux container.
    const globalConfig = path.join(root, "..", path.basename(root) + ".gitconfig")
    await Bun.write(globalConfig, "[core]\n\tautocrlf = true\n")
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    await using _restore = {
      [Symbol.asyncDispose]: async () => {
        if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
        else process.env.GIT_CONFIG_GLOBAL = previousGlobal
        await fs.rm(globalConfig, { force: true })
      },
    }
    await Bun.write(path.join(root, "a.txt"), "a\n")
    await Bun.write(path.join(root, "gone.txt"), "gone\n")
    await Bun.write(path.join(root, ".gitignore"), "ignored/\n")
    await $`git add -A && git commit -qm base`.cwd(root).quiet()
    // Uncommitted: a modification, a deletion, an untracked file and an ignored one.
    await Bun.write(path.join(root, "a.txt"), "a changed\n")
    await fs.rm(path.join(root, "gone.txt"))
    await Bun.write(path.join(root, "new.txt"), "new\n")
    await fs.mkdir(path.join(root, "ignored"))
    await Bun.write(path.join(root, "ignored", "secret.txt"), "secret\n")

    const status = await $`git status --porcelain`.cwd(root).text()
    const repo = await SandboxGit.repo(root)
    await using seedDir = await tmpdir()
    const seed = path.join(seedDir.path, "ws")
    await SandboxGit.seed({ ...repo, into: seed, branch: "lunos/sandbox/test" })
    expect(await Bun.file(path.join(seed, "a.txt")).text()).toBe("a changed\n")
    expect(await Bun.file(path.join(seed, "new.txt")).exists()).toBe(true)
    expect(await Bun.file(path.join(seed, "gone.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(seed, "ignored", "secret.txt")).exists()).toBe(false)
    expect((await $`git rev-parse HEAD`.cwd(seed).text()).trim()).toBe(repo.base)

    const baseTree = await SandboxGit.treeOfCommit(repo.gitDir, repo.base)
    const seedTree = await SandboxGit.tree({ gitDir: repo.gitDir, workTree: seed, startTree: baseTree })
    const seedCommit = await SandboxGit.commit({
      gitDir: repo.gitDir,
      tree: seedTree,
      parent: repo.base,
      message: "seed",
    })

    // The agent edits two files, and leaves ignored build output behind.
    await Bun.write(path.join(seed, "a.txt"), "a changed\nby the agent\n")
    await Bun.write(path.join(seed, "b.txt"), "b\n")
    await fs.mkdir(path.join(seed, "ignored"))
    await Bun.write(path.join(seed, "ignored", "out.bin"), "x")
    const tree = await SandboxGit.tree({ gitDir: repo.gitDir, workTree: seed, startTree: seedTree })
    const commit = await SandboxGit.commit({ gitDir: repo.gitDir, tree, parent: seedCommit, message: "agent" })
    await SandboxGit.setBranch({ gitDir: repo.gitDir, branch: "lunos/sandbox/test", commit })

    expect(await SandboxGit.changedFiles(repo.gitDir, seedCommit, "lunos/sandbox/test")).toEqual([
      { status: "M", path: "a.txt" },
      { status: "A", path: "b.txt" },
    ])
    // The host's working tree, index and HEAD are untouched.
    expect((await $`git rev-parse HEAD`.cwd(root).text()).trim()).toBe(repo.base)
    expect(await $`git status --porcelain`.cwd(root).text()).toBe(status)
    expect(status).toContain(" M a.txt")
    // A branch that already exists is never overwritten by a first handoff.
    await expect(
      SandboxGit.setBranch({ gitDir: repo.gitDir, branch: "lunos/sandbox/test", commit: seedCommit }),
    ).rejects.toThrow()
  })

  test("copy mode refuses a directory that isn't a git repository", async () => {
    await using tmp = await tmpdir()
    await expect(SandboxGit.repo(tmp.path)).rejects.toThrow("isn't in one")
  })
})

// XCOD-157: lifecycle policies, the runtime channel and the host-side config the container gets.
describe("sandbox lifecycle", () => {
  test("destroy_on_success and retain_for decode through both schemas; a bad duration is rejected", () => {
    const value = { on_finish: "destroy_on_success", retain_for: "72h" } as const
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: value }).sandbox).toEqual(value)
    expect(Schema.decodeUnknownSync(Config.Info)({ sandbox: value }).sandbox?.retain_for).toBe("72h")
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: { retain_for: "3 days" } })).toThrow()
  })

  test("retain_for resolves to milliseconds", () => {
    expect(SandboxConfig.duration("30m")).toBe(30 * 60_000)
    expect(SandboxConfig.duration("72h")).toBe(72 * 3_600_000)
    expect(SandboxConfig.duration("7d")).toBe(7 * 86_400_000)
    expect(SandboxConfig.resolve({ retain_for: "2h" }).retain_for).toBe(7_200_000)
    expect(SandboxConfig.resolve({}).retain_for).toBeUndefined()
  })

  test("destroy_on_success keeps the sandbox only when the task failed", () => {
    expect(Sandbox.destroys("destroy_on_success", { failed: false })).toBe(true)
    expect(Sandbox.destroys("destroy_on_success", { failed: true })).toBe(false)
    expect(Sandbox.destroys("destroy", { failed: true })).toBe(true)
    expect(Sandbox.destroys("retain", { failed: false })).toBe(false)
  })

  test("a task failed when a session's last reply ended in an error or stopped mid-task", () => {
    const reply = (finish?: string, error?: unknown) => ({ info: { role: "assistant", finish, error } })
    const user = { info: { role: "user" } }
    expect(Sandbox.failed([{ messages: [user, reply("stop")] }])).toBe(false)
    expect(Sandbox.failed([{ messages: [user, reply(undefined, { name: "APIError" })] }])).toBe(true)
    // Seen in a real run: a rejected tool call ends the loop with no error, finish "tool-calls".
    expect(Sandbox.failed([{ messages: [user, reply("tool-calls")] }])).toBe(true)
    expect(Sandbox.failed([{ messages: [user, reply("length")] }])).toBe(true)
    // An error earlier in the session that the agent recovered from isn't a failure.
    expect(Sandbox.failed([{ messages: [user, reply(undefined, { name: "APIError" }), user, reply("stop")] }])).toBe(
      false,
    )
    expect(Sandbox.failed([])).toBe(false)
  })

  test("--keep and --rm override on_finish for one run, and not together", async () => {
    const { lifecycleOverride } = await import("../../src/cli/cmd/sandbox")
    expect(lifecycleOverride({})).toBeUndefined()
    expect(lifecycleOverride({ keep: true })).toBe("retain")
    expect(lifecycleOverride({ rm: true })).toBe("destroy")
    expect(() => lifecycleOverride({ keep: true, rm: true })).toThrow("contradict")
  })

  test("expired reads the host metadata: only kept sandboxes past their retain_for", async () => {
    const dir = path.join(Global.Path.state, "sandbox")
    await fs.mkdir(dir, { recursive: true })
    const write = (id: string, expires?: string) =>
      Bun.write(path.join(dir, `${id}.json`), JSON.stringify({ id, expires }))
    const ids = ["x157past", "x157futu", "x157none"]
    try {
      await write(ids[0], "2026-01-01T00:00:00.000Z")
      await write(ids[1], "2999-01-01T00:00:00.000Z")
      await write(ids[2])
      const due = (await Sandbox.expired(Date.parse("2026-09-30T00:00:00Z"))).map((info) => info.id)
      expect(due).toContain(ids[0])
      expect(due).not.toContain(ids[1])
      expect(due).not.toContain(ids[2])
    } finally {
      for (const id of ids) await fs.rm(path.join(dir, `${id}.json`), { force: true })
    }
  })
})

describe("sandbox host config", () => {
  test("the server inside audits to a file the host collects, and doesn't forward", () => {
    const inside = Sandbox.auditInside({
      audit: {
        enabled: true,
        path: "/Users/me/audit.log",
        forward: { otlp: "https://siem.example.eu" },
        redact: ["x"],
      },
      residency: { allow: ["eu"], auditPath: "/var/log/egress.log" },
      model: "a/b",
    })
    expect(inside.audit).toEqual({ enabled: true, path: "/sandbox/home/audit.log", redact: ["x"] })
    expect(inside.residency).toEqual({ allow: ["eu"], auditPath: "/sandbox/home/audit.log" })
    expect(inside.model).toBe("a/b")
    // Untouched when there's nothing to rewrite.
    expect(Sandbox.auditInside({ residency: { allow: ["eu"] } })).toEqual({ residency: { allow: ["eu"] } })
  })

  test("managed documents merge without losing a lock, later documents winning", () => {
    const merged = SandboxConfig.mergeDocs([
      { $locked: ["residency"], residency: { allow: ["eu"] }, instructions: ["a.md"] },
      { $locked: ["audit"], audit: { enabled: true }, instructions: ["b.md"] },
      { residency: { allow: ["eu", "us"] } },
    ])
    expect(merged.$locked).toEqual(["residency", "audit"])
    expect(merged.instructions).toEqual(["a.md", "b.md"])
    expect(merged.residency).toEqual({ allow: ["eu", "us"] })
    expect(merged.audit).toEqual({ enabled: true })
  })

  test("host audit settings come from global and managed config; a managed lock wins outright", () => {
    const global = { audit: { enabled: true, path: "/home/u/audit.log" }, residency: { allow: ["eu", "us"] } }
    expect(SandboxConfig.auditConfig(global, undefined).audit?.path).toBe("/home/u/audit.log")
    const managed = { $locked: ["residency"], residency: { allow: ["eu"] }, audit: { path: "/var/log/lunos.log" } }
    const both = SandboxConfig.auditConfig(global, managed)
    expect(both.residency?.allow).toEqual(["eu"])
    // Not locked: merged, managed on top.
    expect(both.audit).toEqual({ enabled: true, path: "/var/log/lunos.log" })
  })

  test("the runtime file becomes the server's environment and global config, then disappears", async () => {
    await using tmp = await tmpdir()
    const { load, GLOBAL_CONFIG } = await import("../../src/sandbox/boot")
    const file = path.join(tmp.path, "runtime.json")
    await Bun.write(
      file,
      JSON.stringify({ env: { X157_SENTINEL_API_KEY: "sk-sentinel" }, config: { residency: { allow: ["eu"] } } }),
    )
    const saved = process.env.OPENCODE_CONFIG
    delete process.env.OPENCODE_CONFIG
    try {
      load(file, 1000)
      // Read through a widened view: TypeScript narrows process.env.OPENCODE_CONFIG after the delete.
      const env: Record<string, string | undefined> = process.env
      expect(env.X157_SENTINEL_API_KEY).toBe("sk-sentinel")
      expect(env.OPENCODE_CONFIG).toBe(path.join(tmp.path, GLOBAL_CONFIG))
      const written: unknown = JSON.parse(await Bun.file(env.OPENCODE_CONFIG!).text())
      expect(written).toEqual({ residency: { allow: ["eu"] } })
      expect(await Bun.file(file).exists()).toBe(false)
      // Flag snapshots some keys at load; the compiled binary may have loaded it before boot ran.
      const { Flag } = await import("@opencode-ai/core/flag/flag")
      expect(Flag.OPENCODE_CONFIG).toBe(env.OPENCODE_CONFIG)
    } finally {
      delete process.env.X157_SENTINEL_API_KEY
      if (saved === undefined) delete process.env.OPENCODE_CONFIG
      else process.env.OPENCODE_CONFIG = saved
      const { Flag } = await import("@opencode-ai/core/flag/flag")
      Flag.OPENCODE_CONFIG = saved
    }
  })
})

// XCOD-157: sandbox.required, from managed config, and the guards that enforce it.
describe("sandbox required", () => {
  const withManaged = async (doc: unknown, fn: (dir: string) => Promise<void>) => {
    await using managed = await tmpdir()
    await Bun.write(path.join(managed.path, "managed.json"), JSON.stringify(doc))
    const saved = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managed.path
    try {
      await fn(managed.path)
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = saved
    }
  }

  test("sandbox.required decodes through both schemas and is lockable", async () => {
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: { required: true } }).sandbox?.required).toBe(true)
    expect(Schema.decodeUnknownSync(Config.Info)({ sandbox: { required: true } }).sandbox?.required).toBe(true)
    const { ConfigPolicy } = await import("../../src/config/policy")
    expect(ConfigPolicy.KNOWN).toContain("sandbox.required")
  })

  test("required in managed config: the host sandboxes, and a repository can't turn it off", async () => {
    await using project = await tmpdir({ git: true })
    await Bun.write(
      path.join(project.path, "opencode.json"),
      JSON.stringify({ sandbox: { required: false, enabled: false } }),
    )
    await withManaged({ $locked: ["sandbox.required"], sandbox: { required: true } }, async () => {
      const config = SandboxConfig.load(project.path)
      expect(config.required).toBe(true)
      expect(config.requiredBy).toBe("managed")
      expect(config.enabled).toBe(true)
    })
    expect(SandboxConfig.load(project.path).required).toBe(false)
  })

  test("the host may not run it, and says why; inside a sandbox it may", () => {
    const message = SandboxConfig.refusal({ required: true, requiredBy: "managed" }, "`lunos serve`", false)
    expect(message).toContain("sandbox.required is set by your organisation's managed config")
    expect(message).toContain("`lunos serve`")
    expect(SandboxConfig.refusal({ required: true, requiredBy: "managed" }, "`lunos serve`", true)).toBeUndefined()
    expect(SandboxConfig.refusal({ required: false }, "`lunos serve`", false)).toBeUndefined()
  })

  test("inside needs the root-owned marker to match LUNOS_SANDBOX, not the variable alone", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "sandbox.json")
    expect(SandboxConfig.inside("abcd1234", marker)).toBe(false)
    await Bun.write(marker, JSON.stringify({ id: "abcd1234" }))
    expect(SandboxConfig.inside("abcd1234", marker)).toBe(true)
    expect(SandboxConfig.inside("other", marker)).toBe(false)
    expect(SandboxConfig.inside(undefined, marker)).toBe(false)
  })

  test("--no-sandbox is overruled by a requirement; --attach runs nothing here", async () => {
    await using project = await tmpdir({ git: true })
    const { wanted } = await import("../../src/cli/cmd/sandbox")
    await withManaged({ sandbox: { required: true } }, async () => {
      expect(wanted({ sandbox: false }, project.path)).toBe(true)
      expect(wanted({}, project.path)).toBe(true)
      expect(wanted({ attach: "http://127.0.0.1:4096" }, project.path)).toBe(false)
    })
    expect(wanted({ sandbox: false }, project.path)).toBe(false)
  })

  test("the tool guard refuses every tool call outside a sandbox, with the reason", async () => {
    const { SandboxGuard } = await import("../../src/sandbox/guard")
    const ran: string[] = []
    const tools = {
      bash: { execute: async () => void ran.push("bash") },
      mcp_thing: { execute: async () => void ran.push("mcp") },
      schemaOnly: {},
    }
    expect(SandboxGuard.guard(tools, { required: false }, "ses_1", false)).toBe(false)
    expect(SandboxGuard.guard(tools, { required: true }, "ses_1", true)).toBe(false)
    expect(SandboxGuard.guard(tools, { required: true }, "ses_1", false)).toBe(true)
    await expect(tools.bash.execute()).rejects.toThrow("sandbox.required is set")
    await expect(tools.mcp_thing.execute()).rejects.toThrow("can't run on this machine")
    expect(ran).toEqual([])
  })
})

// XCOD-157: network policy. The proxy is exercised over real sockets on loopback.
describe("sandbox network", () => {
  test("allow-list matching: exact host and port, subdomains for a leading dot", async () => {
    const { SandboxEgress } = await import("../../src/sandbox/egress")
    const list = ["api.anthropic.com:443", ".example.eu:443", "10.0.0.5:8000"]
    expect(SandboxEgress.allowed(list, "api.anthropic.com", 443)).toBe(true)
    expect(SandboxEgress.allowed(list, "API.Anthropic.com.", 443)).toBe(true)
    expect(SandboxEgress.allowed(list, "api.anthropic.com", 80)).toBe(false)
    expect(SandboxEgress.allowed(list, "eu.api.anthropic.com", 443)).toBe(false)
    expect(SandboxEgress.allowed(list, "a.example.eu", 443)).toBe(true)
    expect(SandboxEgress.allowed(list, "example.eu.attacker.com", 443)).toBe(false)
    expect(SandboxEgress.allowed(list, "10.0.0.5", 8000)).toBe(true)
    expect(SandboxEgress.allowed(list, "10.0.0.6", 8000)).toBe(false)
  })

  test("the proxy forwards what's allowed, refuses the rest with 403, and logs both", async () => {
    const net = await import("node:net")
    const { SandboxEgress } = await import("../../src/sandbox/egress")
    // An upstream that echoes the first line it receives, and a server standing in for the sandbox.
    const upstream = net.createServer((socket) =>
      socket.once("data", (data) => socket.end(`upstream saw: ${data.toString().split("\r\n")[0]}`)),
    )
    const sandboxServer = net.createServer((socket) => socket.end("hello from the sandbox server"))
    await Promise.all(
      [upstream, sandboxServer].map((server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done))),
    )
    const upPort = (upstream.address() as { port: number }).port
    const serverPort = (sandboxServer.address() as { port: number }).port
    const decisions: { host: string; port: number; allowed: boolean; kind: string }[] = []
    const egress = SandboxEgress.serve({
      allow: [`127.0.0.1:${upPort}`],
      upstream: { host: "127.0.0.1", port: serverPort },
      proxyPort: 0,
      relayPort: 0,
      log: (decision) => decisions.push(decision),
    })
    await Promise.all(
      [egress.proxy, egress.relay].map((server) => new Promise((done) => server.once("listening", done))),
    )
    const proxyPort = (egress.proxy.address() as { port: number }).port
    const relayPort = (egress.relay.address() as { port: number }).port
    const exchange = (port: number, text: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(text))
        let out = ""
        socket.on("data", (data) => (out += data.toString()))
        socket.on("close", () => resolve(out))
        socket.on("error", () => resolve(out))
      })
    try {
      const tunnel = await exchange(proxyPort, `CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nHost: x\r\n\r\nPING\r\n`)
      expect(tunnel).toContain("200 Connection Established")
      expect(tunnel).toContain("upstream saw: PING")

      const plain = await exchange(
        proxyPort,
        `GET http://127.0.0.1:${upPort}/v1/models?x=1 HTTP/1.1\r\nHost: x\r\n\r\n`,
      )
      // Rewritten to origin form for the upstream.
      expect(plain).toContain("upstream saw: GET /v1/models?x=1 HTTP/1.1")

      const refused = await exchange(proxyPort, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n")
      expect(refused).toStartWith("HTTP/1.1 403 Forbidden")
      expect(refused).toContain("example.com:443 is not allowed")

      expect(await exchange(relayPort, "hi")).toBe("hello from the sandbox server")
      expect(decisions.map((item) => [item.kind, item.host, item.port, item.allowed])).toEqual([
        ["connect", "127.0.0.1", upPort, true],
        ["http", "127.0.0.1", upPort, true],
        ["connect", "example.com", 443, false],
      ])
    } finally {
      await egress.close()
      upstream.close()
      sandboxServer.close()
    }
  })

  test("allow list: providers the residency policy allows, remote MCP, npm, sandbox.allow", async () => {
    const { SandboxAllow } = await import("../../src/sandbox/allow")
    const doc = {
      provider: {
        local: { options: { baseURL: "http://10.0.0.5:8000/v1" } },
        anthropic: {},
      },
      mcp: {
        docs: { type: "remote", url: "https://mcp.example.eu/sse" },
        off: { type: "remote", url: "https://off.example.com", enabled: false },
        tool: { type: "local", command: ["x"] },
      },
    }
    const open = SandboxAllow.compute({
      doc,
      providers: ["mistral"],
      network: "policy",
      extra: ["files.example.eu", "cache:8080"],
    })
    expect(open.allow).toEqual(
      [
        "10.0.0.5:8000",
        "api.anthropic.com:443",
        "api.mistral.ai:443",
        "codestral.mistral.ai:443",
        "mcp.example.eu:443",
        "registry.npmjs.org:443",
        "files.example.eu:443",
        "cache:8080",
      ].sort(),
    )
    // An EU-only policy drops the US provider and the undeclared self-hosted endpoint.
    const eu = SandboxAllow.compute({
      doc: { ...doc, residency: { allow: ["eu"] } },
      providers: ["mistral"],
      network: "policy",
      extra: [],
    })
    expect(eu.allow).toContain("api.mistral.ai:443")
    expect(eu.allow).not.toContain("api.anthropic.com:443")
    expect(eu.allow).not.toContain("10.0.0.5:8000")
    expect(eu.denied.map((item) => item.provider).sort()).toEqual(["anthropic", "local"])
    expect(SandboxAllow.compute({ doc, providers: [], network: "none", extra: ["x"] }).allow).toEqual([])
    expect(SandboxAllow.providersFromEnv(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "FIREWORKS_API_KEY"])).toEqual([
      "anthropic",
      "google",
      "fireworks-ai",
    ])
  })

  test("a repository can make the network stricter, never looser, and can't add hosts", async () => {
    expect(SandboxConfig.strictest("open", "policy")).toBe("policy")
    expect(SandboxConfig.strictest("none", "open")).toBe("none")
    expect(SandboxConfig.strictest(undefined, "open")).toBe("open")
    await using project = await tmpdir({ git: true })
    await Bun.write(
      path.join(project.path, "opencode.json"),
      JSON.stringify({ sandbox: { network: "open", allow: ["evil.example.com"] } }),
    )
    await Bun.write(
      path.join(project.path, "opencode.json"),
      JSON.stringify({ sandbox: { network: "open", allow: ["evil.example.com"], image: "evil/proxy:latest" } }),
    )
    const loaded = SandboxConfig.load(project.path)
    expect(loaded.network).toBe("policy")
    expect(loaded.allow).toEqual([])
    // The repository chose the sandbox's image, but not the egress proxy's.
    expect(loaded.image).toBe("evil/proxy:latest")
    expect(loaded.egressImage).toBe(SandboxConfig.defaultImage())
    await Bun.write(path.join(project.path, "opencode.json"), JSON.stringify({ sandbox: { network: "none" } }))
    expect(SandboxConfig.load(project.path).network).toBe("none")
  })

  test("under a network policy the sandbox has no route out and no published port; the proxy is its way out", () => {
    const args = SandboxDocker.createArgs({
      id: "abcd1234",
      project: "/repo",
      image: { ref: "lunos-sandbox:local", id: "sha256:feed" },
      resources: SandboxConfig.resolve({}).resources,
      workdir: "/sandbox/workspace",
      env: {},
      network: "policy",
    })
    expect(args).not.toContain("--publish")
    expect(args.join(" ")).toContain("--network lunos-sandbox-abcd1234-net --network-alias sandbox")
    expect(args).toContain("HTTPS_PROXY=http://egress:3128")
    expect(args).toContain("OPENCODE_DISABLE_MODELS_FETCH=1")

    const egress = SandboxDocker.egressArgs({
      id: "abcd1234",
      image: { ref: "ghcr.io/axsiondev/lunos:1.18.43", id: "sha256:trusted" },
      allow: ["api.mistral.ai:443"],
    })
    expect(egress.slice(-3)).toEqual(["sha256:trusted", "sandbox", "egress"])
    for (const flag of ["--read-only", "no-new-privileges", "ALL", "1000:1000", "127.0.0.1::4096"])
      expect(egress).toContain(flag)
    expect(egress).toContain('LUNOS_EGRESS_ALLOW=["api.mistral.ai:443"]')
    // It carries the relay's port; the sandbox's own label is left off, so `sandbox list` shows one row.
    expect(egress).toContain("lunos.sandbox.egress=abcd1234")
    expect(egress).not.toContain("lunos.sandbox=abcd1234")
  })
})

// XCOD-158: runtimes, result modes and status.
describe("sandbox slice 3", () => {
  test("results and runtime decode through both schemas; defaults are branch and auto-detect", () => {
    const value = { results: "patch", runtime: "podman" } as const
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: value }).sandbox).toEqual(value)
    expect(Schema.decodeUnknownSync(Config.Info)({ sandbox: value }).sandbox?.results).toBe("patch")
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: { runtime: "lxc" } })).toThrow()
    expect(SandboxConfig.resolve({}).results).toBe("branch")
    expect(SandboxConfig.resolve({}).runtime).toBeUndefined()
  })

  test("listing parses the inspect template both runtimes print, including podman's leading slash", () => {
    const out = [
      "abcd1234\t/lunos-sandbox-abcd1234\texited\t/repo\t2026-09-30T16:00:00Z",
      "ef567890\tlunos-sandbox-ef567890\trunning\t\t2026-09-30T16:05:00.123456789+03:00",
      // The egress container carries no lunos.sandbox label: its id renders as "<no value>".
      "<no value>\tlunos-sandbox-abcd1234-egress\texited\t<no value>\t2026-09-30T16:00:00Z",
    ].join("\n")
    expect(SandboxDocker.parseList(out)).toEqual([
      {
        id: "abcd1234",
        name: "lunos-sandbox-abcd1234",
        state: "exited",
        status: "exited",
        project: "/repo",
        created: "2026-09-30T16:00:00Z",
      },
      {
        id: "ef567890",
        name: "lunos-sandbox-ef567890",
        state: "running",
        status: "running",
        project: undefined,
        created: "2026-09-30T16:05:00.123456789+03:00",
      },
    ])
  })

  test("a patch holds only the agent's changes, and applies on top of the user's own uncommitted work", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
    await Bun.write(path.join(root, "a.txt"), "a\n")
    await $`git add -A && git commit -qm base`.cwd(root).quiet()
    await Bun.write(path.join(root, "mine.txt"), "the user's own work\n")
    const repo = await SandboxGit.repo(root)
    await using seedDir = await tmpdir()
    const seed = path.join(seedDir.path, "ws")
    await SandboxGit.seed({ ...repo, into: seed, branch: "lunos/sandbox/patch" })
    const baseTree = await SandboxGit.treeOfCommit(repo.gitDir, repo.base)
    const seedTree = await SandboxGit.tree({ gitDir: repo.gitDir, workTree: seed, startTree: baseTree })
    await Bun.write(path.join(seed, "a.txt"), "a\nby the agent\n")
    await Bun.write(path.join(seed, "agent.bin"), new Uint8Array([0, 1, 2, 255]))
    const tree = await SandboxGit.tree({ gitDir: repo.gitDir, workTree: seed, startTree: seedTree })

    const patch = await SandboxGit.diff(repo.gitDir, seedTree, tree)
    expect(patch).toContain("a/a.txt")
    expect(patch).toContain("GIT binary patch")
    expect(patch).not.toContain("mine.txt")
    await Bun.write(path.join(root, "changes.patch"), patch)
    await $`git apply changes.patch`.cwd(root).quiet()
    // git apply checks text out with the user's own line endings: CRLF under Windows' core.autocrlf.
    expect((await Bun.file(path.join(root, "a.txt")).text()).replaceAll("\r\n", "\n")).toBe("a\nby the agent\n")
    expect(new Uint8Array(await Bun.file(path.join(root, "agent.bin")).arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    )
    expect(await Bun.file(path.join(root, "mine.txt")).text()).toBe("the user's own work\n")
    // No branch was made.
    expect((await $`git branch --list ${"lunos/sandbox/*"}`.cwd(root).text()).trim()).toBe("")
  })

  test("podman gets its own tmpfs owner option and starts the proxy on a bridge network", () => {
    // Both found by replaying the lifecycle on rootless Podman 5.8: it rejects uid=, and a container
    // started with its default (pasta) networking can't join the internal network afterwards.
    expect(SandboxDocker.runtimeTmpfs("docker")).toEndWith(",uid=1000,gid=1000")
    expect(SandboxDocker.runtimeTmpfs("podman")).toEndWith(",mode=0700,U")
    const image = { ref: "x", id: "sha256:x" }
    const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1]
    expect(pair(SandboxDocker.egressArgs({ id: "a", image, allow: [], engine: "podman" }), "--network")).toBe("podman")
    expect(pair(SandboxDocker.egressArgs({ id: "a", image, allow: [], engine: "docker" }), "--network")).toBe("bridge")
  })

  test("the marker tells the server inside what it runs in", () => {
    const marker = Sandbox.markerOf({
      id: "abcd1234",
      image: { ref: "lunos-sandbox:local", id: "sha256:feed", digest: "lunos@sha256:beef" },
      network: "policy",
      results: "patch",
      runtime: "podman",
      created: "2026-09-30T16:00:00Z",
    } as Sandbox.Meta)
    expect(marker).toEqual({
      id: "abcd1234",
      image: "lunos-sandbox:local",
      digest: "lunos@sha256:beef",
      network: "policy",
      results: "patch",
      runtime: "podman",
      created: "2026-09-30T16:00:00Z",
    })
  })
})
