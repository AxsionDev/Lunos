import { describe, expect, test } from "bun:test"
import type { BudgetStatusItem, ResourceItem } from "@opencode-ai/sdk/v2"
import * as Section from "../../src/util/project-section"
import * as ProjectTheme from "../../src/util/project-theme"

// XCOD-306: the sidebar's Project section, the project's settings scope and the theme per project.

function budget(extra: Partial<BudgetStatusItem> = {}): BudgetStatusItem {
  return {
    id: "pgrp_web",
    scope: "project",
    name: "Axsion web",
    locked: false,
    currency: "EUR",
    amount: 50,
    spent: 38,
    remaining: 12,
    percent: 76,
    unknown: 0,
    forecast: 61,
    on_limit: "ask",
    period: { key: "2026-10", label: "Oct" },
    ...extra,
  }
}

function resource(name: string, mode: ResourceItem["mode"], extra: Partial<ResourceItem> = {}): ResourceItem {
  return {
    name,
    kind: "path",
    mode,
    scope: "shared",
    target: name,
    readOnly: true,
    trusted: true,
    excluded: false,
    state: "indexed",
    ...extra,
  }
}

const NAMED = { key: "pgrp_web", name: "Axsion web", kind: "named" } as const
const REPO = { key: "prj_123", name: "axsion-web", kind: "repository" } as const

describe("which project", () => {
  test("a named project, or the repository when the session's folder has none", () => {
    const groups = [{ id: "pgrp_web" }, { id: "prj_123", implicit: true }]
    expect(Section.projectRef({ project: { id: "pgrp_web", name: "Axsion web" } }, groups)).toEqual(NAMED)
    expect(Section.projectRef({ project: { id: "prj_123", name: "axsion-web" } }, groups)).toEqual(REPO)
    expect(Section.projectRef(undefined, groups)).toBeUndefined()
  })

  test('the header: "Project · Axsion web", or "Repository: axsion-web"', () => {
    expect(Section.header(NAMED)).toBe("Project · Axsion web")
    expect(Section.header(REPO)).toBe("Repository: axsion-web")
  })
})

describe("collapsed line", () => {
  test('the most used budget, as "€38 of €50 · Oct"', () => {
    expect(Section.budgetLine(budget())).toBe("€38 of €50 · Oct")
    expect(Section.budgetLine(budget({ spent: 12.345, currency: "USD" }))).toBe("$12.35 of $50 · Oct")
    const top = Section.headline([budget({ id: "a", percent: 10 }), budget({ id: "b", percent: 90 })])
    expect(top?.id).toBe("b")
    expect(Section.headline([])).toBeUndefined()
  })

  test("⚠ when a budget passes the warning line or a resource failed to index; nothing otherwise", () => {
    expect(Section.warnings({ budgets: [budget()], resources: [resource("docs", "always")] })).toEqual([])
    expect(
      Section.warnings({
        budgets: [budget({ percent: 82 })],
        resources: [resource("spec", "search", { problem: "couldn't read it" }), resource("wiki", "always")],
      }),
    ).toEqual(["Axsion web budget at 82%", "1 resource failed to index"])
  })
})

describe("expanded groups", () => {
  const rows = [
    { key: "model", display: "anthropic/claude", source: "project", locked: false, value: "anthropic/claude" },
    { key: "default_agent", display: "not set", source: "default", locked: false, value: undefined },
    { key: "subagent.max_parallel", display: "5", source: "project", locked: false, value: 5 },
    { key: "verify", display: "{…}", source: "project", locked: false, value: { test: "npm test" } },
    { key: "memory.enabled", display: "true", source: "user", locked: false, value: true },
    { key: "memory.scope", display: "not set", source: "default", locked: false, value: undefined },
    { key: "residency.allow", display: "eu", source: "managed", locked: true, value: ["eu"] },
  ] as const

  test("a named project shows every group from the ticket, in order, with its values", () => {
    const groups = Section.groups({
      ref: NAMED,
      group: { folders: ["/work/web", "/work/api"], time: { created: Date.UTC(2026, 9, 1), updated: 0 } },
      directory: "/work/api/src",
      budgets: [budget()],
      resources: [
        resource("a", "always", { tokens: 3000 }),
        resource("b", "always", { tokens: 3100 }),
        resource("c", "search"),
        resource("d", "on_demand"),
      ],
      rows,
      sandbox: "on",
      theme: { name: "dracula", source: "just you, this project" },
    })
    expect(groups.map((group) => group.title)).toEqual([
      "About",
      "Folders",
      "Budget",
      "Resources",
      "Agent defaults",
      "Memory",
      "Sandbox",
      "Policy",
      "Theme",
    ])
    const text = (title: string) =>
      groups
        .find((group) => group.title === title)!
        .rows.map((row) => `${row.label} ${row.value}`)
        .join(" | ")
    expect(text("About")).toBe("name Axsion web | kind named project, on this computer | created 2026-10-01")
    // The current folder is marked.
    expect(text("Folders")).toBe("  /work/web | ● /work/api")
    expect(text("Budget")).toBe("spent €38 of €50 · Oct (76%) | remaining €12 · forecast €61 | at the limit ask")
    expect(text("Resources")).toBe("in use 2 always · 1 search · 1 on demand · 6.1k tokens")
    expect(text("Agent defaults")).toBe("agent build | model anthropic/claude | parallel subagents 5 | verification on")
    expect(text("Memory")).toBe("memory on | project scope on")
    expect(text("Sandbox")).toBe("sandbox on")
    expect(text("Policy")).toBe("🔒 residency.allow = eu")
    expect(text("Theme")).toBe("just you, this project dracula")
    // Each row opens its detail.
    expect(groups.find((group) => group.title === "Budget")!.rows.every((row) => row.open === "budget")).toBe(true)
    expect(groups.find((group) => group.title === "Resources")!.rows[0]!.open).toBe("resources")
  })

  test("a repository with nothing set: only the groups that apply", () => {
    const groups = Section.groups({ ref: REPO, directory: "/work/web", budgets: [], resources: [], rows: [] })
    expect(groups.map((group) => group.title)).toEqual(["About", "Resources", "Agent defaults", "Memory"])
    expect(groups[0]!.rows.map((row) => row.value)).toEqual(["axsion-web", "repository"])
    expect(groups[1]!.rows[0]!.value).toBe("none")
  })

  test("a failed resource and a budget past the line are flagged in their rows", () => {
    const groups = Section.groups({
      ref: NAMED,
      directory: "/w",
      budgets: [budget({ percent: 101 })],
      resources: [resource("spec", "search", { error: "timeout" })],
      rows: [],
    })
    expect(groups.find((group) => group.title === "Budget")!.rows[0]!.warn).toBe(true)
    expect(groups.find((group) => group.title === "Resources")!.rows[0]).toMatchObject({
      value: "1 search · 1 failed",
      warn: true,
    })
  })
})

