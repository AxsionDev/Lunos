/**
 * XCOD-306: a theme per project, so projects can be told apart at a glance. Pure, so the priority
 * and where each choice is kept are tested without a terminal.
 *
 * Priority: your own theme for the project ("Just me", kept on this computer) > the project's shared
 * theme (`theme` in the repository's tui.json) > your global theme. An organisation that locks
 * `tui.theme` fixes it for every project.
 */

/** The project a session counts in: a named project, or its repository. */
export type ProjectRef = { key: string; name: string; kind: "named" | "repository" }

/** Where "Just me" themes are kept: this computer's kv.json, never the repository. */
export const personalKey = (project: string) => `project_theme:${project}`

export type ThemeSource = "personal" | "shared" | "global" | "locked"

export function resolveProjectTheme(input: {
  personal?: string
  shared?: string
  global: string
  locked?: boolean
  has: (name: string) => boolean
}): { theme: string; source: ThemeSource } {
  if (input.locked) return { theme: input.global, source: "locked" }
  if (input.personal && input.has(input.personal)) return { theme: input.personal, source: "personal" }
  if (input.shared && input.has(input.shared)) return { theme: input.shared, source: "shared" }
  return { theme: input.global, source: "global" }
}

export const SOURCE_LABEL: Record<ThemeSource, string> = {
  personal: "just you, this project",
  shared: "shared, from the project's tui.json",
  global: "your theme for all projects",
  locked: "set by your organisation",
}

/**
 * Where a theme choice for a project is written. "me": kv.json on this computer only. "shared": the
 * project's tui.json, through the same settings write as /settings (scope project).
 */
export function themeWrite(target: "me" | "shared", project: string, theme: string | undefined) {
  if (target === "me") return { kv: { key: personalKey(project), value: theme } } as const
  return { settings: { key: "tui.theme", value: theme ?? "", scope: "project" as const, unset: theme === undefined } }
}
