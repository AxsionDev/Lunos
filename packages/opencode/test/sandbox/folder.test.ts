// XCOD-282: the sandbox in a folder that isn't a git repository. Lunos keeps a private "shadow" git
// dir for it under its state and writes nothing into the folder; the results stay there until
// `lunos sandbox apply`. Docker is a fake `docker` script on PATH (as in lockout.test.ts), and the
// sandbox server a local stub: no daemon, no model.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { Sandbox } from "../../src/sandbox"
import { SandboxConfig } from "../../src/sandbox/config"
import { SandboxGit } from "../../src/sandbox/git"
import type { SandboxError } from "../../src/sandbox/error"
import { SandboxPreflight } from "../../src/sandbox/preflight"
import { checkLines } from "../../src/cli/cmd/sandbox"
import { handedBack } from "../../src/agent/unattended"
import { tmpdir } from "../fixture/fixture"

// The fake docker is a shell script: not on a Windows runner.
const posixOnly = process.platform === "win32"

/** Every file under `dir` with a hash of its bytes: what "nothing was written into it" compares. */
async function listing(dir: string) {
  const out: Record<string, string> = {}
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name)
    const key = path.relative(dir, file)
    out[key] = entry.isFile()
      ? createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex")
      : "dir"
  }
  return out
}

/** What `promise` was rejected with; fails the test when it wasn't. */
async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error as SandboxError,
  )
  if (!error) throw new Error("expected a rejection")
  return error
}

const bytes = async (file: string) => new Uint8Array(await fs.readFile(file))

/** A folder of documents: binary files with NULs and CRLFs, and a .gitattributes that would convert them. */
async function documents(root: string) {
  const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 13, 10, 10, 13, ...randomBytes(2048)])
  const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\r\n"), 0, 255, 13, 10, ...randomBytes(1024)])
  await Bun.write(path.join(root, "notes.docx"), docx)
  await Bun.write(path.join(root, "report.pdf"), pdf)
  await Bun.write(path.join(root, "crlf.txt"), "one\r\ntwo\r\n")
  await Bun.write(path.join(root, "lf.txt"), "one\ntwo\n")
  // Hostile: would turn line endings into CRLF on checkout, and every file into an LFS pointer.
  await Bun.write(path.join(root, ".gitattributes"), "* text eol=crlf\n*.docx filter=lfs diff=lfs merge=lfs\n")
  await Bun.write(path.join(root, ".gitignore"), "secret.txt\n")
  await Bun.write(path.join(root, "secret.txt"), "not for the sandbox\n")
  await Bun.write(path.join(root, "node_modules", "x", "index.js"), "module.exports = 1\n")
  await Bun.write(path.join(root, "sub", "a.md"), "# a\n")
  return { docx, pdf }
}

let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_TEST_ASSUME_DIFFERENT_OWNER: process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER,
    FAKE_STATE: process.env.FAKE_STATE,
    FAKE_PORT: process.env.FAKE_PORT,
  }
})
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Windows' default core.autocrlf=true in a global git config, which must not reach the folder's bytes. */
async function autocrlf(dir: string) {
  const file = path.join(dir, "global.gitconfig")
  await Bun.write(file, "[core]\n\tautocrlf = true\n")
  process.env.GIT_CONFIG_GLOBAL = file
}

