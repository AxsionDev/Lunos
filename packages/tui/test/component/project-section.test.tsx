/** @jsxImportSource @opentui/solid */
// XCOD-306: the sidebar's Project section (collapsed, expanded, a repository with no named project,
// the warning glyph, rows opening their detail) and the theme per project (switching with the
// active session's project, the priority, an organisation's lock), rendered headlessly at 120x45.
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, Show } from "solid-js"
import { KVProvider, useKV } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { ProjectSectionView } from "../../src/component/project-section"
import * as Section from "../../src/util/project-section"
import type { ProjectRef } from "../../src/util/project-theme"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

let tmp: Awaited<ReturnType<typeof tmpdir>>
let state: string
beforeEach(async () => {
  tmp = await tmpdir()
  state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
})
afterEach(async () => {
  await tmp[Symbol.asyncDispose]()
})

const color = RGBA.fromInts(200, 200, 200)
const colors = { text: color, textMuted: color, primary: color, warning: color }
const NAMED: ProjectRef = { key: "pgrp_web", name: "Axsion web", kind: "named" }
const REPO: ProjectRef = { key: "prj_1", name: "axsion-web", kind: "repository" }
const BUDGET = {
  id: "pgrp_web",
  scope: "project" as const,
  name: "Axsion web",
  locked: false,
  currency: "EUR" as const,
  amount: 50,
  spent: 38,
  remaining: 12,
  percent: 76,
  unknown: 0,
  on_limit: "ask" as const,
  period: { key: "2026-10", label: "Oct" },
}

async function section(input: { project: ProjectRef; percent?: number; failed?: boolean }) {
  const [open, setOpen] = createSignal(false)
  const opened: string[] = []
  const budgets = [{ ...BUDGET, percent: input.percent ?? 76 }]
  const resources = input.failed
    ? [
        {
          name: "spec",
          kind: "path" as const,
          mode: "search" as const,
          scope: "shared" as const,
          target: "spec",
          readOnly: true,
          trusted: true,
          excluded: false,
          state: "",
          problem: "couldn't read it",
        },
      ]
    : []
  const groups = Section.groups({
    ref: input.project,
    group: input.project.kind === "named" ? { folders: ["/work/web"], time: { created: 0, updated: 0 } } : undefined,
    directory: "/work/web",
    budgets: input.project.kind === "named" ? budgets : [],
    resources,
    rows: [],
  })
  const app = await testRender(
    () => (
      <box width={38}>
        <ProjectSectionView
          theme={colors}
          project={input.project}
          open={open()}
          line={input.project.kind === "named" ? Section.budgetLine(budgets[0]!) : undefined}
          warnings={Section.warnings({ budgets: input.project.kind === "named" ? budgets : [], resources })}
          groups={groups}
          onToggle={() => setOpen(!open())}
          onSettings={() => opened.push("settings")}
          onOpen={(target) => opened.push(target)}
        />
      </box>
    ),
    { width: 120, height: 45 },
  )
  await app.renderOnce()
  const frame = () => app.captureCharFrame()
  const click = async (text: string) => {
    const lines = frame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    if (y < 0) throw new Error(`no "${text}" on screen:\n${frame()}`)
    await app.mockMouse.click(lines[y]!.indexOf(text), y)
    await Bun.sleep(20)
    await app.renderOnce()
  }
  return { app, frame, click, opened }
}

test("collapsed: the header and one line with the budget used; Settings opens the project's settings", async () => {
  const ui = await section({ project: NAMED })
  try {
    expect(ui.frame()).toContain("▶ Project · Axsion web")
    expect(ui.frame()).toContain("Settings")
    expect(ui.frame()).toContain("€38 of €50 · Oct")
    expect(ui.frame()).not.toContain("⚠")
    expect(ui.frame()).not.toContain("About")
    await ui.click("Settings")
    expect(ui.opened).toEqual(["settings"])
  } finally {
    ui.app.renderer.destroy()
  }
})

test("expanded: every group, and each row opens its detail", async () => {
  const ui = await section({ project: NAMED })
  try {
    await ui.click("Project · Axsion web")
    const screen = ui.frame()
    expect(screen).toContain("▼ Project · Axsion web")
    for (const text of ["About", "Folders", "Budget", "Resources", "Agent defaults", "Memory"])
      expect(screen).toContain(text)
    expect(screen).toContain("● /work/web")
    expect(screen).toContain("spent €38 of €50 · Oct (76%)")
    await ui.click("at the limit")
    await ui.click("in use")
    expect(ui.opened).toEqual(["budget", "resources"])
  } finally {
    ui.app.renderer.destroy()
  }
})

