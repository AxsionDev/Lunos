import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SubagentIsolation } from "../../src/session/isolation"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tmp(prefix: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

async function sh(cwd: string, ...args: string[]) {
  const out = await SubagentIsolation.git(args, { cwd })
  if (out.code !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`)
  return out.stdout.trim()
}

const PACKAGE = {
  name: "app",
  version: "1.0.0",
  dependencies: { base: "file:./libs/base" },
}

async function repo(files: Record<string, string> = {}) {
  const root = await tmp("lunos-iso-repo-")
  await sh(root, "init", "-q", "-b", "main")
  await sh(root, "config", "user.email", "me@example.com")
  await sh(root, "config", "user.name", "Me")
  await sh(root, "config", "commit.gpgSign", "false")
  const all = {
    "package.json": JSON.stringify(PACKAGE, null, 2) + "\n",
    "src/math.ts": "export function add(a: number, b: number) {\n  return a + b\n}\n",
    "libs/base/package.json": JSON.stringify({ name: "base", version: "1.0.0" }, null, 2) + "\n",
    ...files,
  }
  await Promise.all(
    Object.entries(all).map(async ([file, text]) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await Bun.write(path.join(root, file), text)
    }),
  )
  await sh(root, "add", "-A")
  await sh(root, "commit", "-q", "-m", "init")
  return root
}

async function edit(dir: string, file: string, change: (text: string) => string) {
  const target = path.join(dir, file)
  const text = await Bun.file(target)
    .text()
    .catch(() => "")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, change(text))
}

function addDependency(name: string) {
  return (text: string) => {
    const json = JSON.parse(text)
    json.dependencies[name] = `file:./libs/${name}`
    return JSON.stringify(json, null, 2) + "\n"
  }
}

async function lunosRefs(root: string) {
  const branches = await sh(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/lunos/")
  const worktrees = (await sh(root, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("branch refs/heads/lunos/"))
  return { branches: branches.split("\n").filter(Boolean), worktrees }
}

describe("SubagentIsolation", () => {
  test("snapshot holds uncommitted and untracked changes without touching index, branches or stash", async () => {
    const root = await repo()
    const data = await tmp("lunos-iso-data-")
    await edit(root, "src/math.ts", (text) => text + "// wip\n")
    await edit(root, "notes.txt", () => "untracked\n")
    await sh(root, "add", "src/math.ts")
    await sh(root, "stash", "push", "-q", "--keep-index", "-m", "mine")
    await edit(root, "notes.txt", () => "untracked\n")
    const before = {
      status: await sh(root, "status", "--porcelain"),
      branches: await sh(root, "branch", "--list"),
      stash: await sh(root, "stash", "list"),
      head: await sh(root, "rev-parse", "HEAD"),
    }

    const created = await SubagentIsolation.create({ root, dataDir: data, session: "ses_1", step: "Write docs" })
    expect(created.handle.branch).toBe("lunos/ses-1/write-docs")
    expect(await Bun.file(path.join(created.handle.directory, "notes.txt")).text()).toBe("untracked\n")
    expect(await Bun.file(path.join(created.handle.directory, "src/math.ts")).text()).toContain("// wip")
    // Shared object store: well under a second on a small repository.
    expect(created.ms).toBeLessThan(1000)

    expect(await sh(root, "status", "--porcelain")).toBe(before.status)
    expect(await sh(root, "stash", "list")).toBe(before.stash)
    expect(await sh(root, "rev-parse", "HEAD")).toBe(before.head)
    await SubagentIsolation.discard(created.handle)
    expect(await sh(root, "branch", "--list")).toBe(before.branches)
  })

  test("three parallel subagents editing package.json and their own files all merge; lockfile regenerated", async () => {
    const root = await repo({
      "libs/a/package.json": '{ "name": "a", "version": "1.0.0" }\n',
      "libs/b/package.json": '{ "name": "b", "version": "1.0.0" }\n',
      "libs/c/package.json": '{ "name": "c", "version": "1.0.0" }\n',
    })
    const data = await tmp("lunos-iso-data-")
    // The user keeps working meanwhile: an uncommitted change of their own.
    await edit(root, "README.md", () => "mine\n")
    const steps = await Promise.all(
      ["a", "b", "c"].map((name) => SubagentIsolation.create({ root, dataDir: data, session: "ses_2", step: name })),
    )
    await Promise.all(
      steps.map(async (step, i) => {
        const name = ["a", "b", "c"][i]!
        await edit(step.handle.directory, "package.json", addDependency(name))
        await edit(step.handle.directory, `src/${name}.ts`, () => `export const ${name} = "${name}"\n`)
        expect(await SubagentIsolation.finalize(step.handle)).toBeTruthy()
      }),
    )
    const regenerated: string[] = []
    const regenerate = async (dir: string) => {
      regenerated.push(dir)
      return "fake install"
    }
    const results = []
    for (const step of steps) results.push(await SubagentIsolation.merge(step.handle, { regenerate }))
    expect(results.map((item) => item.state)).toEqual(["merged", "merged", "merged"])
    // The second and third conflict textually in package.json (the comma) and merge key by key.
    expect(results[1]!.state === "merged" && results[1]!.resolved).toEqual(["package.json"])
    expect(regenerated).toEqual([root, root, root])

    const pkg = JSON.parse(await Bun.file(path.join(root, "package.json")).text())
    expect(Object.keys(pkg.dependencies)).toEqual(["base", "a", "b", "c"])
    for (const name of ["a", "b", "c"]) expect(await Bun.file(path.join(root, `src/${name}.ts`)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "README.md")).text()).toBe("mine\n")
    // Working tree only: nothing staged, HEAD unchanged.
    expect(await sh(root, "diff", "--cached", "--name-only")).toBe("")
    expect((await sh(root, "rev-list", "--count", "HEAD"))).toBe("1")

    await Promise.all(steps.map((step) => SubagentIsolation.discard(step.handle)))
    expect(await lunosRefs(root)).toEqual({ branches: [], worktrees: [] })
  })

  test("a real lockfile regeneration runs offline with bun", async () => {
    const root = await repo({ "libs/a/package.json": '{ "name": "a", "version": "1.0.0" }\n' })
    const data = await tmp("lunos-iso-data-")
    const install = Bun.spawnSync(["bun", "install", "--ignore-scripts"], { cwd: root, stdout: "ignore", stderr: "pipe" })
    expect(install.exitCode).toBe(0)
    await sh(root, "add", "-A")
    await sh(root, "commit", "-q", "-m", "lock")
    const step = await SubagentIsolation.create({ root, dataDir: data, session: "ses_3", step: "dep" })
    await edit(step.handle.directory, "package.json", addDependency("a"))
    await SubagentIsolation.finalize(step.handle)
    const result = await SubagentIsolation.merge(step.handle, { regenerate: SubagentIsolation.regenerate })
    expect(result.state === "merged" && result.regenerated).toContain("bun install --lockfile-only")
    expect(await Bun.file(path.join(root, "bun.lock")).text()).toContain('"a"')
    await SubagentIsolation.discard(step.handle)
  })

  test("additive changes in the same file are combined", async () => {
    const root = await repo({ "src/index.ts": 'export * from "./math"\n' })
    const data = await tmp("lunos-iso-data-")
    const steps = await Promise.all(
      ["x", "y"].map((name) => SubagentIsolation.create({ root, dataDir: data, session: "ses_4", step: name })),
    )
    await edit(steps[0]!.handle.directory, "src/index.ts", (text) => text + 'export * from "./x"\n')
    await edit(steps[1]!.handle.directory, "src/index.ts", (text) => text + 'export * from "./y"\n')
    for (const step of steps) await SubagentIsolation.finalize(step.handle)
    expect((await SubagentIsolation.merge(steps[0]!.handle)).state).toBe("merged")
    expect((await SubagentIsolation.merge(steps[1]!.handle)).state).toBe("merged")
    expect(await Bun.file(path.join(root, "src/index.ts")).text()).toBe(
      'export * from "./math"\nexport * from "./x"\nexport * from "./y"\n',
    )
    await Promise.all(steps.map((step) => SubagentIsolation.discard(step.handle)))
  })

  test("a real conflict in the same function is reported with both versions and nothing is written", async () => {
    const root = await repo()
    const data = await tmp("lunos-iso-data-")
    const step = await SubagentIsolation.create({ root, dataDir: data, session: "ses_5", step: "sub" })
    await edit(step.handle.directory, "src/math.ts", (text) => text.replace("a + b", "a - b"))
    await SubagentIsolation.finalize(step.handle)
    await edit(root, "src/math.ts", (text) => text.replace("a + b", "b + a + 0"))
    const before = await Bun.file(path.join(root, "src/math.ts")).text()

    const result = await SubagentIsolation.merge(step.handle)
    expect(result.state).toBe("conflict")
    if (result.state !== "conflict") throw new Error("unreachable")
    expect(result.conflicts.map((item) => item.path)).toEqual(["src/math.ts"])
    expect(result.conflicts[0]!.ours).toContain("b + a + 0")
    expect(result.conflicts[0]!.theirs).toContain("a - b")
    expect(await Bun.file(path.join(root, "src/math.ts")).text()).toBe(before)

    // The merge subagent's job: markers in its worktree, resolved, then a clean merge.
    const prepared = await SubagentIsolation.prepareConflict(step.handle, result.ours)
    expect(prepared.unmerged).toEqual(["src/math.ts"])
    expect(await SubagentIsolation.conclude(step.handle, result.ours)).toBe(false)
    await edit(step.handle.directory, "src/math.ts", () => "export function add(a: number, b: number) {\n  return b - a\n}\n")
    expect(await SubagentIsolation.conclude(step.handle, result.ours)).toBe(true)
    expect((await SubagentIsolation.merge(step.handle)).state).toBe("merged")
    expect(await Bun.file(path.join(root, "src/math.ts")).text()).toContain("b - a")
    await SubagentIsolation.discard(step.handle)
  })

  test("the user's choice settles a conflict", async () => {
    const root = await repo()
    const data = await tmp("lunos-iso-data-")
    const step = await SubagentIsolation.create({ root, dataDir: data, session: "ses_6", step: "sub" })
    await edit(step.handle.directory, "src/math.ts", (text) => text.replace("a + b", "a - b"))
    await edit(step.handle.directory, "src/other.ts", () => "export const other = 1\n")
    await SubagentIsolation.finalize(step.handle)
    await edit(root, "src/math.ts", (text) => text.replace("a + b", "b + a + 0"))
    const result = await SubagentIsolation.settle(step.handle, "ours")
    expect(result.state).toBe("merged")
    expect(await Bun.file(path.join(root, "src/math.ts")).text()).toContain("b + a + 0")
    expect(await Bun.file(path.join(root, "src/other.ts")).exists()).toBe(true)
    await SubagentIsolation.discard(step.handle)
  })

  test("a failed subagent leaves no partial edits in the user's tree", async () => {
    const root = await repo()
    const data = await tmp("lunos-iso-data-")
    await edit(root, "README.md", () => "mine\n")
    const status = await sh(root, "status", "--porcelain")
    const step = await SubagentIsolation.create({ root, dataDir: data, session: "ses_7", step: "fails" })
    await edit(step.handle.directory, "src/math.ts", () => "half-made")
    await edit(step.handle.directory, "src/new.ts", () => "half-made")
    await SubagentIsolation.discard(step.handle)
    expect(await sh(root, "status", "--porcelain")).toBe(status)
    expect(await Bun.file(path.join(root, "src/math.ts")).text()).toContain("a + b")
    expect(await lunosRefs(root)).toEqual({ branches: [], worktrees: [] })
  })

  test("after a crash, the next start removes every lunos worktree and branch, and nothing of the user's", async () => {
    const root = await repo()
    const data = await tmp("lunos-iso-data-")
    await sh(root, "branch", "feature")
    await sh(root, "branch", "lunosish")
    await edit(root, "src/math.ts", (text) => text + "// stashed\n")
    await sh(root, "stash", "push", "-q", "-m", "mine")
    // A crashed process: its worktrees are locked to a pid that no longer exists.
    const dead = Bun.spawn(["true"])
    await dead.exited
    const crashed = await Promise.all(
      ["one", "two"].map((step) => SubagentIsolation.create({ root, dataDir: data, session: "ses_8", step })),
    )
    for (const item of crashed)
      await sh(root, "worktree", "lock", "--reason", `lunos pid ${dead.pid}`, item.handle.directory).catch(
        async () => {
          await sh(root, "worktree", "unlock", item.handle.directory)
          await sh(root, "worktree", "lock", "--reason", `lunos pid ${dead.pid}`, item.handle.directory)
        },
      )
    // An orphan branch whose worktree directory is already gone.
    await sh(root, "branch", "lunos/ses-8/orphan")
    // Another live Lunos (this process stands in) keeps its running worktree...
    const live = await SubagentIsolation.create({ root, dataDir: data, session: "ses_9", step: "live" })

    const removed = await SubagentIsolation.sweep({ root, dataDir: data })
    expect(removed.sort()).toEqual(["lunos/ses-8/one", "lunos/ses-8/orphan", "lunos/ses-8/two"])
    expect((await lunosRefs(root)).branches).toEqual(["lunos/ses-9/live"])
    // ...until it exits.
    await SubagentIsolation.sweep({ root, dataDir: data, own: true })
    expect(await lunosRefs(root)).toEqual({ branches: [], worktrees: [] })
    expect(await Bun.file(live.handle.directory).exists()).toBe(false)

    const branches = (await sh(root, "branch", "--format=%(refname:short)")).split("\n").sort()
    expect(branches).toEqual(["feature", "lunosish", "main"])
    expect(await sh(root, "stash", "list")).toContain("mine")
  })

  test("non-git folders, shared isolation and read-only subagents keep today's behaviour", async () => {
    const root = await repo()
    const plain = await tmp("lunos-iso-plain-")
    expect((await SubagentIsolation.decide({ vcs: undefined, writes: true, directory: plain })).mode).toBe("shared")
    expect(
      (await SubagentIsolation.decide({ configured: "shared", vcs: "git", writes: true, directory: root })).mode,
    ).toBe("shared")
    expect((await SubagentIsolation.decide({ vcs: "git", writes: false, directory: root })).mode).toBe("shared")
    expect((await SubagentIsolation.decide({ vcs: "git", writes: true, sandboxed: true, directory: root })).mode).toBe(
      "shared",
    )
    expect((await SubagentIsolation.decide({ vcs: "git", writes: true, directory: root })).mode).toBe("worktree")
    const unborn = await tmp("lunos-iso-unborn-")
    await sh(unborn, "init", "-q")
    expect((await SubagentIsolation.decide({ vcs: "git", writes: true, directory: unborn })).mode).toBe("shared")
  })

  test("mergeJson merges keys and refuses the same key changed two ways", () => {
    const base = '{\n    "a": 1\n}\n'
    expect(SubagentIsolation.mergeJson({ base, ours: '{\n    "a": 1,\n    "b": 2\n}\n', theirs: '{\n    "a": 1,\n    "c": 3\n}\n' })).toBe(
      '{\n    "a": 1,\n    "b": 2,\n    "c": 3\n}\n',
    )
    expect(SubagentIsolation.mergeJson({ base, ours: '{ "a": 2 }', theirs: '{ "a": 3 }' })).toBeUndefined()
  })

  test("remap moves the user's absolute paths into the worktree", () => {
    expect(SubagentIsolation.remap("/repo/src/a.ts", "/repo", "/wt")).toBe("/wt/src/a.ts")
    expect(SubagentIsolation.remap("cd /repo && bun test /repo/x", "/repo", "/wt")).toBe("cd /wt && bun test /wt/x")
    expect(SubagentIsolation.remap("/repository/a", "/repo", "/wt")).toBe("/repository/a")
    expect(SubagentIsolation.remap("/repo", "/repo", "/wt")).toBe("/wt")
  })
})