describe("where a sandbox starts from", () => {
  test("a folder that isn't a repository is a plain folder, located without writing anything", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "a.txt"), "a\n")
    const before = await listing(tmp.path)
    expect(await SandboxGit.locate(tmp.path)).toEqual({
      source: "folder",
      root: await fs.realpath(tmp.path),
      relative: "",
    })
    expect(await listing(tmp.path)).toEqual(before)
  })

  test("a repository with no commits is copied as a folder, from its top", async () => {
    await using tmp = await tmpdir()
    await $`git init -q`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "src", "a.txt"), "a\n")
    const found = await SandboxGit.locate(path.join(tmp.path, "src"))
    expect(found).toEqual({ source: "folder", root: await fs.realpath(tmp.path), relative: "src" })
    expect(Sandbox.workdirOf(found.relative)).toBe(`${Sandbox.SandboxDocker.WORKSPACE}/src`)
  })

  test("a repository with commits is unchanged: git mode", async () => {
    await using tmp = await tmpdir({ git: true })
    const found = await SandboxGit.locate(tmp.path)
    expect(found.source).toBe("git")
    const repo = await SandboxGit.repo(tmp.path)
    expect(repo.source).toBe("git")
    expect(repo.gitDir).toBe(await fs.realpath(path.join(tmp.path, ".git")))
  })

  test("a repository git refuses (dubious ownership) stays an error with the safe.directory fix, never a folder", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "a\n")
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1"
    const error = await rejection(SandboxGit.repo(tmp.path))
    expect(error.reason).toContain("belongs to another user")
    expect(error.fix).toContain("git config --global --add safe.directory")
    // Nothing went to a shadow.
    expect(await fs.readdir(path.dirname(SandboxGit.shadowDir(tmp.path))).catch(() => [])).not.toContain(
      path.basename(SandboxGit.shadowDir(await fs.realpath(tmp.path))),
    )
  })

  test("a git failure with no message is an error, not a plain folder", () => {
    const error = SandboxGit.notARepo("/work", { code: 128, stdout: "", stderr: "" }, ["git", "rev-parse"])
    expect(error.reason).toBe("Git couldn't read the repository at /work")
    expect(SandboxGit.plainFolder({ code: 128, stdout: "", stderr: "" })).toBe(false)
    expect(
      SandboxGit.plainFolder({
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      }),
    ).toBe(true)
  })
})

describe("a folder's copy", () => {
  test("is byte for byte, honours .gitignore and the default excludes, and writes nothing into the folder", async () => {
    await using tmp = await tmpdir()
    await using scratch = await tmpdir()
    await autocrlf(scratch.path)
    const { docx, pdf } = await documents(tmp.path)
    const before = await listing(tmp.path)

    const repo = await SandboxGit.repo(tmp.path, { id: "copytest" })
    expect(repo.source).toBe("folder")
    expect(repo.gitDir).toBe(SandboxGit.shadowDir(await fs.realpath(tmp.path)))
    expect(repo.survey?.files).toBe(7)
    const seed = path.join(scratch.path, "ws")
    await SandboxGit.seed({ ...repo, into: seed, branch: "lunos/sandbox/copytest" })
    expect(await bytes(path.join(seed, "notes.docx"))).toEqual(docx)
    expect(await bytes(path.join(seed, "report.pdf"))).toEqual(pdf)
    expect(await Bun.file(path.join(seed, "crlf.txt")).text()).toBe("one\r\ntwo\r\n")
    expect(await Bun.file(path.join(seed, "lf.txt")).text()).toBe("one\ntwo\n")
    expect(await Bun.file(path.join(seed, "sub", "a.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(seed, "secret.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(seed, "node_modules", "x", "index.js")).exists()).toBe(false)

    // The folder gained nothing: no .git, no .opencode, not a byte changed.
    expect(await listing(tmp.path)).toEqual(before)
  })

  test("a .gitignore can bring back a default exclude", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "bin", "run.sh"), "echo hi\n")
    await Bun.write(path.join(tmp.path, "dist", "out.js"), "x\n")
    await Bun.write(path.join(tmp.path, ".gitignore"), "!bin/\n")
    const repo = await SandboxGit.repo(tmp.path)
    const files = (await $`git --git-dir ${repo.gitDir} ls-tree -r --name-only ${repo.base}`.text()).split("\n")
    expect(files).toContain("bin/run.sh")
    expect(files).not.toContain("dist/out.js")
  })

  test("a folder holding another repository is refused, naming it; an ignored one isn't", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "a.txt"), "a\n")
    await $`git init -q inner && git -C inner -c user.name=t -c user.email=t@t commit -q --allow-empty -m x`
      .cwd(tmp.path)
      .quiet()
    await $`git init -q node_modules/dep`.cwd(tmp.path).quiet()
    const error = await rejection(SandboxGit.repo(tmp.path))
    expect(error.reason).toContain("holds other git repositories (inner/)")
    expect(error.reason).toContain("empty folders")
    expect(error.fix).toContain(".gitignore")
    // The doctor sees it too, before a start.
    await expect(SandboxGit.surveyFolder(await fs.realpath(tmp.path))).rejects.toThrow("inner/")

    await Bun.write(path.join(tmp.path, ".gitignore"), "inner/\n")
    const repo = await SandboxGit.repo(tmp.path)
    expect(repo.survey?.files).toBe(2)
  })

  test("a folder over the file or size cap fails fast with N files / X GB: add a .gitignore", async () => {
    await using tmp = await tmpdir()
    for (const name of ["a", "b", "c"]) await Bun.write(path.join(tmp.path, `${name}.txt`), "x".repeat(1024 * 1024))
    const files = await rejection(SandboxGit.repo(tmp.path, { limits: { files: 2, bytes: 1024 ** 3 } }))
    expect(files.reason).toContain("is too big to copy into the sandbox: 3 files (the limit is 2 files / 1.0 GB)")
    expect(files.fix).toContain("Add a .gitignore")
    const size = await rejection(SandboxGit.repo(tmp.path, { limits: { files: 100, bytes: 2 * 1024 * 1024 } }))
    expect(size.reason).toContain("3 files / over 2 MB")
    // Nothing was committed: the cap is checked before git reads a file.
    const shadow = SandboxGit.shadowDir(await fs.realpath(tmp.path))
    expect((await $`git --git-dir ${shadow} rev-list --all`.text()).trim()).toBe("")
  })
})

