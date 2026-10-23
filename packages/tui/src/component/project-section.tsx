// XCOD-306: the sidebar's Project section. When the session counts in a project (a named one, or
// its repository), it shows everything defined for it, read-only, with a Settings button for the
// project's own configuration. The project's theme follows the active session (useProjectTheme).
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { ResourceItem, SettingsSnapshot } from "@opencode-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSandbox } from "../context/sandbox"
import { useTuiPaths } from "../context/runtime"
import { abbreviateHome } from "../runtime"
import { useBudget } from "./budget-meter"
import * as Section from "../util/project-section"
import * as ProjectTheme from "../util/project-theme"
import type { ProjectRef } from "../util/project-theme"

/** Bumped after a project setting is saved, so the section and the theme read it again. */
const [version, setVersion] = createSignal(0)
export const projectSettingsChanged = () => setVersion((value) => value + 1)

/**
 * The project a session counts in, with what's defined for it: its named project (if any), budgets,
 * resources and the settings that apply in its folder. `rich` also loads resources (the sidebar).
 */
export function useSessionProject(
  sessionID: () => string | undefined,
  options: { rich?: boolean; directory?: () => string | undefined } = {},
) {
  const sdk = useSDK()
  const sync = useSync()
  const directory = () => {
    const id = sessionID()
    return (id ? sync.session.get(id)?.directory : undefined) ?? options.directory?.()
  }
  const budget = useBudget(sessionID)
  const [groups] = createResource(
    () => ({ directory: directory(), version: version() }),
    async (key) =>
      (
        await sdk.client.experimental.projectGroup
          .list(key.directory ? { directory: key.directory } : {})
          .catch(() => undefined)
      )?.data,
  )
  const [settings] = createResource(
    () => ({ directory: directory(), version: version() }),
    async (key): Promise<SettingsSnapshot | undefined> =>
      (await sdk.client.config.settings(key.directory ? { directory: key.directory } : {}).catch(() => undefined))
        ?.data,
  )
  const [resources] = createResource(
    () => {
      const id = sessionID()
      if (!id || !options.rich) return undefined
      return { id, turn: sync.data.message[id]?.length ?? 0, version: version() }
    },
    async (key) =>
      ((await sdk.client.resource.list({ sessionID: key.id }).catch(() => undefined))?.data ?? []) as ResourceItem[],
  )
  const ref = createMemo(() => Section.projectRef(budget(), groups()?.groups ?? []))
  const group = createMemo(() => {
    const id = ref()?.key
    return id ? groups()?.groups.find((item) => item.id === id) : undefined
  })
  /** The theme the project's tui.json sets (shared), and whether the organisation locks it. */
  const themeRow = createMemo(() => settings()?.rows.find((row) => row.key === "tui.theme"))
  const shared = createMemo(() => {
    const row = themeRow()
    return row?.source === "project" && typeof row.value === "string" ? row.value : undefined
  })
  return {
    ref,
    group,
    directory,
    budgets: () => budget()?.budgets ?? [],
    resources: () => resources() ?? [],
    settings,
    shared,
    locked: () => !!themeRow()?.locked,
  }
}

/** XCOD-306: while this session is open, the TUI shows its project's theme. */
export function useProjectTheme(sessionID: () => string | undefined, directory?: () => string | undefined) {
  const theme = useTheme()
  const project = useSessionProject(sessionID, { directory })
  createEffect(() => {
    const ref = project.ref()
    theme.setProject(ref ? { ref, shared: project.shared(), locked: project.locked() } : undefined)
  })
  onCleanup(() => theme.setProject(undefined))
  return project
}

type Colors = {
  text: unknown
  textMuted: unknown
  primary: unknown
  warning: unknown
}

