import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"

// XCOD-100: macOS's default filesystem (and Windows) ignore case. On a case-sensitive
// filesystem a wrong-case spelling is a different, missing path, so those tests are skipped.
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lunos-case-")))
const CASE_INSENSITIVE = existsSync(root.toUpperCase()) && existsSync(root.toLowerCase())
const insensitive = CASE_INSENSITIVE && process.platform !== "win32" ? test : test.skip

mkdirSync(path.join(root, "Project", "Src"), { recursive: true })
writeFileSync(path.join(root, "Project", "Src", "Main.ts"), "")
symlinkSync(path.join(root, "Project"), path.join(root, "Alias"))

afterAll(() => rmSync(root, { recursive: true, force: true }))

// On Windows onDiskCase defers to normalizePath (realpath.native), which also expands 8.3 short
// names such as RUNNER~1; normalizePath has its own tests.
describe.skipIf(process.platform === "win32")("FSUtil.onDiskCase", () => {
  test("leaves a correctly spelled path alone", () => {
    const file = path.join(root, "Project", "Src", "Main.ts")
    expect(FSUtil.onDiskCase(file)).toBe(file)
  })

  test("keeps components that don't exist yet", () => {
    const file = path.join(root, "Project", "Src", "new", "File.ts")
    expect(FSUtil.onDiskCase(file)).toBe(file)
  })

  insensitive("takes the on-disk spelling of every existing component", () => {
    expect(FSUtil.onDiskCase(path.join(root, "PROJECT", "src", "main.TS"))).toBe(
      path.join(root, "Project", "Src", "Main.ts"),
    )
  })

  insensitive("fixes the existing part and keeps a new tail as given", () => {
    expect(FSUtil.onDiskCase(path.join(root, "project", "SRC", "new", "File.ts"))).toBe(
      path.join(root, "Project", "Src", "new", "File.ts"),
    )
  })

  insensitive("fixes case without resolving symlinks", () => {
    expect(FSUtil.onDiskCase(path.join(root, "alias", "src"))).toBe(path.join(root, "Alias", "Src"))
  })
})

// XCOD-137: a model-supplied path is resolved against the instance directory, never the cwd.
describe("FSUtil.resolveOnDisk", () => {
  const project = path.join(root, "Project")

  test("resolves a relative path against the base, not the cwd", () => {
    expect(FSUtil.resolveOnDisk(project, path.join("Src", "Main.ts"))).toBe(
      FSUtil.onDiskCase(path.join(project, "Src", "Main.ts")),
    )
  })

  test("keeps an absolute path absolute", () => {
    const file = path.join(root, "Project", "Src", "Main.ts")
    expect(FSUtil.resolveOnDisk(os.homedir(), file)).toBe(FSUtil.onDiskCase(file))
  })

  // On the GitHub Windows runner the cwd (the checkout) is on D: while TEMP is on C:, so this
  // catches a driveless path picking up the cwd's drive.
  test.skipIf(process.platform !== "win32")("gives a driveless Windows path the base's drive", () => {
    const file = path.join(project, "Src", "Main.ts")
    const driveless = file
      .replace(/^[A-Za-z]:/, "")
      .replaceAll("\\", "/")
      .toLowerCase()
    expect(FSUtil.resolveOnDisk(project, driveless)).toBe(FSUtil.normalizePath(file))
  })

  test.skipIf(process.platform !== "win32")("converts a git-bash drive path before resolving", () => {
    const file = path.join(project, "Src", "Main.ts")
    const bash = "/" + file[0].toLowerCase() + file.slice(2).replaceAll("\\", "/")
    expect(FSUtil.resolveOnDisk(os.homedir(), bash)).toBe(FSUtil.normalizePath(file))
  })
})

// XCOD-149: Windows 8.3 short names in rule patterns. Simulated: this machine can't create them.
describe("FSUtil.canonicalPattern", () => {
  const disk = new Map([
    ["C:\\PROGRA~1", "C:\\Program Files"],
    ["C:\\PROGRA~1\\foo", "C:\\Program Files\\foo"],
    ["C:\\Users\\RUNNER~1\\AppData\\Local\\Temp", "C:\\Users\\runneradmin\\AppData\\Local\\Temp"],
  ])
  const windows = {
    platform: "win32",
    exists: (p: string) => disk.has(p) || [...disk.keys()].some((key) => key.startsWith(p + "\\")) || p === "C:\\",
    realpath: (p: string) => disk.get(p) ?? p,
  }

  test("expands the existing short-name prefix and keeps the glob", () => {
    expect(FSUtil.canonicalPattern("C:\\PROGRA~1\\foo\\*", windows)).toBe("C:\\Program Files\\foo\\*")
    expect(FSUtil.canonicalPattern("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\opencode\\*", windows)).toBe(
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\opencode\\*",
    )
  })

  test("a rule written short matches the long-form request path (so its allow or deny applies)", () => {
    const { Wildcard } = require("../src/util/wildcard") as typeof import("../src/util/wildcard")
    const pattern = FSUtil.canonicalPattern("C:\\PROGRA~1\\foo\\*", windows)
    expect(Wildcard.match("C:\\Program Files\\foo\\bar.txt", pattern)).toBe(true)
  })

  test("leaves everything else alone: other platforms, non-paths, nothing on disk", () => {
    expect(FSUtil.canonicalPattern("C:\\PROGRA~1\\foo\\*", { ...windows, platform: "darwin" })).toBe(
      "C:\\PROGRA~1\\foo\\*",
    )
    expect(FSUtil.canonicalPattern("*", windows)).toBe("*")
    expect(FSUtil.canonicalPattern("src/**", windows)).toBe("src/**")
    expect(FSUtil.canonicalPattern("D:\\nothing\\here\\*", { ...windows, exists: () => false })).toBe(
      "D:\\nothing\\here\\*",
    )
  })

  test("a long-name path is returned exactly as written, mixed separators included", () => {
    const home = { ...windows, exists: (p: string) => p === "C:\\Users\\runneradmin" || p === "C:" }
    expect(FSUtil.canonicalPattern("C:\\Users\\runneradmin/projects/*", home)).toBe("C:\\Users\\runneradmin/projects/*")
    expect(FSUtil.canonicalPattern("C:\\Users\\RUNNERADMIN\\*", home)).toBe("C:\\Users\\RUNNERADMIN\\*")
  })
})