describe("lunos sandbox apply", () => {
  /** A folder sandbox's result, as a handoff leaves it: on the shadow's branch, with its base ref. */
  async function handedOff(root: string, id: string, edit: (workspace: string) => Promise<void>) {
    const repo = await SandboxGit.repo(root, { id })
    await using scratch = await tmpdir()
    const seed = path.join(scratch.path, "ws")
    await SandboxGit.seed({ ...repo, into: seed, branch: Sandbox.branchName(id) })
    await edit(seed)
    const tree = await SandboxGit.tree({
      gitDir: repo.gitDir,
      workTree: seed,
      startTree: await SandboxGit.treeOfCommit(repo.gitDir, repo.base),
    })
    const commit = await SandboxGit.commit({ gitDir: repo.gitDir, tree, parent: repo.base, message: "agent" })
    await SandboxGit.setBranch({ gitDir: repo.gitDir, branch: Sandbox.branchName(id), commit })
    return repo
  }

  test("writes the agent's files back byte for byte and deletes what it deleted; twice is harmless", async () => {
    await using tmp = await tmpdir()
    await using scratch = await tmpdir()
    await autocrlf(scratch.path)
    await documents(tmp.path)
    const edited = new Uint8Array([0, 13, 10, 255, ...randomBytes(512)])
    await handedOff(tmp.path, "apply1", async (ws) => {
      await Bun.write(path.join(ws, "notes.docx"), edited)
      await Bun.write(path.join(ws, "new", "chart.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]))
      await fs.rm(path.join(ws, "sub", "a.md"))
    })
    // The user changed a file the agent didn't touch: that's fine.
    await Bun.write(path.join(tmp.path, "lf.txt"), "mine\n")

    const applied = await Sandbox.apply("apply1")
    expect(applied.written.sort()).toEqual(["new/chart.png", "notes.docx"])
    expect(applied.deleted).toEqual(["sub/a.md"])
    expect(await bytes(path.join(tmp.path, "notes.docx"))).toEqual(edited)
    expect(await bytes(path.join(tmp.path, "new", "chart.png"))).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    )
    expect(await Bun.file(path.join(tmp.path, "sub", "a.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(tmp.path, "lf.txt")).text()).toBe("mine\n")
    expect(await Bun.file(path.join(tmp.path, "secret.txt")).text()).toBe("not for the sandbox\n")
    expect(await Bun.file(path.join(tmp.path, ".git")).exists()).toBe(false)
    expect((await fs.readdir(tmp.path)).includes(".git")).toBe(false)

    const again = await Sandbox.apply("apply1")
    expect(again.written).toEqual([])
    expect(again.deleted).toEqual([])
    expect(again.unchanged).toEqual([])
  })

  test("reopened and handed back again, the next apply starts from what the last one wrote", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "a.txt"), "a\n")
    await Bun.write(path.join(tmp.path, "b.txt"), "b\n")
    await Bun.write(path.join(tmp.path, "c.txt"), "c\n")
    const repo = await handedOff(tmp.path, "apply3", async (ws) => {
      await Bun.write(path.join(ws, "a.txt"), "agent a 1\n")
      await Bun.write(path.join(ws, "c.txt"), "agent c\n")
    })
    // You already copied c.txt across by hand: it's left alone.
    await Bun.write(path.join(tmp.path, "c.txt"), "agent c\n")
    const first = await Sandbox.apply("apply3")
    expect(first.written).toEqual(["a.txt"])
    expect(first.unchanged).toEqual(["c.txt"])

    // `lunos sandbox attach`: the agent changes a.txt again (and b.txt), and the branch advances.
    const branch = Sandbox.branchName("apply3")
    const previous = (await SandboxGit.branchHead(repo.gitDir, branch))!
    // The workspace as the reopened sandbox has it: the first result.
    await using seed = await tmpdir()
    await $`git --git-dir ${repo.gitDir} archive ${previous} | tar -x -f - -C ${seed.path}`.quiet()
    await Bun.write(path.join(seed.path, "a.txt"), "agent a 2\n")
    await Bun.write(path.join(seed.path, "b.txt"), "agent b\n")
    const tree = await SandboxGit.tree({
      gitDir: repo.gitDir,
      workTree: seed.path,
      startTree: await SandboxGit.treeOfCommit(repo.gitDir, previous),
    })
    const commit = await SandboxGit.commit({ gitDir: repo.gitDir, tree, parent: previous, message: "agent again" })
    await SandboxGit.setBranch({ gitDir: repo.gitDir, branch, commit, expected: previous })

    // a.txt holds what the first apply wrote: that's not a change of yours.
    const second = await Sandbox.apply("apply3")
    expect(second.written.sort()).toEqual(["a.txt", "b.txt"])
    expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("agent a 2\n")
    expect(await Bun.file(path.join(tmp.path, "b.txt")).text()).toBe("agent b\n")
  })

  test("refuses, writing nothing, when you changed a file the agent changed since the sandbox started", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "a.txt"), "a\n")
    await Bun.write(path.join(tmp.path, "b.txt"), "b\n")
    await handedOff(tmp.path, "apply2", async (ws) => {
      await Bun.write(path.join(ws, "a.txt"), "agent a\n")
      await Bun.write(path.join(ws, "b.txt"), "agent b\n")
    })
    await Bun.write(path.join(tmp.path, "b.txt"), "user b\n")
    const before = await listing(tmp.path)
    await expect(Sandbox.apply("apply2")).rejects.toThrow(
      "Nothing was written: since the sandbox started you changed a file the agent also changed (b.txt)",
    )
    expect(await listing(tmp.path)).toEqual(before)
  })

  test('a folder sandbox belongs to its folder, which the project layer sees as worktree "/"', () => {
    expect(Sandbox.belongs({ root: "/docs", source: "folder" }, "/", "/docs")).toBe(true)
    expect(Sandbox.belongs({ root: "/docs", source: "folder" }, "/", "/other")).toBe(false)
    expect(Sandbox.belongs({ root: "/repo" }, "/repo", "/repo/src")).toBe(true)
    // A git sandbox is never matched by directory alone.
    expect(Sandbox.belongs({ root: "/repo" }, "/", "/repo")).toBe(false)
  })

  test("a sandbox with no results, or one from a git repository, says so", async () => {
    await expect(Sandbox.apply("nosuch")).rejects.toThrow("No results for sandbox nosuch")
  })

  test("the folder-mode result line is what an unattended run records", () => {
    expect(
      handedBack(
        "sandbox results kept for /docs (not a git repository): \x1b[1mlunos sandbox apply ab12\x1b[0m writes them into it",
      ),
    ).toBe("lunos sandbox apply ab12")
  })
})

