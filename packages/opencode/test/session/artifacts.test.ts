import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { SessionArtifacts } from "../../src/session/artifacts"
import { tmpdir } from "../fixture/fixture"

// XCOD-84: artifacts are found where Session.plan/research/devcycle write them.
describe("SessionArtifacts.list", () => {
  test("lists plans, research and dev-cycle records newest first, titled by their first heading", async () => {
    await using tmp = await tmpdir()
    const write = async (dir: string, name: string, body: string) => {
      await fs.mkdir(path.join(tmp.path, ".opencode", dir), { recursive: true })
      await fs.writeFile(path.join(tmp.path, ".opencode", dir, name), body)
    }
    await write("plans", "200-quiet-river.md", "# Plan: add retry\n")
    await write("research", "300-brave-owl.md", "no heading here\n")
    await write("dev-cycle", "100-calm-lake.md", "## Dev cycle\n")
    await write("plans", "notes.txt", "ignored")
    await write("plans", "not-an-artifact.md", "ignored: no timestamp prefix")
    const instance = { worktree: tmp.path, project: { vcs: "git" } } as any
    const items = await SessionArtifacts.list(instance)
    expect(items.map((item) => [item.kind, item.title, item.created])).toEqual([
      ["research", "brave-owl", 300],
      ["plan", "Plan: add retry", 200],
      ["dev-cycle", "Dev cycle", 100],
    ])
    expect((await SessionArtifacts.list(instance, "plan")).map((item) => item.kind)).toEqual(["plan"])
  })

  test("an empty project lists nothing", async () => {
    await using tmp = await tmpdir()
    expect(await SessionArtifacts.list({ worktree: tmp.path, project: { vcs: "git" } } as any)).toEqual([])
  })
})
