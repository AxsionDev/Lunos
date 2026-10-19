import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createMemo, createResource, createSignal, onMount } from "solid-js"
import type { SettingRow, SettingsSnapshot } from "@opencode-ai/sdk/v2"
import { versionDetail } from "@opencode-ai/core/installation/version"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { useRoute } from "../context/route"
import { useRenderer } from "@opentui/solid"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useBindings, useOpencodeKeymap } from "../keymap"
import { openFileInEditor } from "../editor"
import { DialogModel } from "./dialog-model"
import { useMemorySetup } from "./dialog-memory-setup"
import { MemorySetup } from "@opencode-ai/core/memory-setup"
import { DialogRecommended } from "./dialog-recommended"
import { DialogVariantSetting, useVariantModel, variantWarning } from "./dialog-variant-setting"
import { AGENTS_HELP, DialogAgentList } from "./dialog-agent-settings"
import { DialogThemeList } from "./dialog-theme-list"
import { choices as externalChoices, KEYS as EXTERNAL_KEYS, perRun } from "../util/external-permission"
import { DialogLsp } from "./dialog-lsp"
import { DialogMcp } from "./dialog-mcp"
import { DialogProviders } from "./dialog-provider"
import { StatusServers } from "./dialog-status"
import {
  AGENT_NAME,
  TABS,
  badge,
  defaultAgentWarning,
  mainAgents,
  cycle,
  editText,
  filterRows,
  formatCost,
  formatTokens,
  hasSection,
  nextTab,
  sectionLabel,
  type Tab,
} from "../util/settings"

// XCOD-128: every configuration option in one place, after Claude Code's /config. One dialog with
// three tabs (Status | Settings | Usage); /settings and /config open Settings, /status opens Status.
// The list comes from the server (GET /config/settings), which generates it from the live config
// schema, so a new key shows up here without a TUI change. Writes go through PATCH
// /config/settings: the same validation and organisation locks as `lunos settings set`.

type Scope = "user" | "project"

/** Paths under the home directory as `~/…`, so they fit an 80-column dialog. */
function home(file: string) {
  const dir = process.env.HOME
  return dir && file.startsWith(dir + "/") ? "~" + file.slice(dir.length) : file
}

const LABEL: Record<Tab, string> = { status: "Status", settings: "Settings", usage: "Usage" }

// XCOD-249: the Memory section shows the setup wizard, a status line and a collapsed "Advanced"
// holding every memory.* key. Whether Advanced is open is remembered for the session.
let memoryAdvancedOpen = false
const MEMORY = "Memory"

/**
 * `section` (XCOD-231): one structured setting's own screen, e.g. `subagent`, listing its fields
 * (`subagent.model`, …) with the same controls as the main list. ← goes back to its row there.
 */
