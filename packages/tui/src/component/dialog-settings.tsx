import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js"
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
import { DialogThemeList } from "./dialog-theme-list"
import { DialogMcp } from "./dialog-mcp"
import { DialogProviders } from "./dialog-provider"
import { StatusServers } from "./dialog-status"
import { TABS, badge, cycle, editText, filterRows, formatCost, formatTokens, nextTab, type Tab } from "../util/settings"

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

export function DialogSettings(props: { tab?: Tab; focus?: string; scope?: Scope }) {
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
    void load()
  })

  const rows = createMemo(() => {
    const list = snapshot()?.rows ?? []
    // tui.json is read by this process: show the theme actually in use.
    return list.map((row) =>
      row.key === "tui.theme" && row.source === "default"
        ? { ...row, value: themeState.selected, display: themeState.selected }
        : row,
    )
  })
  const visible = createMemo(() => filterRows(rows(), query()))
  const current = createMemo(() => rows().find((row) => row.key === highlighted()) ?? visible()[0])

  // Reopens this dialog where the user left it, after a picker or prompt replaced it.
  function reopen(key?: string) {
    dialog.replace(() => <DialogSettings tab="settings" focus={key ?? highlighted()} scope={scope()} />)
  }

  async function save(row: SettingRow, value: string, options: { reopen?: boolean } = {}) {
    const result = await sdk.client.config
      .settingsSet({ settingsSetInput: { key: row.key, value, scope: scope() } })
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
      message: `${row.label} = ${typeof data.value === "string" ? data.value : JSON.stringify(data.value)} (saved to ${data.scope} config: ${home(data.file)})`,
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
      dialog.replace(() => <DialogProviders />)
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
    if (refuse(row)) return
    if (row.dialog === "themes") {
      dialog.replace(() => (
        <DialogThemeList
          onPick={(name) => {
            void save(row, name, { reopen: true })
          }}
        />
      ))
      return
    }
    if (row.dialog === "models") {
      dialog.replace(() => (
        <DialogModel
          onPick={(providerID, modelID) => {
            void save(row, `${providerID}/${modelID}`, { reopen: true })
          }}
        />
      ))
      return
    }
    if (row.dialog === "mcps") return dialog.replace(() => <DialogMcp />)
    if (row.dialog === "providers") return dialog.replace(() => <DialogProviders />)
    if (row.kind === "boolean") return void save(row, cycle(row)!)
    if (row.kind === "enum") {
      dialog.replace(() => (
        <DialogSelect
          title={row.label}
          placeholder={row.key}
          skipFilter
          current={String(row.value)}
          options={(row.values ?? []).map((value) => ({ title: String(value), value: String(value) }))}
          onSelect={(option) => void save(row, option.value, { reopen: true })}
        />
      ))
      return
    }
    if (row.kind === "object") return openInEditor(row)
    const value = await DialogPrompt.show(dialog, row.label, {
      value: editText(row),
      placeholder: row.kind === "list" ? "comma-separated, e.g. eu, us" : row.key,
      description: () => <text fg={theme.textMuted}>{row.description || row.key}</text>,
    })
    if (value === null) return reopen(row.key)
    await save(row, value, { reopen: true })
  }

  function toggle(row: SettingRow | undefined) {
    if (!row || refuse(row)) return
    const next = cycle(row)
    if (next === undefined) return void edit(row)
    void save(row, next)
  }

  const bindings = createMemo((): { key: string; desc: string; group: string; cmd: () => void }[] => [
    { key: "tab", desc: "Next tab", group: "Settings", cmd: () => void setTab((t) => nextTab(t, 1)) },
    { key: "shift+tab", desc: "Previous tab", group: "Settings", cmd: () => void setTab((t) => nextTab(t, -1)) },
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

  const options = createMemo(() =>
    visible().map((row) => {
      const value = row.secret && row.kind !== "object" ? "••• (see /providers)" : row.display
      const flags = [row.restart ? "↻" : "", row.source === "env" ? "env" : ""].filter(Boolean).join(" ")
      const right = `${value.length > 22 ? value.slice(0, 21) + "…" : value}  ${badge(row)}${flags ? " " + flags : ""}`
      return {
        title: row.label,
        value: row.key,
        category: query() ? undefined : row.category,
        titleWidth: Math.max(12, width() - right.length - 12),
        footer: right,
      }
    }),
  )

  const footer = () => {
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
    else if (row.secret)
      lines.push({ text: "Secrets are never shown here: manage keys in /providers", color: theme.textMuted })
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
                  {tabs()}
                  <text fg={theme.textMuted}>
                    saving to <span style={{ fg: theme.text }}>{scope()}</span> config (ctrl+s)
                  </text>
                </box>
              }
              placeholder="Type to filter by name, key or description"
              skipFilter
              preserveSelection
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
                const row = rows().find((item) => item.key === option.value)
                if (row) void edit(row)
              }}
              bindings={bindings()}
              footerHints={[
                { title: "change", label: "enter" },
                { title: "toggle", label: "space" },
                { title: "tabs", label: "tab", side: "right" },
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
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
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
      <text fg={theme.textMuted}>tab switches tabs · esc closes</text>
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
