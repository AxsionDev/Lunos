import type {
  TuiMarketplaceEntry,
  TuiMarketplaceKind,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginStatus,
} from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { useTerminalDimensions } from "@opentui/solid"
import { fileURLToPath } from "url"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { useBindings } from "../../keymap"

const id = "internal:plugin-manager"

function state(api: TuiPluginApi, item: TuiPluginStatus) {
  if (!item.enabled) {
    return <span style={{ fg: api.theme.current.textMuted }}>disabled</span>
  }

  return (
    <span style={{ fg: item.active ? api.theme.current.success : api.theme.current.error }}>
      {item.active ? "active" : "inactive"}
    </span>
  )
}

function source(spec: string) {
  if (!spec.startsWith("file://")) return
  return fileURLToPath(spec)
}

function meta(item: TuiPluginStatus, width: number) {
  if (item.source === "internal") {
    if (width >= 120) return "Built-in plugin"
    return "Built-in"
  }
  const next = source(item.spec)
  if (next) return next
  return item.spec
}

function Install(props: { api: TuiPluginApi }) {
  const [global, setGlobal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  useBindings(() => ({
    enabled: !busy(),
    bindings: [{ key: "tab", desc: "Toggle install scope", group: "Plugins", cmd: () => setGlobal((value) => !value) }],
  }))

  return (
    <props.api.ui.DialogPrompt
      title="Install plugin"
      placeholder="npm package name"
      busy={busy()}
      busyText="Installing plugin…"
      description={() => (
        <box flexDirection="row" gap={1}>
          <text fg={props.api.theme.current.textMuted}>scope:</text>
          <text fg={busy() ? props.api.theme.current.textMuted : props.api.theme.current.text}>
            {global() ? "global" : "local"}
          </text>
          <Show when={!busy()}>
            <text fg={props.api.theme.current.textMuted}>(tab toggle)</text>
          </Show>
        </box>
      )}
      onConfirm={(raw) => {
        if (busy()) return
        const mod = raw.trim()
        if (!mod) {
          props.api.ui.toast({
            variant: "error",
            message: "Plugin package name is required",
          })
          return
        }

        setBusy(true)
        void props.api.plugins
          .install(mod, { global: global() })
          .then((out) => {
            if (!out.ok) {
              props.api.ui.toast({
                variant: "error",
                message: out.message,
              })
              if (out.missing) {
                props.api.ui.toast({
                  variant: "info",
                  message: "Check npm registry/auth settings and try again.",
                })
              }
              show(props.api)
              return
            }

            props.api.ui.toast({
              variant: "success",
              message: `Installed ${mod} (${global() ? "global" : "local"}: ${out.dir})`,
            })
            if (!out.tui) {
              props.api.ui.toast({
                variant: "info",
                message: "Package has no TUI target to load in this app.",
              })
              show(props.api)
              return
            }

            return props.api.plugins.add(mod).then((ok) => {
              if (!ok) {
                props.api.ui.toast({
                  variant: "warning",
                  message: "Installed plugin, but runtime load failed. See console/logs; restart TUI to retry.",
                })
                show(props.api)
                return
              }

              props.api.ui.toast({
                variant: "success",
                message: `Loaded ${mod} in current session.`,
              })
              show(props.api)
            })
          })
          .finally(() => {
            setBusy(false)
          })
      }}
      onCancel={() => {
        show(props.api)
      }}
    />
  )
}

const KINDS: readonly TuiMarketplaceKind[] = ["plugin", "skill", "hook", "mcp"]
const KIND_TITLE: Record<TuiMarketplaceKind, string> = { plugin: "Plugins", skill: "Skills", hook: "Hooks", mcp: "MCP" }
const KIND_NOUN: Record<TuiMarketplaceKind, string> = {
  plugin: "plugins",
  skill: "skill sources",
  hook: "hooks",
  mcp: "MCP servers",
}

// One strip for all four kinds, the active one bracketed, so the title doubles as the tab bar.
function tabTitle(kind: TuiMarketplaceKind) {
  return `Discover  ${KINDS.map((k) => (k === kind ? `[${KIND_TITLE[k]}]` : KIND_TITLE[k])).join("  ")}`
}

function discoverRow(item: TuiMarketplaceEntry): DialogSelectOption<TuiMarketplaceEntry> {
  return {
    title: item.name,
    value: item,
    category: item.marketplace,
    description: item.description,
  }
}

function Discover(props: { api: TuiPluginApi; kind?: TuiMarketplaceKind }) {
  const [kind, setKind] = createSignal<TuiMarketplaceKind>(props.kind ?? "plugin")
  const [items, setItems] = createSignal<TuiMarketplaceEntry[]>()
  const [marketplaceCount, setMarketplaceCount] = createSignal(0)
  const [installing, setInstalling] = createSignal(false)

  // Loaded once for every kind; switching tabs filters locally instead of re-resolving manifests.
  props.api.marketplace.discover().then((out) => {
    setMarketplaceCount(out.marketplaceCount)
    setItems([...out.items])
    // A source that's fallen back to a stale cache still lists its entries (last-known-good), but
    // the toast makes that visible rather than presenting it as a fully healthy marketplace.
    for (const marketplace of out.marketplaces) {
      if (!marketplace.stale) continue
      props.api.ui.toast({
        variant: "warning",
        message: `"${marketplace.name}" refresh failed (${marketplace.stale}) — showing cached data`,
      })
    }
  })

  const rows = createMemo(() => (items() ?? []).filter((item) => item.kind === kind()).map(discoverRow))
  const loading = createMemo(() => items() === undefined)
  const cycle = () => setKind((current) => KINDS[(KINDS.indexOf(current) + 1) % KINDS.length]!)

  const installPlugin = (spec: string) => {
    if (installing()) return
    setInstalling(true)
    void props.api.plugins
      .install(spec)
      .then((out) => {
        if (!out.ok) {
          props.api.ui.toast({ variant: "error", message: out.message })
          if (out.missing) {
            props.api.ui.toast({
              variant: "info",
              message: "Check npm registry/auth settings and try again.",
            })
          }
          return
        }

        props.api.ui.toast({ variant: "success", message: `Installed ${spec} (local: ${out.dir})` })
        if (!out.tui) {
          props.api.ui.toast({
            variant: "info",
            message: "Package has no TUI target to load in this app.",
          })
          return
        }

        return props.api.plugins.add(spec).then((ok) => {
          if (!ok) {
            props.api.ui.toast({
              variant: "warning",
              message: "Installed plugin, but runtime load failed. See console/logs; restart TUI to retry.",
            })
            return
          }

          props.api.ui.toast({ variant: "success", message: `Loaded ${spec} in current session.` })
        })
      })
      .finally(() => {
        setInstalling(false)
        show(props.api)
      })
  }

  // Skill sources, hooks and MCP servers never install on a bare Enter: a hook runs on every
  // matching event with no per-run consent, and a local MCP server executes third-party code, so
  // the user sees exactly what will run (from the same planner the CLI uses) and confirms first.
  const confirmConfigItem = (item: TuiMarketplaceEntry & { kind: Exclude<TuiMarketplaceKind, "plugin"> }) => {
    if (installing()) return
    setInstalling(true)
    void props.api.marketplace.plan(item.kind, item.marketplace, item.name).then((plan) => {
      setInstalling(false)
      if (!plan.ok) {
        props.api.ui.toast({ variant: "error", message: plan.message })
        return
      }
      const message = [
        ...(item.description ? [item.description, ""] : []),
        ...plan.details,
        `writes to: ${plan.configPath}`,
        ...plan.warnings.map((warning) => `warning: ${warning}`),
      ].join("\n")
      props.api.ui.dialog.replace(() => (
        <props.api.ui.DialogConfirm
          title={`Add ${KIND_NOUN[item.kind].replace(/s$/, "")} ${item.marketplace}/${item.name}?`}
          message={message}
          onConfirm={() => {
            void props.api.marketplace.install(item.kind, item.marketplace, item.name).then((out) => {
              props.api.ui.toast(
                out.ok
                  ? { variant: "success", message: `Added ${item.name} to ${out.configPath}. Restart to load it.` }
                  : { variant: "error", message: out.message },
              )
              showDiscover(props.api, item.kind)
            })
          }}
          onCancel={() => showDiscover(props.api, item.kind)}
        />
      ))
    })
  }

  const select = (item: TuiMarketplaceEntry) => {
    if (item.kind === "plugin") return item.spec && installPlugin(item.spec)
    confirmConfigItem(item as TuiMarketplaceEntry & { kind: Exclude<TuiMarketplaceKind, "plugin"> })
  }

  const emptyView = createMemo(() => {
    if (loading()) return <text fg={props.api.theme.current.textMuted}>Loading marketplaces…</text>
    if (marketplaceCount() === 0)
      return (
        <text fg={props.api.theme.current.textMuted}>
          {"No marketplaces added. Run: lunos marketplace add <owner/repo | url | path>"}
        </text>
      )
    if (rows().length) return undefined
    return <text fg={props.api.theme.current.textMuted}>{`No ${KIND_NOUN[kind()]} in added marketplaces.`}</text>
  })

  return (
    <DialogSelect
      title={tabTitle(kind())}
      options={rows()}
      locked={loading() || installing()}
      emptyView={emptyView()}
      onSelect={(item) => select(item.value)}
      actions={[
        {
          title: "next tab",
          command: "dialog.plugins.discover.next_kind",
          hidden: loading() || installing(),
          // A tab can be empty (the community marketplace ships no skills); without this the user
          // would be stuck on it, unable to cycle on to the MCP tab.
          withoutSelection: true,
          onTrigger: cycle,
        },
        {
          title: "back",
          command: "dialog.plugins.discover.back",
          hidden: loading() || installing(),
          withoutSelection: true,
          onTrigger: () => show(props.api),
        },
      ]}
    />
  )
}

function showDiscover(api: TuiPluginApi, kind?: TuiMarketplaceKind) {
  api.ui.dialog.replace(() => <Discover api={api} kind={kind} />)
}

function row(api: TuiPluginApi, item: TuiPluginStatus, width: number): DialogSelectOption<string> {
  return {
    title: item.id,
    value: item.id,
    category: item.source === "internal" ? "Internal" : "External",
    description: meta(item, width),
    footer: state(api, item),
    disabled: item.id === id,
  }
}

function showInstall(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <Install api={api} />)
}