/**
 * A fake `docker` that keeps what `run -i` is fed (the seed) under FAKE_STATE, and hands it back
 * for `docker cp <container>:/workspace -`: the copy in and out run for real, only the container
 * is missing.
 */
async function fakeDocker() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-fake-docker-"))
  const script = `#!/bin/sh
S="$FAKE_STATE"
case "$1" in
  --version) echo "Docker version 27.3.1, build ce12230"; exit 0 ;;
  info) echo "27.3.1|linux"; exit 0 ;;
  image) echo "sha256:feed|[]"; exit 0 ;;
  run)
    case " $* " in
      *" -i "*) n=$(ls -d "$S"/run* 2>/dev/null | wc -l | tr -d ' '); mkdir -p "$S/run$n/workspace"; tar -x -f - -C "$S/run$n/workspace"; exit $? ;;
    esac
    exit 0 ;;
  exec) cat >/dev/null; exit 0 ;;
  port) echo "127.0.0.1:$FAKE_PORT"; exit 0 ;;
  cp) case "$2" in */workspace) tar -c -f - -C "$S/run0" workspace; exit $? ;; esac; exit 1 ;;
  container) case "$*" in *egress*) exit 1 ;; esac; exit 0 ;;
esac
exit 0
`
  await Bun.write(path.join(dir, "docker"), script)
  await fs.chmod(path.join(dir, "docker"), 0o755)
  return dir
}