export function DialogSettings(props: { tab?: Tab; focus?: string; scope?: Scope; section?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const themeState = useTheme()
  const { theme } = themeState
  const keymap = useOpencodeKeymap()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  const [tab, setTab] = createSignal<Tab>(props.tab ?? "settings")
  const [scope, setScope] = createSignal<Scope>(props.scope ?? "user")
  const [snapshot, setSnapshot] = createSignal<SettingsSnapshot>()
  const [error, setError] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [highlighted, setHighlighted] = createSignal<string | undefined>(props.focus)

  let list: DialogSelectRef<string> | undefined
  // XCOD-233: a save still running when Esc closed the window must not reopen it.
  const generation = dialog.generation

  async function load() {
    const result = await sdk.client.config.settings().catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (!result.data) {
      setError("Couldn't load settings from the server")
      return
    }
    setError(undefined)
    setSnapshot(result.data)
    // Back on the row that was being edited, scrolled into view.
    const focus = highlighted()
    if (focus) setTimeout(() => list?.moveTo(focus), 0)
  }

  onMount(() => {
    dialog.setSize("large")
    // XCOD-233: this is the top of the /settings window, however it was opened.
    dialog.markNav()
    void load()
  })

  const rows = createMemo(() => {
    // XCOD-215: the deprecated top-level `mode` is listed only while it's still set (Agents migrates it).
    const all = (snapshot()?.rows ?? []).filter((row) => row.key !== "mode" || row.source !== "default")
    const list = props.section ? all.filter((row) => row.key.startsWith(`${props.section}.`)) : all
    // tui.json is read by this process: show the theme actually in use.
    return list.map((row) =>
      row.key === "tui.theme" && row.source === "default"
        ? { ...row, value: themeState.selected, display: themeState.selected }
        : row,
    )
  })
  const visible = createMemo(() => filterRows(rows(), query()))
  const [advancedOpen, setAdvancedOpen] = createSignal(memoryAdvancedOpen)
  // A search lists matching memory keys as usual; collapsing is only for browsing the list.
  const collapsing = createMemo(() => !query() && !props.section && rows().some((row) => row.category === MEMORY))
  const shown = createMemo(() =>
    collapsing() && !advancedOpen() ? visible().filter((row) => row.category !== MEMORY) : visible(),
  )
  const current = createMemo(() =>
    highlighted()?.startsWith("+memory.") ? undefined : (rows().find((row) => row.key === highlighted()) ?? shown()[0]),
  )
  const memorySetup = useMemorySetup()
  const openMemorySetup = () => memorySetup({ scope: scope(), rows: rows(), onExit: () => reopen("+memory.setup") })

  // Reopens this dialog where the user left it, after a picker or prompt replaced it.
  function reopen(key?: string) {
    const section = props.section
    dialog.replace(
      () => <DialogSettings tab="settings" focus={key ?? highlighted()} scope={scope()} section={section} />,
      undefined,
      section ? { back: () => openTop(section), generation } : { nav: true, generation },
    )
  }

  /** The main list, on row `key` (from a section screen, its own row). */
  function openTop(key: string) {
    dialog.replace(() => <DialogSettings tab="settings" focus={key} scope={scope()} />, undefined, {
      nav: true,
      generation,
    })
  }

  /** XCOD-231: a structured setting whose fields are settings of their own gets a screen of them. */
  function openSection(row: SettingRow) {
    dialog.replace(
      () => <DialogSettings tab="settings" section={row.key} scope={scope()} />,
      undefined,
      backTo(row.key),
    )
  }

  const local = useLocal()
  const sync = useSync()
  // XCOD-230: the agents default_agent can name, and whether the configured one still can.
  const [agents] = createResource(async () => (await sdk.client.config.agents().catch(() => undefined))?.data)
  const agentProblem = (row: SettingRow) =>
    row.key === "default_agent" ? defaultAgentWarning(row.value, agents()) : undefined

  /** XCOD-230: new sessions start with the new default; the agent list may still be reloading. */
  function startWith(name: string, tries = 40) {
    if (sync.data.agent.some((agent) => agent.name === name)) return local.mode.set(name)
    if (tries > 0) setTimeout(() => startWith(name, tries - 1), 100)
  }

  /**
   * XCOD-230: after Clear, new sessions start with whatever the server now puts first (its default,
   * from another config layer or Lunos's own), once the reloaded agent list arrives.
   */
  function startWithDefault(before: string, tries = 40) {
    const first = local.mode.list()[0]
    // The list is reconciled in place: its order (the default first) is what shows the reload.
    const order = sync.data.agent.map((agent) => agent.name).join()
    if (first && (order !== before || tries === 0)) return local.mode.set(first.name)
    if (tries > 0) setTimeout(() => startWithDefault(before, tries - 1), 100)
  }

  /** XCOD-230: default_agent is picked from the main agents, or a new one made on the spot. */
  function pickDefaultAgent(row: SettingRow, focus?: string) {
    const current = typeof row.value === "string" ? row.value : undefined
    const choose = async (name: string | undefined) => {
      const before = sync.data.agent.map((agent) => agent.name).join()
      const ok = await save(row, name ?? "", { reopen: true, unset: name === undefined })
      if (!ok) return
      if (name) return startWith(name)
      startWithDefault(before)
    }
    dialog.replace(
      () => (
        <DialogSelect<string>
          title={row.label}
          placeholder="The agent new sessions start with"
          skipFilter
          current={focus ?? current ?? "+clear"}
          options={[
            ...mainAgents(agents() ?? []).map((agent) => ({
              title: agent.name,
              value: agent.name,
              description: agent.description,
              category: "Main agents",
            })),
            {
              title: "New agent…",
              value: "+new",
              description: "set one up and make it the default",
              category: "Actions",
            },
            { title: "Clear (use Lunos's default)", value: "+clear", category: "Actions" },
          ]}
          onSelect={(option) => {
            if (option.value === "+new") return void newDefaultAgent(row)
            void choose(option.value === "+clear" ? undefined : option.value)
          }}
        />
      ),
      undefined,
      backTo(row.key),
    )
  }

  /**
   * XCOD-256: Claude Code's permission mode and Codex's sandbox and approval policy, from a list.
   * Manual approval (the default) is selected when nothing is set and choosing it writes nothing,
   * or removes the key when one is set. Unsafe values are listed greyed and never saved.
   */
  async function pickExternal(row: SettingRow) {
    const tools = row.key.startsWith("external.claude.")
      ? (await sdk.client.experimental.external.tools().catch(() => undefined))?.data
      : undefined
    const detected = tools?.find((item) => item.tool === "claude")?.permissionModes
    const list = externalChoices(row.key, detected, row.value)
    const set = row.source !== "default" && row.source !== "env"
    const current = list.find((item) => item.value === row.value && !item.unsafe) ?? list[0]!
    dialog.replace(
      () => (
        <DialogSelect<string>
          title={row.label}
          placeholder={
            row.key.startsWith("external.claude.") && !detected
              ? "Claude Code's --help couldn't be read: common modes"
              : row.key
          }
          skipFilter
          current={current.value}
          options={list.map((item) => ({
            title: item.title,
            titleView: item.unsafe ? <span style={{ fg: theme.textMuted }}>{item.title}</span> : undefined,
            value: item.value,
            description: item.unsafe ? `${item.description}. ${perRun(item.value)}` : item.description,
            footer: item.unsafe ? "per run only" : item.default && set ? "removes the key" : undefined,
          }))}
          onSelect={(option) => {
            const item = list.find((entry) => entry.value === option.value)!
            if (item.unsafe) return toast.show({ variant: "info", message: perRun(item.value), duration: 6000 })
            if (item.default) {
              if (!set) return reopen(row.key)
              return void save(row, "", { reopen: true, unset: true })
            }
            void save(row, item.value, { reopen: true })
          }}
        />
      ),
      undefined,
      backTo(row.key),
    )
  }

  /**
   * XCOD-230: Agents' New agent flow (name, then what it does), and the new agent becomes the
   * default. Nothing is written until both are answered; ← or Esc at either step changes nothing.
   */
  async function newDefaultAgent(row: SettingRow) {
    const nav = { back: () => pickDefaultAgent(row, "+new"), generation }
    const name = (await DialogPrompt.show(dialog, "New agent", { placeholder: "name, e.g. reviewer", nav }))?.trim()
    if (!name) return pickDefaultAgent(row, "+new")
    if (!AGENT_NAME.test(name) || agents()?.some((agent) => agent.name === name)) {
      toast.show({
        variant: "error",
        message: AGENT_NAME.test(name)
          ? `There's already an agent called ${name}: pick it from the list`
          : "Use letters, digits, - and _ for the name",
      })
      return pickDefaultAgent(row, "+new")
    }
    const description = (
      await DialogPrompt.show(dialog, `${name}: what it does`, {
        placeholder: "one line, shown in the agent list",
        nav,
      })
    )?.trim()
    if (description === undefined) return pickDefaultAgent(row, "+new")
    const created = await sdk.client.config
      .settingsSet({
        settingsSetInput: { key: `agent.${name}.description`, value: description || name, scope: scope() },
      })
      .catch(() => undefined)
    if (!created?.data?.ok) {
      toast.show({
        variant: "error",
        title: `${name} not created`,
        message: created?.data && !created.data.ok ? created.data.error : "The server didn't answer",
        duration: 8000,
      })
      return reopen(row.key)
    }
    if (await save(row, name, { reopen: true })) startWith(name)
  }

  const variantFor = useVariantModel()
  /** XCOD-232: a saved variant the model it applies to doesn't have. */
  const variantProblem = (row: SettingRow) =>
    row.key === "subagent.variant" ? variantWarning(row.value, variantFor(row.key)) : undefined

  /** XCOD-233: a screen opened from row `key`; ← comes back to the list with that row highlighted. */
  const backTo = (key: string) => ({ back: () => reopen(key), generation })

  /** `unset` (XCOD-232's Clear) removes the key from the scope's file instead of setting it. */
  async function save(row: SettingRow, value: string, options: { reopen?: boolean; unset?: boolean } = {}) {
    const result = await sdk.client.config
      .settingsSet({
        settingsSetInput: { key: row.key, value, scope: scope(), ...(options.unset ? { unset: true } : {}) },
      })
      .catch((cause: unknown) => ({ data: undefined, error: cause }))
    const data = result.data
    if (!data || !data.ok) {
      toast.show({
        variant: "error",
        title: `${row.label} not saved`,
        message: data && !data.ok ? data.error : "The server didn't answer",
        duration: 8000,
      })
      if (options.reopen) reopen(row.key)
      return false
    }
    if (row.key === "tui.theme" && typeof data.value === "string") themeState.set(data.value)
    toast.show({
      variant: "success",
      message: options.unset
        ? `${row.label} ${data.changed ? "removed" : "wasn't set"} (${data.scope} config: ${home(data.file)})`
        : `${row.label} = ${typeof data.value === "string" ? data.value : JSON.stringify(data.value)} (saved to ${data.scope} config: ${home(data.file)})`,
      duration: 5000,
    })
    if (options.reopen) reopen(row.key)
    else await load()
    if (data.restart && data.changed) {
      const restart = await DialogConfirm.show(
        dialog,
        "Restart required",
        `${row.label} takes effect after a restart. Restart Lunos now?`,
        "later",
        backTo(row.key),
      )
      if (restart === true) {
        dialog.clear()
        keymap.dispatchCommand("app.restart")
        return true
      }
      reopen(row.key)
    }
    return true
  }

  function refuse(row: SettingRow) {
    if (row.locked) {
      toast.show({
        variant: "warning",
        message: `${row.key} is set by your organisation's policy and can't be changed here`,
      })
      return true
    }
    if (row.readonly) {
      toast.show({ variant: "info", message: `${row.key} can't be changed from settings` })
      return true
    }
    if (row.secret) {
      toast.show({ variant: "info", message: "API keys and tokens are managed in /providers" })
      dialog.replace(() => <DialogProviders />, undefined, backTo(row.key))
      return true
    }
    return false
  }

  async function openInEditor(row: SettingRow) {
    const files = snapshot()?.files
    if (!files) return
    const file = row.target === "tui" ? files[scope()].tui : files[scope()].config
    const opened = await openFileInEditor({ file, renderer }).catch(() => false)
    if (!opened)
      toast.show({
        variant: "info",
        title: `${row.label} is edited in the config file`,
        message: `Set $EDITOR to open it from here, or edit ${file} (key "${row.key}"). /restart applies the change.`,
        duration: 10000,
      })
    else toast.show({ variant: "info", message: "Saved edits apply after /restart" })
  }

  async function edit(row: SettingRow) {
    // Before refuse(): a parent reads as locked when any one field is, and the others can still change.
    if (row.kind === "object" && hasSection(row, rows())) return openSection(row)
    // XCOD-229: its own screen; a locked list can still be looked at, every change is refused there.
    if (row.key === "recommended")
      return dialog.replace(
        () => <DialogRecommended scope={scope()} onBack={() => reopen(row.key)} />,
        undefined,
        backTo(row.key),
      )
    if (refuse(row)) return
    if (row.dialog === "themes") {
      dialog.replace(
        () => (
          <DialogThemeList
            onPick={(name) => {
              void save(row, name, { reopen: true })
            }}
          />
        ),
        undefined,
        backTo(row.key),
      )
      return
    }
    if (row.key === "default_agent") return pickDefaultAgent(row)
    if (EXTERNAL_KEYS.includes(row.key)) return pickExternal(row)
    // XCOD-257: LSP gets its own panel (state, failures, actions) instead of raw JSON.
    if (row.key === "lsp") return dialog.replace(() => <DialogLsp />, undefined, backTo(row.key))
    if (row.key === "subagent.variant")
      return dialog.replace(
        () => (
          <DialogVariantSetting
            title={row.label}
            settingKey={row.key}
            scope={scope()}
            current={typeof row.value === "string" ? row.value : undefined}
            applies={variantFor(row.key)}
            onPick={(value) => void save(row, value, { reopen: true })}
            onClear={() => void save(row, "", { reopen: true, unset: true })}
          />
        ),
        undefined,
        backTo(row.key),
      )
    if (row.dialog === "models") {
      if (row.key === "subagent.dynamic.allow")
        return editModelList(row, Array.isArray(row.value) ? row.value.map(String) : [])
      const value = typeof row.value === "string" ? row.value : ""
      const slash = value.indexOf("/")
      // XCOD-214: a subagent's model is picked like the main agent's, with its two special values first.
      const choices =
        row.key === "subagent.model"
          ? [
              {
                title: "Inherit from main agent",
                description: "the default",
                onSelect: () => void save(row, "inherit", { reopen: true }),
              },
              {
                title: "Small model",
                description: "small_model",
                onSelect: () => void save(row, "small", { reopen: true }),
              },
            ]
          : undefined
      dialog.replace(
        () => (
          <DialogModel
            title={row.label}
            choices={choices}
            current={slash > 0 ? { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) } : undefined}
            onPick={(providerID, modelID) => {
              void save(row, `${providerID}/${modelID}`, { reopen: true })
            }}
          />
        ),
        undefined,
        backTo(row.key),
      )
      return
    }
    // XCOD-215: agents get their own screen instead of the raw JSON.
    if (row.key === "agent" || row.key === "mode")
      return dialog.replace(
        () => <DialogAgentList scope={scope()} onBack={() => reopen(row.key)} />,
        undefined,
        backTo(row.key),
      )
    if (row.dialog === "mcps") return dialog.replace(() => <DialogMcp />, undefined, backTo(row.key))
    if (row.dialog === "providers") return dialog.replace(() => <DialogProviders />, undefined, backTo(row.key))
    if (row.kind === "boolean") return void save(row, cycle(row)!)
    if (row.kind === "enum") {
      dialog.replace(
        () => (
          <DialogSelect
            title={row.label}
            placeholder={row.key}
            skipFilter
            current={String(row.value)}
            options={(row.values ?? []).map((value) => ({ title: String(value), value: String(value) }))}
            onSelect={(option) => void save(row, option.value, { reopen: true })}
          />
        ),
        undefined,
        backTo(row.key),
      )
      return
    }
    if (row.kind === "object") return openInEditor(row)
    const value = await DialogPrompt.show(dialog, row.label, {
      value: editText(row),
      placeholder: row.kind === "list" ? "comma-separated, e.g. eu, us" : row.key,
      description: () => <text fg={theme.textMuted}>{row.description || row.key}</text>,
      nav: backTo(row.key),
    })
    if (value === null) return reopen(row.key)
    await save(row, value, { reopen: true })
  }

  // XCOD-214: subagent.dynamic.allow, a list of models. Add one from the model picker, or by ID
  // (checked against the models available here when saved); enter on a model removes it.
  // The list is carried along: this screen's own state stops updating while the list replaces it.
  function editModelList(row: SettingRow, list: string[], focus?: string) {
    const write = async (next: string[], at?: string) => {
      const saved = await save(row, JSON.stringify(next))
      editModelList(row, saved ? next : list, at)
    }
    // ← from a picker this list opened comes back here, on the row that opened it.
    const here = (at: string) => ({ back: () => editModelList(row, list, at), generation })
    dialog.replace(
      () => (
        <DialogSelect<string>
          title={`${row.label} (${list.length})`}
          placeholder="enter adds, or removes the highlighted model"
          skipFilter
          current={focus}
          options={[
            { title: "Add a model…", value: "+model", category: "Add" },
            { title: "Add a custom model ID…", value: "+custom", category: "Add" },
            ...list.map((id) => ({ title: id, value: id, category: "Allowed models", footer: "enter removes" })),
          ]}
          onSelect={async (option) => {
            if (option.value === "+model")
              return dialog.replace(
                () => (
                  <DialogModel
                    title="Add a model"
                    onPick={(providerID, modelID) => {
                      const id = `${providerID}/${modelID}`
                      void write(list.includes(id) ? list : [...list, id], id)
                    }}
                  />
                ),
                undefined,
                here("+model"),
              )
            if (option.value === "+custom") {
              const value = await DialogPrompt.show(dialog, "Custom model ID", {
                placeholder: "provider/model",
                description: () => (
                  <text fg={theme.textMuted}>For a model the picker doesn't list; it must be available here</text>
                ),
                nav: here("+custom"),
              })
              const id = value?.trim()
              if (!id) return editModelList(row, list, "+custom")
              return write(list.includes(id) ? list : [...list, id], id)
            }
            return write(
              list.filter((id) => id !== option.value),
              "+model",
            )
          }}
        />
      ),
      undefined,
      backTo(row.key),
    )
  }

  function toggle(row: SettingRow | undefined) {
    if (!row || refuse(row)) return
    // XCOD-256: cycling would step onto values refused in config; the list explains each one.
    const next = EXTERNAL_KEYS.includes(row.key) ? undefined : cycle(row)
    if (next === undefined) return void edit(row)
    void save(row, next)
  }

  const bindings = createMemo((): { key: string; desc: string; group: string; cmd: () => void }[] => [
    ...(props.section
      ? []
      : [
          { key: "tab", desc: "Next tab", group: "Settings", cmd: () => void setTab((t) => nextTab(t, 1)) },
          {
            key: "shift+tab",
            desc: "Previous tab",
            group: "Settings",
            cmd: () => void setTab((t) => nextTab(t, -1)),
          },
        ]),
    {
      key: "ctrl+s",
      desc: "Switch between user and project config",
      group: "Settings",
      cmd: () => void setScope((s) => (s === "user" ? "project" : "user")),
    },
    { key: "space", desc: "Toggle or cycle the setting", group: "Settings", cmd: () => toggle(current()) },
  ])

  const tabs = () => (
    <box flexDirection="row" gap={1}>
      <For each={TABS}>
        {(item, index) => (
          <>
            <Show when={index() > 0}>
              <text fg={theme.textMuted}>|</text>
            </Show>
            <text
              fg={tab() === item ? theme.primary : theme.textMuted}
              attributes={tab() === item ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined}
              onMouseUp={() => setTab(item)}
            >
              {tab() === item ? `[${LABEL[item]}]` : LABEL[item]}
            </text>
          </>
        )}
      </For>
    </box>
  )

  const width = createMemo(() => Math.min(88, dimensions().width - 2))
  const sectionRow = createMemo(() => snapshot()?.rows.find((row) => row.key === props.section))

  const options = createMemo(() => {
    const list = shown().map((row) => {
      const value =
        (row.secret && row.kind !== "object" ? "••• (see /providers)" : row.display) +
        (variantProblem(row) || agentProblem(row) ? " ⚠" : "")
      const flags = [row.restart ? "↻" : "", row.source === "env" ? "env" : ""].filter(Boolean).join(" ")
      const right = `${value.length > 22 ? value.slice(0, 21) + "…" : value}  ${badge(row)}${flags ? " " + flags : ""}`
      return {
        title: props.section ? sectionLabel(row, sectionRow()) : row.label,
        value: row.key,
        category: query() || props.section ? undefined : row.category,
        titleWidth: Math.max(12, width() - right.length - 12),
        footer: right,
      }
    })
    if (!collapsing()) return list
    const config = sync.data.config.memory
    const enabledRow = rows().find((row) => row.key === "memory.enabled")
    const count = rows().filter((row) => row.category === MEMORY).length
    const synthetic = [
      {
        title: config?.enabled === true ? "Change memory setup…" : "Set up memory…",
        value: "+memory.setup",
        category: MEMORY,
        footer: "guided, 6 steps",
      },
      {
        title: MemorySetup.status(config, enabledRow?.override?.split(" is set")[0]),
        value: "+memory.status",
        category: MEMORY,
      },
      {
        title: `Advanced ${advancedOpen() ? "▾" : "▸"}`,
        value: "+memory.advanced",
        category: MEMORY,
        footer: `${count} settings`,
      },
    ]
    // Where the Memory section starts in the full, ordered list.
    const first = rows().findIndex((row) => row.category === MEMORY)
    const at = shown().filter((row) => rows().indexOf(row) < first).length
    return [...list.slice(0, at), ...synthetic, ...list.slice(at)]
  })

  const footer = () => {
    const synthetic = highlighted()
    if (synthetic === "+memory.setup" || synthetic === "+memory.status")
      return (
        <text fg={theme.textMuted} wrapMode="word">
          A few steps that get memory working, each with a recommended answer. Saves to the {scope()} config.
        </text>
      )
    if (synthetic === "+memory.advanced")
      return (
        <text fg={theme.textMuted} wrapMode="word">
          Every memory setting, one by one: backend, sources, limits, retention, encryption.
        </text>
      )
    const row = current()
    if (!row) return <text fg={theme.textMuted}>No setting matches "{query()}"</text>
    const lines: { text: string; color: typeof theme.text }[] = []
    lines.push({
      text: `${row.key} — ${row.description.replace(/^@deprecated\s*/, "(deprecated) ") || "No description in the schema"}`,
      color: theme.text,
    })
    if (row.locked)
      lines.push({
        text: "🔒 set by your organisation (managed config); it can't be changed here",
        color: theme.warning,
      })
    else if (row.override) lines.push({ text: row.override, color: theme.warning })
    else if (agentProblem(row))
      lines.push({
        text: `⚠ ${agentProblem(row)}, so it can't start a session: pick a main agent`,
        color: theme.warning,
      })
    else if (variantProblem(row))
      lines.push({
        text: `⚠ "${row.display}" is ${variantProblem(row)}: requests use the model's default effort`,
        color: theme.warning,
      })
    else if (row.secret)
      lines.push({ text: "Secrets are never shown here: manage keys in /providers", color: theme.textMuted })
    else if (row.key === "agent")
      lines.push({ text: `Enter lists every agent. ${AGENTS_HELP}`, color: theme.textMuted })
    else if (row.key === "mode")
      lines.push({ text: "Deprecated: Agents → Migrate moves it under agent", color: theme.warning })
    else if (row.key === "recommended")
      lines.push({
        text: `Enter lists the models the pickers recommend${row.source === "default" ? " (Lunos's curated list)" : ""}`,
        color: theme.textMuted,
      })
    else if (row.kind === "object" && hasSection(row, rows()))
      lines.push({ text: "Enter lists its settings", color: theme.textMuted })
    else if (row.kind === "object" && !row.dialog)
      lines.push({ text: "Enter opens the config file in your editor", color: theme.textMuted })
    if (row.from) lines.push({ text: `from ${home(row.from)}`, color: theme.textMuted })
    if (row.restart) lines.push({ text: "↻ restart required after a change", color: theme.textMuted })
    return (
      <box>
        <For each={lines}>
          {(line) => (
            <text fg={line.color} wrapMode="word">
              {line.text}
            </text>
          )}
        </For>
      </box>
    )
  }

  return (
    <box>
      <Switch>
        <Match when={tab() === "settings"}>
          <box>
            <DialogSelect<string>
              title="Settings"
              titleView={
                <box flexDirection="row" gap={2}>
                  <Show when={props.section} fallback={tabs()}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      {sectionRow()?.label ?? props.section}
                    </text>
                  </Show>
                  <text fg={theme.textMuted}>
                    saving to <span style={{ fg: theme.text }}>{scope()}</span> config (ctrl+s)
                  </text>
                </box>
              }
              placeholder="Type to filter by name, key or description"
              skipFilter
              preserveSelection
              // XCOD-206: wheel scrolling here was still reported to run away after #152, so it's off
              // (PO, 2026-10-06). Arrow keys, page keys and the filter move through the list.
              wheel={false}
              current={highlighted()}
              options={options()}
              emptyView={
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={error() ? theme.error : theme.textMuted}>
                    {error() ?? (snapshot() ? `No setting matches "${query()}"` : "Loading settings…")}
                  </text>
                </box>
              }
              ref={(r) => (list = r)}
              onFilter={(value) => setQuery(value)}
              onMove={(option) => setHighlighted(option.value)}
              onSelect={(option) => {
                if (option.value === "+memory.advanced") {
                  memoryAdvancedOpen = !advancedOpen()
                  return setAdvancedOpen(memoryAdvancedOpen)
                }
                if (option.value === "+memory.setup" || option.value === "+memory.status") return openMemorySetup()
                const row = rows().find((item) => item.key === option.value)
                if (row) void edit(row)
              }}
              bindings={bindings()}
              footerHints={[
                { title: "change", label: "enter" },
                { title: "toggle", label: "space" },
                ...(props.section ? [] : [{ title: "tabs", label: "tab", side: "right" as const }]),
              ]}
            />
            <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
              {footer()}
            </box>
          </box>
        </Match>
        <Match when={tab() !== "settings"}>
          <OtherTab tab={tab()} tabs={tabs} snapshot={snapshot()} bindings={bindings()} />
        </Match>
      </Switch>
    </box>
  )
}

