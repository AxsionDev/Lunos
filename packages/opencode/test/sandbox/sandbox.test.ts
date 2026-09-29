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
    await Bun.write(global, JSON.stringify({ sandbox: { on_finish: "retain", resources: { cpus: 4, memory: "8g" } } }))
    try {
      await Bun.write(
        path.join(tmp.path, "opencode.jsonc"),
        `{ // project
          "sandbox": { "image": "example/img:1", "resources": { "memory": "1g" } } }`,
      )
      const resolved = SandboxConfig.load(tmp.path)
      expect(resolved.on_finish).toBe("retain")
      expect(resolved.image).toBe("example/img:1")
      expect(resolved.resources.cpus).toBe(4)
      expect(resolved.resources.memory).toBe("1g")
    } finally {
      await fs.rm(global, { force: true })
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
    secretNames: ["OPENCODE_AUTH_CONTENT", "ANTHROPIC_API_KEY"],
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

  test("the only writable mounts are the sandbox volume and /tmp; never the Docker socket or the host tree", () => {
    const volumes = pairs.filter(([flag]) => flag === "--volume").map(([, value]) => value)
    expect(volumes).toEqual(["lunos-sandbox-abcd1234:/sandbox"])
    expect(args.some((arg) => arg.includes("docker.sock"))).toBe(false)
    expect(args).not.toContain("--mount")
    expect(pairs.find(([flag]) => flag === "--tmpfs")?.[1]).toStartWith("/tmp:")
  })

  test("applies the resource limits and publishes the server on loopback only", () => {
    expect(has("--cpus", "2")).toBe(true)
    expect(has("--memory", "4g")).toBe(true)
    expect(has("--pids-limit", "512")).toBe(true)
    expect(has("--publish", "127.0.0.1::4096")).toBe(true)
  })

  test("pins the image by ID and passes secrets by name only", () => {
    expect(args).toContain("sha256:feed")
    expect(args).not.toContain("lunos-sandbox:local")
    expect(has("--env", "OPENCODE_AUTH_CONTENT")).toBe(true)
    expect(has("--env", "ANTHROPIC_API_KEY")).toBe(true)
    expect(has("--env", "HOME=/sandbox/home")).toBe(true)
  })

  test("provider keys are picked up by the *_API_KEY convention", () => {
    expect(Sandbox.providerEnv({ ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "b", EMPTY_API_KEY: "", PATH: "/bin" })).toEqual(
      {
        ANTHROPIC_API_KEY: "a",
      },
    )
  })
})

describe("copy mode and the result handoff", () => {
  test("the seed holds HEAD plus uncommitted changes, and the branch gets exactly the agent's edits", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
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