test("the warning glyph: a budget past the line, or a resource that failed to index", async () => {
  const over = await section({ project: NAMED, percent: 85 })
  try {
    // Collapsed, the glyph on the one line; expanded, what it's about.
    expect(over.frame()).toContain("€38 of €50 · Oct ⚠ needs attention")
    await over.click("Project · Axsion web")
    expect(over.frame()).toContain("⚠ Axsion web budget at 85%")
  } finally {
    over.app.renderer.destroy()
  }
  const failed = await section({ project: NAMED, failed: true })
  try {
    expect(failed.frame()).toContain("⚠ needs attention")
    await failed.click("Project · Axsion web")
    expect(failed.frame()).toContain("⚠ 1 resource failed to index")
  } finally {
    failed.app.renderer.destroy()
  }
})

test('a repository with no named project: "Repository: <name>" and the groups that apply', async () => {
  const ui = await section({ project: REPO })
  try {
    expect(ui.frame()).toContain("▶ Repository: axsion-web")
    expect(ui.frame()).toContain("no budget")
    await ui.click("Repository: axsion-web")
    expect(ui.frame()).toContain("About")
    expect(ui.frame()).not.toContain("Folders")
    expect(ui.frame()).not.toContain("Budget")
  } finally {
    ui.app.renderer.destroy()
  }
})

/** The theme context as the app has it, with the real kv.json. */
async function themed() {
  let theme!: ReturnType<typeof useTheme>
  let kv!: ReturnType<typeof useKV>
  function Probe() {
    theme = useTheme()
    kv = useKV()
    return <text>shown {theme.shown}</text>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <KVProvider>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <Gate>
              <ThemeProvider mode="dark">
                <Probe />
              </ThemeProvider>
            </Gate>
          </TuiConfigProvider>
        </KVProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 45 },
  )
  const frame = () => app.captureCharFrame()
  const wait = async (text: string) => {
    const start = Date.now()
    while (!frame().includes(text)) {
      if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${text}; screen:\n${frame()}`)
      await app.renderOnce()
      await Bun.sleep(10)
    }
  }
  await wait("shown catppuccin")
  /** kv.json once its pending write has landed. */
  const file = async () => {
    await Bun.sleep(50)
    return Bun.file(path.join(state, "kv.json")).json()
  }
  return { app, theme: () => theme, kv: () => kv, wait, file }
}

/** The theme context reads kv.json once it's loaded, as the app waits for it. */
function Gate(props: { children: any }) {
  const kv = useKV()
  return <Show when={kv.ready}>{props.children}</Show>
}

test("theme per project: switches with the session's project, and back; yours > shared > global", async () => {
  const ui = await themed()
  try {
    const theme = ui.theme()
    // Just me for Axsion web, kept in kv.json (never the repository).
    theme.setPersonal(NAMED.key, "dracula")
    expect((await ui.file())[`project_theme:${NAMED.key}`]).toBe("dracula")
    // A session in Axsion web opens: its theme at once.
    theme.setProject({ ref: NAMED, shared: "nord" })
    await ui.wait("shown dracula")
    expect(theme.projectTheme()).toEqual({ theme: "dracula", source: "personal" })
    // A session in another project with only a shared theme.
    theme.setProject({ ref: REPO, shared: "nord" })
    await ui.wait("shown nord")
    expect(theme.projectTheme()?.source).toBe("shared")
    // A project with neither: the global theme.
    theme.setProject({ ref: { key: "prj_2", name: "other", kind: "repository" } })
    await ui.wait("shown catppuccin")
    // Leaving every project's session: the global theme, which never changed.
    theme.setProject({ ref: NAMED })
    await ui.wait("shown dracula")
    theme.setProject(undefined)
    await ui.wait("shown catppuccin")
    expect(theme.selected).toBe("catppuccin")
    expect((await ui.file()).theme).toBeUndefined()
  } finally {
    ui.app.renderer.destroy()
  }
})

test("theme per project: an organisation's lock overrides it; a preview shows over everything", async () => {
  const ui = await themed()
  try {
    const theme = ui.theme()
    theme.setPersonal(NAMED.key, "dracula")
    theme.setProject({ ref: NAMED, shared: "nord", locked: true })
    await Bun.sleep(30)
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).toContain("shown catppuccin")
    expect(theme.projectTheme()?.source).toBe("locked")
    theme.preview("nord")
    await ui.wait("shown nord")
    theme.preview(undefined)
    await ui.wait("shown catppuccin")
  } finally {
    ui.app.renderer.destroy()
  }
})