function OtherTab(props: {
  tab: Tab
  tabs: () => any
  snapshot: SettingsSnapshot | undefined
  bindings: { key: string; desc: string; group: string; cmd: () => void }[]
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  // The Settings tab gets its keys from DialogSelect; here there's no list, so bind them directly.
  useBindingsFor(props.bindings)
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        {props.tabs()}
        <text fg={theme.textMuted} onMouseUp={() => dialog.dismiss()}>
          esc
        </text>
      </box>
      <scrollbox
        // The dialog starts a quarter of the way down; leave room for the tab row and the hint.
        maxHeight={Math.max(4, dimensions().height - Math.floor(dimensions().height / 4) - 7)}
        scrollbarOptions={{ visible: false }}
      >
        <Switch>
          <Match when={props.tab === "status"}>
            <StatusTab snapshot={props.snapshot} />
          </Match>
          <Match when={props.tab === "usage"}>
            <UsageTab snapshot={props.snapshot} />
          </Match>
        </Switch>
      </scrollbox>
      <text fg={theme.textMuted}>tab switches tabs</text>
    </box>
  )
}

function useBindingsFor(bindings: { key: string; desc: string; group: string; cmd: () => void }[]) {
  useBindings(() => ({ bindings }))
}

function StatusTab(props: { snapshot: SettingsSnapshot | undefined }) {
  const { theme } = useTheme()
  const sync = useSync()
  const local = useLocal()
  const model = createMemo(() => {
    const current = local.model.current()
    return current ? `${current.providerID}/${current.modelID}` : "none selected"
  })
  const row = (key: string) => props.snapshot?.rows.find((item) => item.key === key)
  const residency = createMemo(() => {
    const config = sync.data.config.residency
    if (!config) return "no policy (any provider jurisdiction)"
    return `allow ${config.allow.join(", ")}${config.audit === false ? ", audit off" : ", audit on"}`
  })
  const memory = createMemo(() => {
    const enabled = row("memory.enabled")
    if (enabled?.override) return `off (${enabled.override.split(" is set")[0]} is set)`
    const config = sync.data.config.memory
    if (config?.enabled !== true) return "off"
    return `on${config.embedding ? `, embeddings ${config.embedding}` : ""}${config.model ? `, model ${config.model}` : ""}`
  })
  const loaded = createMemo(() => (props.snapshot?.layers ?? []).filter((layer) => layer.loaded))
  // XCOD-242: where the organisation's team features come from.
  const team = createMemo(() => {
    const info = props.snapshot?.team
    if (!info) return "off"
    return `${info.org} on ${info.host}, from ${info.via === "managed" ? "managed config" : "hosted (Lunos sign-in)"}`
  })
  // XCOD-158: inside a sandbox, what it runs in; on this machine, the project's sandboxes.
  const sandbox = createMemo(() => {
    const info = props.snapshot?.sandbox
    const inside = info?.inside
    if (inside)
      return `this session runs in sandbox ${inside.id}: ${inside.image ?? "image"} ${inside.digest ?? ""}, network ${inside.network ?? "open"}, results ${inside.results ?? "branch"}`
    if (!info?.known.length) return "none for this project"
    return info.known
      .map((item) => `${item.id} (${item.network}${item.expires ? `, expires ${item.expires.slice(0, 16)}` : ""})`)
      .join(", ")
  })
  return (
    <box gap={1}>
      <box>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Lunos
        </text>
        <text fg={theme.textMuted}>{versionDetail()}</text>
      </box>
      <box>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Config files
        </text>
        <Show when={loaded().length > 0} fallback={<text fg={theme.textMuted}>none (defaults only)</text>}>
          <For each={loaded()}>
            {(layer) => (
              <text fg={theme.textMuted} wrapMode="char">
                <span style={{ fg: theme.text }}>{layer.layer.padEnd(8)}</span> {home(layer.path)}
              </text>
            )}
          </For>
        </Show>
      </box>
      <box>
        <text fg={theme.text}>
          <b>Model</b> <span style={{ fg: theme.textMuted }}>{model()}</span>
        </text>
        <text fg={theme.text}>
          <b>Residency</b> <span style={{ fg: theme.textMuted }}>{residency()}</span>
        </text>
        <text fg={theme.text}>
          <b>Memory</b> <span style={{ fg: theme.textMuted }}>{memory()}</span>
        </text>
        <text fg={theme.text} wrapMode="char">
          <b>Sandbox</b> <span style={{ fg: theme.textMuted }}>{sandbox()}</span>
        </text>
        <text fg={theme.text}>
          <b>Team features</b> <span style={{ fg: theme.textMuted }}>{team()}</span>
        </text>
        <text fg={theme.text}>
          <b>Locked by your organisation</b>{" "}
          <span style={{ fg: theme.textMuted }}>
            {props.snapshot?.locked.length ? `🔒 ${props.snapshot.locked.join(", ")}` : "nothing"}
          </span>
        </text>
      </box>
      <StatusServers />
    </box>
  )
}