/** The section as drawn, from plain data: rendered by the sidebar and by its tests. */
export function ProjectSectionView(props: {
  theme: Colors
  project: ProjectRef
  open: boolean
  line?: string
  warnings: readonly string[]
  groups: readonly Section.Group[]
  onToggle: () => void
  onSettings: () => void
  onOpen: (target: string) => void
}) {
  const fg = (value: unknown) => value as never
  return (
    <box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={fg(props.theme.primary)} onMouseDown={() => props.onToggle()} flexShrink={1}>
          {props.open ? "▼" : "▶"} <b>{Section.header(props.project)}</b>
        </text>
        <text fg={fg(props.theme.textMuted)} onMouseUp={() => props.onSettings()} flexShrink={0}>
          Settings
        </text>
      </box>
      <Show when={!props.open}>
        <text fg={fg(props.theme.textMuted)} wrapMode="none">
          {props.line ?? "no budget"}
          <Show when={props.warnings.length}>
            <span style={{ fg: fg(props.theme.warning) }}> ⚠ needs attention</span>
          </Show>
        </text>
      </Show>
      <Show when={props.open}>
        <Show when={props.warnings.length}>
          <For each={props.warnings}>{(item) => <text fg={fg(props.theme.warning)}>⚠ {item}</text>}</For>
        </Show>
        <For each={props.groups}>
          {(group) => (
            <box paddingTop={1}>
              <text fg={fg(props.theme.text)}>
                <b>{group.title}</b>
              </text>
              <For each={group.rows}>
                {(row) => (
                  <text
                    fg={fg(row.warn ? props.theme.warning : props.theme.textMuted)}
                    onMouseUp={() => row.open && props.onOpen(row.open)}
                  >
                    {row.label}{" "}
                    <span style={{ fg: fg(row.warn ? props.theme.warning : props.theme.text) }}>{row.value}</span>
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

/** The section in the sidebar, for `sessionID`. Nothing is shown before its project is known. */
export function ProjectSection(props: {
  sessionID: string
  /** Opens a detail: "project", "budget", "resources", "settings", "memory", "sandbox", "theme". */
  onOpen: (target: string, project: ReturnType<typeof useSessionProject>) => void
}) {
  const themeState = useTheme()
  const { theme } = themeState
  const kv = useKV()
  const sandbox = useSandbox()
  const paths = useTuiPaths()
  const project = useSessionProject(() => props.sessionID, { rich: true })
  const open = () => kv.get(Section.OPEN_KEY, false) === true
  const sandboxText = () => {
    const state = sandbox.state()
    // Outside a sandbox: what the settings say.
    if (!state) {
      const row = project.settings()?.rows.find((item) => item.key === "sandbox.enabled")
      return row ? (row.value === true ? "on" : "off") : undefined
    }
    if (state.status === "ready") return "on"
    if (state.status === "starting") return "starting"
    return `${state.status === "off" ? "auto-disabled" : state.status}: ${state.failure.fix ?? state.failure.reason}`
  }
  const themeInfo = () => {
    const ref = project.ref()
    const current = themeState.projectTheme()
    if (!ref || !current || current.source === "global") return undefined
    return { name: current.theme, source: ProjectTheme.SOURCE_LABEL[current.source] }
  }
  const groups = createMemo(() => {
    const ref = project.ref()
    if (!ref) return []
    return Section.groups({
      ref,
      group: project.group(),
      directory: project.directory() ?? "",
      budgets: project.budgets(),
      resources: project.resources(),
      rows: project.settings()?.rows ?? [],
      sandbox: sandboxText(),
      theme: themeInfo(),
      short: (folder) => abbreviateHome(folder, paths.home),
    })
  })
  return (
    <Show when={project.ref()}>
      {(ref) => (
        <ProjectSectionView
          theme={theme}
          project={ref()}
          open={open()}
          line={(() => {
            const top = Section.headline(project.budgets())
            return top ? Section.budgetLine(top) : undefined
          })()}
          warnings={Section.warnings({ budgets: project.budgets(), resources: project.resources() })}
          groups={groups()}
          onToggle={() => kv.set(Section.OPEN_KEY, !open())}
          onSettings={() => props.onOpen("settings", project)}
          onOpen={(target) => props.onOpen(target, project)}
        />
      )}
    </Show>
  )
}

/** The project's resources, read-only: name, mode and index state. */
export function DialogProjectResources(props: { list: readonly ResourceItem[]; name: string }) {
  const dialog = useDialog()
  const MODE = { always: "always", search: "search", on_demand: "on demand" } as const
  return (
    <DialogSelect<string>
      title={`Resources · ${props.name}`}
      placeholder="lunos resource add, mode and remove change them"
      options={props.list.map((item) => ({
        title: item.name,
        value: item.name,
        description: item.problem ?? item.error ?? item.state,
        footer: `${MODE[item.mode]}${item.excluded ? " · left out" : ""}`,
      }))}
      onSelect={() => dialog.clear()}
    />
  )
}
