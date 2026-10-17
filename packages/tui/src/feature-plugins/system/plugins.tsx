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
import { takeDiscoverRequest, type DiscoverRequest } from "../../util/marketplace"

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

// One strip for all four kinds, the active one bracketed, so the title doubles as the tab bar. A
// search (`/marketplace <words>`) starts on "All", so a match is found whatever kind it is.
function tabTitle(kind: TuiMarketplaceKind | "all", withAll: boolean) {
  const tabs = [...(withAll ? (["all"] as const) : []), ...KINDS]
  const title = (k: (typeof tabs)[number]) => (k === "all" ? "All" : KIND_TITLE[k])
  return `Discover  ${tabs.map((k) => (k === kind ? `[${title(k)}]` : title(k))).join("  ")}`
}

function discoverRow(
  api: TuiPluginApi,
  item: TuiMarketplaceEntry,
  withKind: boolean,
): DialogSelectOption<TuiMarketplaceEntry> {
  const theme = api.theme.current
  const status =
    item.installed === "update" ? (
      <span style={{ fg: theme.warning }}>update available</span>
    ) : item.installed === "installed" ? (
      <span style={{ fg: theme.success }}>installed</span>
    ) : item.review === "verified" ? (
      <span style={{ fg: theme.textMuted }}>verified</span>
    ) : undefined
  return {
    title: item.name,
    value: item,
    category: item.marketplace,
    description: withKind ? [KIND_TITLE[item.kind], item.description].filter(Boolean).join(" · ") : item.description,
    footer: status,
  }
}

// The oldest copy shown, so the notice never claims a catalogue is fresher than it is.
function cachedSince(marketplaces: readonly { fetchedAt: number }[]) {
  const oldest = Math.min(...marketplaces.map((marketplace) => marketplace.fetchedAt))
  return new Date(oldest).toLocaleString()
}

function Discover(props: { api: TuiPluginApi } & DiscoverRequest) {
  const withAll = Boolean(props.search)
  const [kind, setKind] = createSignal<TuiMarketplaceKind | "all">(props.kind ?? (withAll ? "all" : "plugin"))
  const [offline, setOffline] = createSignal(false)
  const [items, setItems] = createSignal<TuiMarketplaceEntry[]>()
  const [marketplaceCount, setMarketplaceCount] = createSignal(0)
  const [installing, setInstalling] = createSignal(false)

  // Loaded once for every kind; switching tabs filters locally instead of re-resolving manifests.
  props.api.marketplace.discover().then((out) => {
    setMarketplaceCount(out.marketplaceCount)
    setItems([...out.items])
    setOffline(Boolean(out.offline))
    if (out.offline && out.marketplaces.length)
      props.api.ui.toast({
        variant: "info",
        message: `Offline — showing cached catalogue from ${cachedSince(out.marketplaces)}`,
      })
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

  const rows = createMemo(() =>
    (items() ?? [])
      .filter((item) => (props.installed ? item.installed !== undefined : kind() === "all" || item.kind === kind()))
      .map((item) => discoverRow(props.api, item, Boolean(props.installed) || kind() === "all")),
  )
  const loading = createMemo(() => items() === undefined)
  const cycle = () =>
    setKind((current) => {
      const tabs: (TuiMarketplaceKind | "all")[] = withAll ? ["all", ...KINDS] : [...KINDS]
      return tabs[(tabs.indexOf(current) + 1) % tabs.length]!
    })

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
              showDiscover(props.api, { kind: item.kind })
            })
          }}
          onCancel={() => showDiscover(props.api, { kind: item.kind })}
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
    if (offline() && marketplaceCount() > 0 && !items()?.length)
      return (
        <text fg={props.api.theme.current.textMuted}>
          {
            "Offline (LUNOS_OFFLINE) and no cached catalogue yet. Open /marketplace once with network access; after that it works offline."
          }
        </text>
      )
    if (marketplaceCount() === 0)
      return (
        <text fg={props.api.theme.current.textMuted}>
          {"No marketplaces added. Run: lunos marketplace add <owner/repo | url | path>"}
        </text>
      )
    if (rows().length) return undefined
    if (props.installed)
      return <text fg={props.api.theme.current.textMuted}>Nothing from the added marketplaces is installed.</text>
    const current = kind()
    return (
      <text fg={props.api.theme.current.textMuted}>
        {current === "all" ? "Nothing in added marketplaces." : `No ${KIND_NOUN[current]} in added marketplaces.`}
      </text>
    )
  })

  return (
    <DialogSelect
      title={props.installed ? "Installed from marketplaces" : tabTitle(kind(), withAll)}
      options={rows()}
      initialFilter={props.search}
      locked={loading() || installing()}
      emptyView={emptyView()}
      onSelect={(item) => select(item.value)}
      actions={[
        {
          title: "next tab",
          command: "dialog.plugins.discover.next_kind",
          hidden: loading() || installing() || props.installed,
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

function showDiscover(api: TuiPluginApi, request: DiscoverRequest = {}) {
  api.ui.dialog.replace(() => <Discover api={api} {...request} />)
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
      footerHints={[{ title: "browse the marketplace", label: "/marketplace" }]}
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
        desc: "Manage installed plugins",
        category: "System",
        namespace: "palette",
        slashName: "plugins",
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
        desc: "Browse and install plugins, skills, hooks and MCP servers",
        category: "System",
        namespace: "palette",
        // XCOD-251: `/marketplace` with no words opens the Plugins tab; with words, the prompt has
        // already parsed them into the request taken here.
        slashName: "marketplace",
        slashAliases: ["discover"],
        run() {
          showDiscover(api, takeDiscoverRequest())
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