function UsageTab(props: { snapshot: SettingsSnapshot | undefined }) {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const session = createMemo(() => (route.data.type === "session" ? sync.session.get(route.data.sessionID) : undefined))
  const line = (
    label: string,
    cost: number,
    tokens: { input: number; output: number; reasoning: number; cache: number },
  ) => (
    <box>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {label}
      </text>
      <text fg={theme.textMuted}>
        cost {formatCost(cost)} · input {formatTokens(tokens.input)} · output {formatTokens(tokens.output)} · reasoning{" "}
        {formatTokens(tokens.reasoning)} · cache {formatTokens(tokens.cache)}
      </text>
    </box>
  )
  return (
    <box gap={1}>
      <Show when={session()} fallback={<text fg={theme.textMuted}>This session: no session open</text>}>
        {(item) =>
          line("This session", item().cost ?? 0, {
            input: item().tokens?.input ?? 0,
            output: item().tokens?.output ?? 0,
            reasoning: item().tokens?.reasoning ?? 0,
            cache: (item().tokens?.cache.read ?? 0) + (item().tokens?.cache.write ?? 0),
          })
        }
      </Show>
      <Show when={props.snapshot?.usage} fallback={<text fg={theme.textMuted}>Loading usage…</text>}>
        {(usage) => (
          <box>
            {line(`Last ${usage().days} days (${usage().sessions} sessions)`, Number(usage().cost), {
              input: Number(usage().tokens.input),
              output: Number(usage().tokens.output),
              reasoning: Number(usage().tokens.reasoning),
              cache: Number(usage().tokens.cache_read) + Number(usage().tokens.cache_write),
            })}
          </box>
        )}
      </Show>
      <text fg={theme.textMuted}>Same data as `lunos stats --days 30`.</text>
    </box>
  )
}
