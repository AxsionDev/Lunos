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

describe("FSUtil.onDiskCase", () => {
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