describe("Settings › Project", () => {
  test("offers only keys a project can set", () => {
    for (const key of [
      "model",
      "default_agent",
      "subagent.max_parallel",
      "verify.test",
      "memory.scope",
      "sandbox.enabled",
      "instructions",
      "mcp",
      "budget.on_limit",
      "tui.theme",
    ])
      expect(`${key} ${Section.projectScoped(key)}`).toBe(`${key} true`)
    for (const key of ["autoupdate", "share", "provider", "tui.mouse", "username", "residency.allow", "memory.backend"])
      expect(`${key} ${Section.projectScoped(key)}`).toBe(`${key} false`)
  })

  test("keys a repository can't set are yours only, with why", () => {
    expect(Section.personalOnly("sandbox.allow")).toContain("not a repository's")
    expect(Section.personalOnly("sandbox.mounts")).toContain("not a repository's")
    expect(Section.personalOnly("sandbox.enabled")).toBeUndefined()
    expect(Section.personalOnly("model")).toBeUndefined()
  })
})

describe("theme per project", () => {
  const has = (name: string) => ["catppuccin", "dracula", "nord", "corporate"].includes(name)

  test("yours for the project > the project's shared one > your global theme", () => {
    expect(
      ProjectTheme.resolveProjectTheme({ personal: "dracula", shared: "nord", global: "catppuccin", has }),
    ).toEqual({ theme: "dracula", source: "personal" })
    expect(ProjectTheme.resolveProjectTheme({ shared: "nord", global: "catppuccin", has })).toEqual({
      theme: "nord",
      source: "shared",
    })
    expect(ProjectTheme.resolveProjectTheme({ global: "catppuccin", has })).toEqual({
      theme: "catppuccin",
      source: "global",
    })
    // A theme that isn't installed here falls through to the next one.
    expect(
      ProjectTheme.resolveProjectTheme({ personal: "gone", shared: "nord", global: "catppuccin", has }).theme,
    ).toBe("nord")
  })

  test("an organisation's theme lock wins over both project themes", () => {
    expect(
      ProjectTheme.resolveProjectTheme({
        personal: "dracula",
        shared: "nord",
        global: "corporate",
        locked: true,
        has,
      }),
    ).toEqual({ theme: "corporate", source: "locked" })
  })

  test("Just me is written to this computer's kv.json only, never to the repository's config", () => {
    const mine = ProjectTheme.themeWrite("me", "pgrp_web", "dracula")
    expect(mine).toEqual({ kv: { key: "project_theme:pgrp_web", value: "dracula" } })
    expect("settings" in mine).toBe(false)
    expect(ProjectTheme.themeWrite("me", "pgrp_web", undefined)).toEqual({
      kv: { key: "project_theme:pgrp_web", value: undefined },
    })
    // Shared goes through the settings write, to the project's tui.json.
    expect(ProjectTheme.themeWrite("shared", "pgrp_web", "nord")).toEqual({
      settings: { key: "tui.theme", value: "nord", scope: "project", unset: false },
    })
    expect(ProjectTheme.themeWrite("shared", "pgrp_web", undefined)).toEqual({
      settings: { key: "tui.theme", value: "", scope: "project", unset: true },
    })
  })
})