function View(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const [list, setList] = createSignal(props.api.plugins.list())
  const [cur, setCur] = createSignal<string | undefined>()
  const [lock, setLock] = createSignal(false)

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  const rows = createMemo(() =>
    [...list()]
      .sort((a, b) => {
        const x = a.source === "internal" ? 1 : 0
        const y = b.source === "internal" ? 1 : 0
        if (x !== y) return x - y
        return a.id.localeCompare(b.id)
      })
      .map((item) => row(props.api, item, size().width)),
  )

  const flip = (x: string) => {
    if (lock()) return
    const item = list().find((entry) => entry.id === x)
    if (!item) return
    setLock(true)
    const task = item.active ? props.api.plugins.deactivate(x) : props.api.plugins.activate(x)
    void task
      .then((ok) => {
        if (!ok) {
          props.api.ui.toast({
            variant: "error",
            message: `Failed to update plugin ${item.id}`,
          })
        }
        setList(props.api.plugins.list())
      })
      .finally(() => {
        setLock(false)
      })
  }

  return (
    <DialogSelect
      title="Plugins"
      options={rows()}
      current={cur()}
      onMove={(item) => setCur(item.value)}
      actions={[
        {
          title: "toggle",
          command: "plugins.toggle",
          hidden: lock(),
          onTrigger: (item) => {
            setCur(item.value)
            flip(item.value)
          },
        },
        {
          title: "install",
          command: "dialog.plugins.install",
          hidden: lock(),
          onTrigger: () => {
            showInstall(props.api)
          },
        },
        {
          title: "discover",
          command: "dialog.plugins.discover",
          hidden: lock(),
          onTrigger: () => {
            showDiscover(props.api)
          },
        },
      ]}
      onSelect={(item) => {
        setCur(item.value)
        flip(item.value)
      }}
    />
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "plugins.list",
        title: "Plugins",
        category: "System",
        namespace: "palette",
        run() {
          show(api)
        },
      },
      {
        name: "plugins.install",
        title: "Install plugin",
        category: "System",
        namespace: "palette",
        run() {
          showInstall(api)
        },
      },
      {
        name: "plugins.discover",
        title: "Discover marketplace (plugins, skills, hooks, MCP)",
        category: "System",
        namespace: "palette",
        run() {
          showDiscover(api)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("plugins.palette", ["plugins.list", "plugins.install", "plugins.discover"]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
