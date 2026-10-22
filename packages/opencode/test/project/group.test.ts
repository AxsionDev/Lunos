import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { ProjectGroup } from "../../src/project/group"

afterEach(async () => {
  await fs.rm(ProjectGroup.file(), { force: true })
})

const repo = { id: "prj_web", worktree: "/work/axsion-web", name: "axsion-web" }

describe("ProjectGroup (XCOD-298)", () => {
  test("starts empty; a directory resolves to its repository project as an implicit group", async () => {
    expect(await ProjectGroup.list()).toEqual([])
    expect(await ProjectGroup.resolve("/work/axsion-web/src", repo)).toMatchObject({
      id: "prj_web",
      name: "axsion-web",
      folders: ["/work/axsion-web"],
      implicit: true,
    })
    expect(await ProjectGroup.resolve("/work/axsion-web/src")).toBeUndefined()
  })

  test("a plain folder's implicit group is the folder itself, not every plain folder at once", async () => {
    const global = { id: "global", worktree: "/" }
    const a = await ProjectGroup.resolve("/tmp/a", global)
    const b = await ProjectGroup.resolve("/tmp/b", global)
    expect(a?.folders).toEqual(["/tmp/a"])
    expect(a?.id).not.toBe(b?.id)
  })

  test("a named project groups several folders, on whole path segments, and the deepest folder wins", async () => {
    const web = await ProjectGroup.create({ name: "  Axsion web ", folders: ["/work/axsion-web", "/work/axsion-api"] })
    expect(web.name).toBe("Axsion web")
    expect(web.id.startsWith(ProjectGroup.PREFIX)).toBe(true)
    const infra = await ProjectGroup.create({ name: "Infra", folders: ["/work/axsion-api/infra"] })

    expect((await ProjectGroup.resolve("/work/axsion-web", repo))?.id).toBe(web.id)
    expect((await ProjectGroup.resolve("/work/axsion-api/src/x", repo))?.id).toBe(web.id)
    expect((await ProjectGroup.resolve("/work/axsion-api/infra/k8s", repo))?.id).toBe(infra.id)
    // Not a path segment of /work/axsion-web.
    expect((await ProjectGroup.resolve("/work/axsion-web2", repo))?.implicit).toBe(true)
  })

  test("rename, add, remove and archive; archived projects no longer claim their folders", async () => {
    const group = await ProjectGroup.create({ name: "A", folders: ["/work/a"] })
    expect((await ProjectGroup.rename(group.id, "B")).name).toBe("B")
    expect((await ProjectGroup.add(group.id, ["/work/b", "/work/a"])).folders).toEqual(["/work/a", "/work/b"])
    expect((await ProjectGroup.remove(group.id, ["/work/a"])).folders).toEqual(["/work/b"])
    await expect(ProjectGroup.remove(group.id, ["/work/zzz"])).rejects.toBeInstanceOf(ProjectGroup.InvalidError)

    const archived = await ProjectGroup.archive(group.id)
    expect(archived.archived).toBe(true)
    expect((await ProjectGroup.resolve("/work/b", repo))?.implicit).toBe(true)
    // Its folder can go to another project now; bringing the old one back is then refused.
    await ProjectGroup.create({ name: "C", folders: ["/work/b"] })
    await expect(ProjectGroup.archive(group.id, false)).rejects.toBeInstanceOf(ProjectGroup.InvalidError)
  })

  test("by id or name; refuses empty, duplicate names and a folder another project has", async () => {
    const group = await ProjectGroup.create({ name: "Client", folders: ["/work/c"] })
    expect((await ProjectGroup.get("client"))?.id).toBe(group.id)
    expect((await ProjectGroup.get(group.id))?.name).toBe("Client")
    await expect(ProjectGroup.create({ name: "  " })).rejects.toBeInstanceOf(ProjectGroup.InvalidError)
    await expect(ProjectGroup.create({ name: "client" })).rejects.toBeInstanceOf(ProjectGroup.InvalidError)
    await expect(ProjectGroup.create({ name: "Other", folders: ["/work/c"] })).rejects.toBeInstanceOf(
      ProjectGroup.InvalidError,
    )
    await expect(ProjectGroup.rename("pgrp_missing", "x")).rejects.toBeInstanceOf(ProjectGroup.NotFoundError)
  })

  test("a session goes with its directory, a moved session with its move, and a subagent with its parent", async () => {
    const web = await ProjectGroup.create({ name: "Web", folders: ["/work/axsion-web"] })
    const other = await ProjectGroup.create({ name: "Other", folders: [] })
    const sessions: Record<string, ProjectGroup.SessionRef> = {
      ses_parent: { id: "ses_parent", directory: "/work/axsion-web", project: repo },
      ses_child: { id: "ses_child", directory: "/elsewhere", parentID: "ses_parent" },
    }
    const parent = async (id: string) => sessions[id]
    expect((await ProjectGroup.forSession(sessions.ses_parent!, parent))?.id).toBe(web.id)
    expect((await ProjectGroup.forSession(sessions.ses_child!, parent))?.id).toBe(web.id)

    await ProjectGroup.move(["ses_parent"], other.id)
    expect((await ProjectGroup.forSession(sessions.ses_child!, parent))?.id).toBe(other.id)
    expect(await ProjectGroup.moves()).toEqual({ ses_parent: other.id })

    await ProjectGroup.move(["ses_parent"], null)
    expect((await ProjectGroup.forSession(sessions.ses_parent!, parent))?.id).toBe(web.id)
    await expect(ProjectGroup.move(["ses_parent"], "pgrp_missing")).rejects.toBeInstanceOf(ProjectGroup.NotFoundError)
  })

  test("a garbled file reads as empty", async () => {
    await fs.mkdir((await import("node:path")).dirname(ProjectGroup.file()), { recursive: true })
    await fs.writeFile(ProjectGroup.file(), "{not json")
    expect(await ProjectGroup.list()).toEqual([])
  })
})
