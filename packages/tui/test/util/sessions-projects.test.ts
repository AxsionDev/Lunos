import { describe, expect, test } from "bun:test"
import type { SessionOverviewItem } from "@opencode-ai/sdk/v2"
import {
  NO_PROJECT_KEY,
  buildProjects,
  projectCounts,
  projectKey,
  projectSections,
  sectionItems,
  sessionsView,
  type Line,
  type NamedProject,
} from "../../src/util/sessions-overview"

// XCOD-309: the Projects view of /sessions, the Agent Monitor and the desktop/web Sessions window.

function item(id: string, extra: Partial<SessionOverviewItem> = {}): SessionOverviewItem {
  return {
    id,
    kind: "session",
    title: id,
    directory: "/work/alpha",
    project: { id: "prj_a", worktree: "/work/alpha" },
    projectGroupID: "prj_a",
    cost: 0,
    created: 1,
    updated: 1,
    state: "idle",
    permissions: 0,
    questions: 0,
    ...extra,
  }
}

const web: NamedProject = { id: "pgrp_web", name: "Axsion web", folders: ["/work/web", "/work/api"] }
const beta: NamedProject = { id: "pgrp_beta", name: "beta named", folders: ["/work/beta"] }

const summary = (lines: Line[]) =>
  lines.map((line) =>
    line.type === "project"
      ? `${line.collapsed ? "▸" : "▾"} ${line.section.name} (${line.count})${line.section.here ? " here" : ""}`
      : line.type === "session"
        ? `${line.depth ? "  ↳ " : ""}${line.item.id}`
        : `group ${line.key}`,
  )

const sessions = [
  item("alpha-old", { updated: 1 }),
  item("alpha-new", { updated: 9, state: "running" }),
  item("web-1", {
    directory: "/work/api",
    project: { id: "prj_api", worktree: "/work/api" },
    projectGroupID: "pgrp_web",
    updated: 5,
    state: "waiting",
  }),
  item("plain", {
    directory: "/tmp/scratch",
    project: { id: "global", worktree: "/" },
    projectGroupID: "global:/tmp/scratch",
    updated: 3,
    state: "finished",
  }),
  item("loose", { directory: "/elsewhere", project: undefined, projectGroupID: undefined, updated: 2 }),
]

describe("sessions view: projects", () => {
  test("named projects first (A–Z), then repositories and folders (A–Z), then No project", () => {
    const sections = projectSections({ sessions, named: [web, beta], search: "", state: "all" })
    expect(sections.map((section) => [section.name, section.kind])).toEqual([
      ["Axsion web", "named"],
      ["alpha", "folder"],
      ["scratch", "folder"],
      ["No project", "none"],
    ])
    // Empty named projects aren't listed.
    expect(sections.some((section) => section.id === beta.id)).toBe(false)
  })

  test("each section counts working, waiting and done, a parent as its most urgent subagent", () => {
    const sections = projectSections({
      sessions: [
        ...sessions,
        item("alpha-kid", { parentID: "alpha-old", state: "waiting", kind: "subagent", updated: 4 }),
      ],
      named: [web],
      search: "",
      state: "all",
    })
    const alpha = sections.find((section) => section.id === "prj_a")!
    expect(alpha.counts).toEqual({ working: 1, waiting: 1, done: 0 })
    expect(projectCounts(alpha.counts)).toBe("1 working · 1 waiting")
    expect(projectCounts({ working: 0, waiting: 0, done: 0 })).toBe("no sessions")
    expect(sectionItems(alpha).map((each) => each.id)).toEqual(["alpha-new", "alpha-old", "alpha-kid"])
  })

  test("where a new session starts: a named project's first folder, a repository's worktree, a plain folder", () => {
    const sections = projectSections({ sessions, named: [web], search: "", state: "all" })
    expect(Object.fromEntries(sections.map((section) => [section.name, section.directory]))).toEqual({
      "Axsion web": "/work/web",
      alpha: "/work/alpha",
      scratch: "/tmp/scratch",
      "No project": undefined,
    })
  })

  test("a Claude Code row with no project lands with the repository that holds its folder", () => {
    const tool = item("external:abc", {
      kind: "external",
      tool: "claude",
      directory: "/work/alpha/packages/x",
      project: undefined,
      projectGroupID: undefined,
    })
    const sections = projectSections({ sessions: [...sessions, tool], named: [web], search: "", state: "all" })
    expect(sections.find((section) => section.id === "prj_a")!.rows.map((row) => row.item.id)).toContain("external:abc")
  })

  test("the list: headers, newest first, subagents under their parent; here is open and marked", () => {
    const lines = buildProjects({
      sessions: [...sessions, item("alpha-kid", { parentID: "alpha-new", kind: "subagent", updated: 8 })],
      named: [web],
      search: "",
      state: "all",
      here: "prj_a",
      collapsed: { [projectKey("prj_a")]: true, [projectKey("pgrp_web")]: true },
    })
    expect(summary(lines)).toEqual([
      "▸ Axsion web (1)",
      "▾ alpha (2) here",
      "alpha-new",
      "  ↳ alpha-kid",
      "alpha-old",
      "▾ scratch (1)",
      "plain",
      "▾ No project (1)",
      "loose",
    ])
    expect(lines.at(-2)!.key).toBe(NO_PROJECT_KEY)
  })

  test("searching or filtering shows only matching sections, all open, and matches the project's name", () => {
    const collapsed = { [projectKey("pgrp_web")]: true }
    expect(summary(buildProjects({ sessions, named: [web], search: "axsion", state: "all", collapsed }))).toEqual([
      "▸ Axsion web (1)",
      "web-1",
    ])
    expect(summary(buildProjects({ sessions, named: [web], search: "", state: "running" }))).toEqual([
      "▾ alpha (1)",
      "alpha-new",
    ])
  })

  test("a session is in one project only, and archived-view rows group the same way", () => {
    const lines = buildProjects({ sessions, named: [web], search: "", state: "all" })
    const ids = lines.flatMap((line) => (line.type === "session" ? [line.item.id] : []))
    expect(ids.toSorted()).toEqual(sessions.map((each) => each.id).toSorted())
  })

  test("the remembered view reads back, Groups by default", () => {
    expect(sessionsView(undefined)).toBe("groups")
    expect(sessionsView("nonsense")).toBe("groups")
    expect(sessionsView("projects")).toBe("projects")
  })
})