describe.skipIf(posixOnly)("a sandbox in a plain folder, end to end (fake docker)", () => {
  test("doctor passes; start, hand back, destroy and apply; the folder gains nothing until apply", async () => {
    await using tmp = await tmpdir()
    await using state = await tmpdir()
    await using scratch = await tmpdir()
    await autocrlf(scratch.path)
    const { docx, pdf } = await documents(tmp.path)
    const before = await listing(tmp.path)
    process.env.PATH = [await fakeDocker(), "/usr/bin", "/bin"].join(path.delimiter)
    process.env.FAKE_STATE = state.path
    await using server = Bun.serve({ port: 0, fetch: () => Response.json([]) })
    process.env.FAKE_PORT = String(server.port)

    const checks = await SandboxPreflight.run({ directory: tmp.path, full: true })
    expect(checks.filter((check) => check.status !== "pass")).toEqual([])
    const printed = checks.flatMap(checkLines).join("\n")
    expect(printed).toContain("pass  git installed: git version")
    expect(printed).toMatch(/pass {2}workspace: plain folder \(7 files, 4 KB\)/)

    const config = { ...SandboxConfig.load(tmp.path), network: "open" as const, on_finish: "destroy" as const }
    const lines: string[] = []
    const info = await Sandbox.create({ directory: tmp.path, config, log: (line) => lines.push(line) })
    expect(info.source).toBe("folder")
    expect(info.directory).toBe(Sandbox.SandboxDocker.WORKSPACE)
    expect(lines.join("\n")).toContain("(7 files, 4 KB; it isn't a git repository)")
    const workspace = path.join(state.path, "run0", "workspace")
    expect(await bytes(path.join(workspace, "notes.docx"))).toEqual(docx)
    expect(await bytes(path.join(workspace, "report.pdf"))).toEqual(pdf)
    expect(await Bun.file(path.join(workspace, "crlf.txt")).text()).toBe("one\r\ntwo\r\n")
    expect(await Bun.file(path.join(workspace, "node_modules", "x", "index.js")).exists()).toBe(false)
    expect(await listing(tmp.path)).toEqual(before)

    // The agent edits a document inside the sandbox.
    const edited = new Uint8Array([...docx.slice(0, 100), 0, 13, 10, ...randomBytes(64)])
    await Bun.write(path.join(workspace, "notes.docx"), edited)
    await Bun.write(path.join(workspace, "summary.md"), "# summary\r\n")

    const conn = await Sandbox.start(info, { timeoutMs: 5000 })
    const result = await Sandbox.handoff(info, conn)
    expect(result.source).toBe("folder")
    expect(result.files).toEqual([
      { status: "M", path: "notes.docx" },
      { status: "A", path: "summary.md" },
    ])
    expect(result.results).toBe(Sandbox.resultsDir(info))
    expect(result.results.startsWith(tmp.path)).toBe(false)
    expect(await Bun.file(path.join(result.results, "summary.json")).exists()).toBe(true)
    // Handed back, the results are still not in the folder.
    expect(await listing(tmp.path)).toEqual(before)

    // on_finish "destroy" removes the sandbox and its metadata; apply still works.
    expect(await Sandbox.finish(info, { failed: false })).toBe("destroyed")
    await expect(Sandbox.meta(info.id)).rejects.toThrow()
    const applied = await Sandbox.apply(info.id)
    expect(applied.written.sort()).toEqual(["notes.docx", "summary.md"])
    expect(await bytes(path.join(tmp.path, "notes.docx"))).toEqual(edited)
    expect(await Bun.file(path.join(tmp.path, "summary.md")).text()).toBe("# summary\r\n")
    expect(await bytes(path.join(tmp.path, "report.pdf"))).toEqual(pdf)
    expect((await fs.readdir(tmp.path)).includes(".git")).toBe(false)
    expect((await fs.readdir(tmp.path)).includes(".opencode")).toBe(false)
  })

  test("without git installed the doctor says so, with the fix, and skips the workspace", async () => {
    await using tmp = await tmpdir()
    const fake = await fakeDocker()
    // Only the fake docker: no git anywhere on PATH.
    process.env.PATH = fake
    const checks = await SandboxPreflight.run({ directory: tmp.path, full: false })
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]))
    expect(byName["git installed"].status).toBe("fail")
    expect(byName["git installed"].fix).toContain("Install Git")
    expect(byName["workspace"].status).toBe("skip")
  })
})
