import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { SandboxToolchain } from "../../src/sandbox/toolchain"

describe("XCOD-344: the project's toolchain in the sandbox image", () => {
  test("marker files say what the project needs", async () => {
    await using project = await tmpdir()
    await Bun.write(path.join(project.path, "package.json"), "{}")
    await Bun.write(path.join(project.path, "pyproject.toml"), "")
    await Bun.write(path.join(project.path, "App.csproj"), "<Project/>")
    expect(SandboxToolchain.needed(project.path)).toEqual([
      { tool: "node", because: "package.json" },
      { tool: "npm", because: "package.json" },
      { tool: "python3", because: "pyproject.toml" },
      { tool: "dotnet", because: "App.csproj" },
    ])
  })

  test("an empty folder needs nothing", async () => {
    await using project = await tmpdir()
    expect(SandboxToolchain.needed(project.path)).toEqual([])
  })

  test("the probe prints only what isn't on PATH", async () => {
    const result = Bun.spawnSync(["/bin/sh", "-c", SandboxToolchain.probe(["sh", "no-such-tool-xcod344"])])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe("no-such-tool-xcod344")
  })

  test("the message names the tool, the file, and the fix", () => {
    const text = SandboxToolchain.message([
      { tool: "node", because: "package.json" },
      { tool: "npm", because: "package.json" },
    ])
    expect(text).toContain("No node and npm (for package.json) in the sandbox image")
    expect(text).toContain("Add a .devcontainer, or set sandbox.image")
    expect(SandboxToolchain.message([])).toBeUndefined()
  })
})
