import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { animationsEnabled } from "./util/motion"
import { DialogArtifacts } from "./component/dialog-artifacts"
import { DialogBackground } from "./component/dialog-background"
import { DialogExternal, useExternalCommand } from "./component/dialog-external"
import { useExternalExit } from "./component/external-exit"
import { EXTERNAL_LABEL, externalOf, toolUnavailable, toolsWanted } from "./util/external"
import type { ExternalToolStatus } from "@opencode-ai/sdk/v2"
import { registerOpencodeSpinner } from "./component/register-spinner"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { StartupTrace } from "@opencode-ai/core/startup-trace"
import {
  InstallationVersion,
  manualInstallCommand,
  newVersionMessage,
  updateRestartHint,
  upgradeStepText,
} from "@opencode-ai/core/installation/version"
import { isVersionGreater } from "./util/version"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import * as Selection from "./util/selection"
import { createCliRenderer, MouseButton } from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  on,
} from "solid-js"
import { TuiPathsProvider, TuiStartupProvider, TuiTerminalEnvironmentProvider } from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogProvider as DialogProviderConnect, DialogProviders } from "./component/dialog-provider"
import { ErrorComponent } from "./component/error-component"
import { PluginRouteMissing } from "./component/plugin-route-missing"
import { UpdateNotice } from "./component/update-notice"
import { UpdateProgress, type UpgradeProgress } from "./component/update-progress"
import { ProjectProvider, useProject } from "./context/project"
import { EditorContextProvider } from "./context/editor"
import { useEvent } from "./context/event"
import { SDKProvider, useSDK } from "./context/sdk"
import { StartupStatus } from "./component/startup-status"
import { SyncProvider, useSync } from "./context/sync"
import { DataProvider } from "./context/data"
import { LocationProvider } from "./context/location"
import { LocalProvider, useLocal } from "./context/local"
import { Locale } from "./util/locale"
import { PermissionProvider } from "./context/permission"
import { DialogModel } from "./component/dialog-model"
import { DialogExternalModel } from "./component/dialog-external-model"
import { useConnected } from "./component/use-connected"
import { DialogMcp } from "./component/dialog-mcp"
import { DialogStatus } from "./component/dialog-status"
import { takeSettingsRequest } from "./util/settings-sections"
import { DialogSettings } from "./component/dialog-settings"
import { DialogDebug } from "./component/dialog-debug"
import { DialogLog, DialogLogs } from "./component/dialog-logs"
import { SandboxStatus } from "./component/sandbox-status"
import { SandboxProvider, useSandbox } from "./context/sandbox"
import { failureToast, unsavedToast, type SandboxHandback, type SandboxHost } from "./util/sandbox"
import { DialogThemeList } from "./component/dialog-theme-list"
import { DialogHelp } from "./ui/dialog-help"
import { DialogLsp } from "./component/dialog-lsp"
import { DialogMode } from "./component/dialog-mode"
import { DialogAgentList } from "./component/dialog-agent-settings"
import { DialogSessionList } from "./component/dialog-session-list"
import { DialogSessions } from "./component/dialog-sessions"
import { DialogProjects } from "./component/dialog-projects"
import { AgentMonitor, MONITOR_ROUTE } from "./routes/monitor"
import { DialogWorkspaceList } from "./component/dialog-workspace-list"
import { DialogConsoleOrg } from "./component/dialog-console-org"
import { ThemeProvider, useTheme } from "./context/theme"
import { Home } from "./routes/home"
import { Session } from "./routes/session"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { Changelog } from "@opencode-ai/core/changelog"
import { whatsNewOnStart } from "./util/whats-new"
import { DialogConfirm } from "./ui/dialog-confirm"
import { ToastProvider, useToast } from "./ui/toast"
import { isDefaultTitle } from "./util/session"
import { KVProvider, useKV } from "./context/kv"
import * as Model from "./util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import { openUrl } from "@opencode-ai/core/open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig, type TuiConfig } from "./config"
import { createTuiApiAdapters } from "./plugin/adapters"
import { createTuiApi } from "./plugin/api"
import { createPluginRuntime, PluginRuntimeProvider, usePluginRuntime, type TuiPluginHost } from "./plugin/runtime"
import { CommandPaletteDialog } from "./component/command-palette"
import {
  COMMAND_PALETTE_COMMAND,
  OPENCODE_BASE_MODE,
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useBindings,
  useOpencodeKeymap,
} from "./keymap"

import type { EventSource } from "./context/sdk"
import { DialogVariant } from "./component/dialog-variant"
import { createTuiAttention } from "./attention"
import * as TuiAudio from "./audio"
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./terminal-win32"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"
import {
  restartBanner,
  restartBusyMessage,
  restartDraft,
  type RestartChoice,
  type RestartHost,
  type Restarted,
} from "./util/restart"
import { DialogSelect } from "./ui/dialog-select"
import { listed } from "./util/sessions-overview"
import { AccountProvider, useAccount } from "./context/account"
import { Welcome } from "./component/welcome"
import { DisabledAccount } from "./component/disabled-account"
import { DialogAccount } from "./component/dialog-account"
import { DialogFeedback } from "./component/dialog-feedback"
import type { Host as AccountHost } from "./util/account"

registerOpencodeSpinner()

const THEME_MODE_WAIT = 200

const appGlobalBindingCommands = [
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show",
  "model.list",
  "model.cycle_recent",
  "model.cycle_recent_reverse",
  "model.cycle_favorite",
  "model.cycle_favorite_reverse",
  "mode.list",
  "permission.mode",
  "mcp.list",
  "mode.cycle",
  "mode.cycle.reverse",
  "variant.cycle",
  "variant.list",
  "provider.list",
  "console.org.switch",
  "opencode.status",
  "opencode.debug",
  "theme.switch",
  "theme.switch_mode",
  "theme.mode.lock",
  "help.show",
  "docs.open",
  "diff.open",
  "workspace.list",
  "app.debug",
  "app.console",
  "app.heap_snapshot",
  "app.restart",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.sounds",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
  "agent.monitor",
] as const

export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  /** Called once the app listens for server events, so one-off events sent after it aren't lost. */
  onListening?: () => void
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  pluginHost: TuiPluginHost
  /** XCOD-129: offers `/restart`, and receives the request once the user confirms it. */
  restart?: RestartHost
  /** XCOD-129: set when this process is the relaunch of a `/restart`. */
  restarted?: Restarted & { sessionID?: string }
  /** XCOD-276: quit once this settles (`lunos debug startup`). */
  quit?: Promise<void>
  /** Called once the TUI has loaded its data: a relaunch counts as started from here. */
  onStarted?: () => void
  /** XCOD-273: the Lunos account (Welcome screen, /login, /logout, /account), run by the CLI process. */
  account?: AccountHost
  /** XCOD-281: the sandbox starting behind the TUI, or turned off after a failure. */
  sandbox?: SandboxHost
  /** XCOD-301: sandboxes whose results a background handoff couldn't save (the toast at start). */
  handback?: SandboxHandback
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const global = yield* Global.Service
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown, restarting: false }
  // XCOD-129: a restart replaces this process, so the "continue with lunos -s" epilogue is noise.
  const restartHost: RestartHost | undefined = input.restart && {
    ...input.restart,
    request: (request) => {
      exit.restarting = true
      input.restart?.request(request)
    },
  }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            StartupTrace.span("create renderer", () =>
              createCliRenderer({
                externalOutputMode: "passthrough",
                targetFps: 60,
                gatherStats: false,
                exitOnCtrlC: false,
                useKittyKeyboard: {},
                autoFocus: false,
                openConsoleOnError: false,
                useMouse: !Flag.OPENCODE_DISABLE_MOUSE && input.config.mouse,
                consoleOptions: {
                  keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
                },
              }),
            ),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        (renderer) =>
          Effect.sync(() => {
            destroyRenderer(renderer)
          }),
      )
      win32DisableProcessedInput()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerOpencodeKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await input.pluginHost.dispose()
          } catch (error) {
            console.error("Failed to dispose TUI plugins", error)
          }
        }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(TuiAudio.dispose))
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))
      void input.quit?.then(() => destroyRenderer(renderer))
      const pluginRuntime = createPluginRuntime()

      yield* Effect.tryPromise(async () => {
        // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        // XCOD-276: a terminal answers this in a few ms or never; a later answer still switches the theme
        // mode (ThemeProvider listens), so a silent terminal costs 200 ms, not a second, on every start.
        const mode =
          (await StartupTrace.span("terminal theme mode", () => renderer.waitForThemeMode(THEME_MODE_WAIT))) ?? "dark"
        if (renderer.isDestroyed) return

        const mount = StartupTrace.begin("mount app")
        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                destroyRenderer(renderer)
              }}
            >
              <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <TuiPathsProvider
                    value={{
                      cwd: process.cwd(),
                      home: global.home,
                      state: global.state,
                      worktree: global.data + "/worktree",
                    }}
                  >
                    <TuiTerminalEnvironmentProvider
                      value={{
                        platform: process.platform,
                        multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                        displayServer: process.env.WAYLAND_DISPLAY
                          ? "wayland"
                          : process.env.DISPLAY
                            ? "x11"
                            : undefined,
                      }}
                    >
                      <TuiStartupProvider
                        value={{
                          initialRoute: process.env.OPENCODE_ROUTE ? JSON.parse(process.env.OPENCODE_ROUTE) : undefined,
                          skipInitialLoading: Boolean(process.env.OPENCODE_FAST_BOOT),
                        }}
                      >
                        <ClipboardProvider>
                          <OpencodeKeymapProvider keymap={keymap}>
                            <ArgsProvider {...input.args}>
                              <KVProvider>
                                <ToastProvider>
                                  {/* XCOD-273: above the dialogs, which /account and /settings open. */}
                                  <AccountProvider host={input.account}>
                                    <RouteProvider
                                      initialRoute={
                                        input.args.continue
                                          ? {
                                              type: "session",
                                              sessionID: "dummy",
                                            }
                                          : undefined
                                      }
                                    >
                                      <TuiConfigProvider config={input.config}>
                                        <PluginRuntimeProvider value={pluginRuntime}>
                                          <SandboxProvider host={input.sandbox}>
                                            <SDKProvider
                                              url={input.url}
                                              directory={input.directory}
                                              fetch={input.fetch}
                                              headers={input.headers}
                                              events={input.events}
                                            >
                                              <PermissionProvider>
                                                <ProjectProvider>
                                                  <SyncProvider>
                                                    <DataProvider>
                                                      <ThemeProvider mode={mode}>
                                                        <LocalProvider>
                                                          <PromptStashProvider>
                                                            <DialogProvider>
                                                              <FrecencyProvider>
                                                                <PromptHistoryProvider>
                                                                  <PromptRefProvider>
                                                                    <EditorContextProvider>
                                                                      <LocationProvider>
                                                                        <App
                                                                          onSnapshot={input.onSnapshot}
                                                                          onListening={input.onListening}
                                                                          pluginHost={input.pluginHost}
                                                                          restart={restartHost}
                                                                          restarted={input.restarted}
                                                                          onStarted={input.onStarted}
                                                                          handback={input.handback}
                                                                        />
                                                                      </LocationProvider>
                                                                    </EditorContextProvider>
                                                                  </PromptRefProvider>
                                                                </PromptHistoryProvider>
                                                              </FrecencyProvider>
                                                            </DialogProvider>
                                                          </PromptStashProvider>
                                                        </LocalProvider>
                                                      </ThemeProvider>
                                                    </DataProvider>
                                                  </SyncProvider>
                                                </ProjectProvider>
                                              </PermissionProvider>
                                            </SDKProvider>
                                          </SandboxProvider>
                                        </PluginRuntimeProvider>
                                      </TuiConfigProvider>
                                    </RouteProvider>
                                  </AccountProvider>
                                </ToastProvider>
                              </KVProvider>
                            </ArgsProvider>
                          </OpencodeKeymapProvider>
                        </ClipboardProvider>
                      </TuiStartupProvider>
                    </TuiTerminalEnvironmentProvider>
                  </TuiPathsProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
        mount()
      })
      yield* Deferred.await(shutdown)
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (result.reason !== undefined) {
      process.stderr.write((cliErrorMessage(result.reason) ?? errorFormat(result.reason)) + "\n")
      process.exitCode = 1
    }
    if (result.epilogue && !exit.restarting) process.stdout.write(result.epilogue + "\n")
  })
})

function App(props: {
  onSnapshot?: () => Promise<string[]>
  onListening?: () => void
  pluginHost: TuiPluginHost
  restart?: RestartHost
  restarted?: Restarted & { sessionID?: string }
  onStarted?: () => void
  handback?: SandboxHandback
}) {
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useOpencodeKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode, locked, lock, unlock } = themeState
  const sync = useSync()
  const project = useProject()
  const exit = useExit()
  const externalExit = useExternalExit()
  const promptRef = usePromptRef()
  const pluginRuntime = usePluginRuntime()
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
  const clipboard = useClipboard()
  const account = useAccount()
  const sandbox = useSandbox()

  const api = createTuiApi(
    createTuiApiAdapters({
      version: InstallationVersion,
      tuiConfig,
      dialog,
      keymap,
      kv,
      route,
      routes: pluginRuntime.routes,
      event,
      sdk,
      sync,
      theme: themeState,
      toast,
      renderer,
      attention,
      Slot: pluginRuntime.Slot,
    }),
  )
  const [ready, setReady] = createSignal(false)
  // XCOD-280: LUNOS_DEBUG_CRASH=tui makes the TUI crash once it's up, to check what a crash leaves
  // behind (the crash screen, then the log link when Lunos exits).
  if (process.env.LUNOS_DEBUG_CRASH === "tui") {
    const [crash, setCrash] = createSignal(false)
    setTimeout(() => setCrash(true), 1500)
    createEffect(() => {
      if (crash()) throw new Error("Deliberate crash (LUNOS_DEBUG_CRASH=tui)")
    })
  }
  // XCOD-147: set only by this session's update check, never from persisted state, so the notice
  // can't outlive a switch that turned checks off.
  const [availableVersion, setAvailableVersion] = createSignal<string | undefined>()
  const updateNotice = createMemo(() => {
    const version = availableVersion()
    return version && InstallationVersion !== "local" && isVersionGreater(version, InstallationVersion)
      ? version
      : undefined
  })
  // XCOD-276: plugins load behind the first frame. They start before the session data is in, so
  // `api.state.ready` can still be false when a plugin starts; the built-in ones read state reactively.
  // Starting here, not later, sets up the plugin slots that hold the home screen's logo and prompt.
  const plugins = StartupTrace.begin("load tui plugins", { blocking: false })
  props.pluginHost
    .start({
      api,
      config: tuiConfig,
      runtime: pluginRuntime,
      dispose: () => attention.dispose(),
    })
    .catch((error) => {
      console.error("Failed to load TUI plugins", error)
    })
    .finally(() => {
      plugins()
      setReady(true)
    })

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.OPENCODE_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("Lunos")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("Lunos")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "…" : session.title
      renderer.setTerminalTitle(`OC | ${title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`OC | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    for (const item of tuiConfig.deprecatedKeybinds) {
      toast.show({
        variant: "warning",
        message: `Keybind "${item.legacy}" is deprecated, use "${item.canonical}" instead`,
        duration: 5000,
      })
    }
    batch(() => {
      if (args.mode) local.mode.set(args.mode)
      if (args.model) {
        const { providerID, modelID } = Model.parse(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
          // XCOD-129: after /restart, the unsent prompt comes back with the session.
          prompt: props.restarted?.draft,
        })
      } else if (props.restarted?.draft) {
        route.navigate({ type: "home", prompt: props.restarted.draft })
      }
    })
    // XCOD-128: `lunos settings` starts on the settings screen.
    if (args.settings) dialog.replace(() => <DialogSettings tab={args.settings} />)
    // XCOD-281: a start without the sandbox right after it failed isn't a restart the user asked for.
    if (props.restarted && (!props.restarted.sandbox || props.restarted.sandbox.off))
      toast.show({
        variant: "success",
        // XCOD-297: after turning it off in /settings.
        message:
          restartBanner(props.restarted, InstallationVersion) +
          (props.restarted.sandbox?.off ? "\nThe sandbox is off: Lunos runs on this computer." : ""),
        duration: 8000,
      })
    announceSandbox()
    announceUnsaved()
    // XCOD-248: the first start of a newer version shows what changed since the one seen before.
    const whatsNew = whatsNewOnStart({
      current: InstallationVersion,
      seen: kv.get("whats_new_seen"),
      enabled: tuiConfig.whats_new !== false,
    })
    if (whatsNew.record) {
      if (whatsNew.show) kv.set("whats_new_from", whatsNew.show.since)
      kv.set("whats_new_seen", whatsNew.record)
    }
    if (whatsNew.show) setPendingWhatsNew(whatsNew.show.since)
    if (whatsNew.hint)
      toast.show({ variant: "info", message: "See what changed in each version: /whatsnew", duration: 6000 })
  })

  // Shown once nothing else is: a start-up dialog (connect a provider, `lunos settings`) would
  // otherwise replace it, and the version already counts as seen.
  const [pendingWhatsNew, setPendingWhatsNew] = createSignal<string>()

  function showWhatsNew(since: string | undefined) {
    const to = Changelog.current(InstallationVersion)
    if (!to) return
    const from = since ?? Changelog.previous(to)
    const [title, ...lines] = Changelog.summary({ since: from, to })
    void DialogAlert.show(dialog, title!, lines.join("\n"))
  }

  // XCOD-129: a relaunch has started once its data is loaded; a later error is an ordinary one.
  let started = false
  createEffect(() => {
    if (started || sync.status !== "complete") return
    started = true
    props.onStarted?.()
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined && listed(x))?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  createEffect(
    on(
      // XCOD-273: not over the Welcome screen; it opens once the screen is passed.
      () => sync.status === "complete" && sync.data.provider.length === 0 && !account.blocks(),
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderConnect />)
      },
    ),
  )

  // XCOD-273: nothing opens over the Welcome screen: the command palette, a keybind's dialog, or
  // `lunos settings`'s settings window are closed while it stands.
  createEffect(() => {
    if (account.blocks() && dialog.stack.length > 0) dialog.clear()
  })

  // XCOD-248: after the effect above, so a "connect a provider" dialog opens first and the panel waits.
  createEffect(() => {
    const since = pendingWhatsNew()
    if (!since || sync.status !== "complete" || dialog.stack.length > 0 || account.blocks()) return
    setPendingWhatsNew(undefined)
    showWhatsNew(since)
  })

  const connected = useConnected()
  const currentWorktreeWorkspace = createMemo(() => {
    const workspaceID = project.workspace.current()
    if (!workspaceID) return
    const workspace = project.workspace.get(workspaceID)
    if (workspace?.type !== "worktree" || !workspace.directory) return
    return workspace
  })
  // XCOD-129: /restart. Set by /update, so the restart runs the newly installed version.
  const [upgradedTo, setUpgradedTo] = createSignal<string | undefined>()
  // XCOD-247: the update this session is running, shown bottom-right until it ends.
  const [upgrading, setUpgrading] = createSignal<UpgradeProgress>()
  // While "wait for the current turn" is pending; running /restart again cancels it.
  const [restartPending, setRestartPending] = createSignal<{ cancel: () => void } | undefined>()

  const busySessionIDs = () =>
    Object.entries(sync.data.session_status)
      .filter(([, status]) => status && status.type !== "idle")
      .map(([id]) => id)

  // Every job, not only this session's: shutting the worker down stops all of them.
  async function runningJobs() {
    const result = await sdk.client.experimental.background.list().catch(() => undefined)
    return (result?.data ?? []).filter((job) => job.status === "running")
  }

  async function settled(timeout: number | undefined, cancelled: () => boolean) {
    const deadline = timeout === undefined ? undefined : Date.now() + timeout
    while (!cancelled()) {
      if (busySessionIDs().length === 0 && (await runningJobs()).length === 0) return true
      if (deadline !== undefined && Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return false
  }

  // XCOD-281: the sandbox failed behind the TUI: start again without it, handing over the prompt in
  // the box (and whether it was waiting to be sent). It's never sent to this computer from here.
  createEffect(
    on(
      () => sandbox.state()?.status,
      (status) => {
        if (status !== "failed") return
        const host = props.restart
        if (!host) return
        const draft = restartDraft(promptRef.current?.current)
        host.request({ fresh: true, draft, cancelled: [], sandbox: "failed", queued: !!draft && sandbox.queued() })
        exit()
      },
    ),
  )

  /** The sticky toast, once, right after the sandbox failed. Later starts only show the badge. */
  function announceSandbox() {
    const state = sandbox.state()
    if (state?.status !== "off" || !state.announce) return
    toast.show({
      variant: "warning",
      sticky: true,
      message: failureToast(state.failure),
      actions: [
        { label: "Open log", onSelect: () => openSandboxLog() },
        { label: "Retry", onSelect: () => retrySandbox() },
        {
          label: "Settings",
          onSelect: () => dialog.replace(() => <DialogSettings area="Permissions" sub="Sandbox" />),
        },
      ],
    })
  }

  /**
   * XCOD-301: results a background handoff couldn't save (the sandbox is kept, stopped): the newest
   * one, with Retry, Open log and Attach; the others are counted. Shown at every start until saved.
   */
  function announceUnsaved() {
    const handback = props.handback
    const [item, ...rest] = handback?.unsaved() ?? []
    if (!handback || !item) return
    const log = item.log
    toast.show({
      variant: "warning",
      sticky: true,
      message: unsavedToast(item, rest.length),
      actions: [
        {
          label: "Retry",
          onSelect: () => {
            toast.show({ variant: "info", sticky: true, message: `Saving the results from sandbox ${item.id}…` })
            void handback.retry(item.id).then((result) => {
              toast.dismiss()
              if (!result.ok) return announceUnsaved()
              toast.show({ variant: "success", message: `Saved the results from sandbox ${item.id}: ${result.detail}` })
            })
          },
        },
        ...(log ? [{ label: "Open log", onSelect: () => dialog.replace(() => <DialogLog file={log.file} />) }] : []),
        {
          label: "Attach",
          onSelect: () => {
            handback.attach(item.id)
            exit()
          },
        },
      ],
    })
  }

  function openSandboxLog() {
    const state = sandbox.state()
    const file = state && "failure" in state ? state.failure.log?.file : undefined
    dialog.replace(() => <DialogLog file={file} />)
  }

  /**
   * XCOD-281: Retry. Required (blocked): start it again here. Off after a failure: Lunos restarts into
   * the sandbox with a new session; this session stays on this computer.
   */
  function retrySandbox() {
    const state = sandbox.state()
    if (state?.status === "blocked") {
      sandbox.host?.retry()
      return
    }
    if (state?.status === "off") void restart(true, "retry")
  }

  async function sandboxDoctor() {
    const host = sandbox.host
    if (!host) return
    dialog.clear()
    toast.show({ variant: "info", message: "Checking whether a sandbox can start here…" })
    const report = await host.doctor().catch((error) => (error instanceof Error ? error.message : String(error)))
    toast.dismiss()
    dialog.replace(() => <DialogAlert title="Sandbox doctor" message={report} />)
  }

  async function restart(fresh: boolean, sandboxRestart?: "retry" | "off") {
    const host = props.restart
    if (!host) {
      toast.show({ variant: "warning", message: "Restart isn't available in this client." })
      return
    }
    const pending = restartPending()
    if (pending) {
      pending.cancel()
      toast.show({ variant: "info", message: "Restart cancelled." })
      return
    }
    const cancelled: string[] = []

    // Attached to a server this client doesn't own: the turn and its jobs run there and carry on.
    if (!host.attach) {
      const jobs = await runningJobs()
      // A background job's own session is busy too; count it as the job, not as a turn.
      const turns = () => busySessionIDs().filter((id) => !jobs.some((job) => job.sessionID === id))
      const message = restartBusyMessage({ busySessions: turns().length, runningJobs: jobs.map((j) => j.id) })
      if (message) {
        const choice = await new Promise<RestartChoice>((resolve) => {
          dialog.replace(
            () => (
              <DialogSelect<RestartChoice>
                title="Restart Lunos?"
                placeholder={message}
                skipFilter
                options={[
                  { title: "Wait for the current turn, then restart", value: "wait" },
                  { title: "Stop and restart (cancels running work)", value: "stop" },
                  { title: "Cancel", value: "cancel" },
                ]}
                onSelect={(option) => {
                  resolve(option.value)
                  dialog.clear()
                }}
              />
            ),
            () => resolve("cancel"),
          )
        })
        if (choice === "cancel") return
        if (choice === "wait") {
          let stop = false
          setRestartPending({ cancel: () => (stop = true) })
          toast.show({
            variant: "info",
            message: "Lunos will restart when the current work finishes. Run /restart again to cancel.",
            duration: 8000,
          })
          const done = await settled(undefined, () => stop)
          setRestartPending(undefined)
          if (!done) return
        }
        if (choice === "stop") {
          const busy = turns()
          if (busy.length) cancelled.push(busy.length === 1 ? "the current turn" : `${busy.length} running turns`)
          for (const job of jobs) cancelled.push(`background job ${job.title ?? job.id}`)
          await Promise.all([
            ...busy.map((sessionID) => sdk.client.session.abort({ sessionID }).catch(() => {})),
            ...jobs.map((job) => sdk.client.experimental.background.cancel({ jobID: job.id }).catch(() => {})),
          ])
          // Never restart while a tool may still be writing: wait until the aborted work has
          // actually stopped, and give up (without restarting) if it doesn't.
          if (!(await settled(15_000, () => false))) {
            toast.show({
              variant: "error",
              message: "The running work didn't stop within 15s, so Lunos didn't restart. Try /restart again.",
              duration: 8000,
            })
            return
          }
        }
      }
    }

    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    // Read last: while waiting, the user may have typed more, or sent what was there.
    const draft = restartDraft(promptRef.current?.current)
    host.request({
      sessionID: fresh ? undefined : sessionID,
      fresh,
      draft,
      cancelled,
      upgraded: upgradedTo(),
      ...(sandboxRestart ? { sandbox: sandboxRestart } : {}),
    })
    if (host.attach)
      toast.show({
        variant: "info",
        message: `Restarting this client only; the server at ${host.attach} keeps running.`,
      })
    exit()
  }

  // XCOD-250: whether /claude and /codex can start here, asked once external sessions are known to be on.
  const externalOn = createMemo(() => sync.data.config.external?.enabled !== false)
  const [externalTools, setExternalTools] = createSignal<ExternalToolStatus[]>()
  createEffect(() => {
    if (!externalOn() || !toolsWanted() || sync.status !== "complete" || externalTools()) return
    void sdk.client.experimental.external
      .tools()
      .then((result) => setExternalTools(result.data ?? []))
      .catch(() => setExternalTools([]))
  })
  // Once per tool: the user's own /claude or /codex command shadows Lunos's.
  createEffect(() => {
    if (!externalOn() || sync.status !== "complete") return
    for (const tool of ["claude", "codex"] as const) {
      if (!sync.data.command.some((item) => item.name === tool) || kv.get(`external_shadowed_${tool}`)) continue
      kv.set(`external_shadowed_${tool}`, true)
      toast.show({
        variant: "info",
        message: `Your own /${tool} command runs, not Lunos's. Lunos's is /external ${tool}.`,
        duration: 8000,
      })
    }
  })
  const runExternalCommand = useExternalCommand()

  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: "Show command palette",
        category: "System",
        hidden: true,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "session.list",
        title: "Switch session",
        category: "Session",
        suggested: sync.data.session.length > 0,
        // XCOD-205: /sessions is the all-projects view below; this project's switcher (pins, quick
        // slots, delete) keeps its keybinding and /resume, /continue.
        slashName: "resume",
        slashAliases: ["continue"],
        run: () => {
          dialog.replace(() => <DialogSessionList />)
        },
      },
      {
        // XCOD-205: every session on this machine, across projects, in the groups shared with desktop/web.
        name: "session.overview",
        title: "Sessions in all projects and groups",
        category: "Session",
        slashName: "sessions",
        run: () => {
          dialog.replace(() => <DialogSessions />)
        },
      },
      {
        // XCOD-298: repositories and named projects (several folders counted as one).
        name: "project.list",
        title: "Projects",
        category: "Session",
        slashName: "projects",
        run: () => {
          dialog.replace(() => <DialogProjects />)
        },
      },
      {
        // XCOD-262: every session on this computer beside a prompt that starts or tags them.
        name: "agent.monitor",
        title: "Agent Monitor",
        category: "Session",
        slashName: "monitor",
        run: () => {
          if (route.data.type === "plugin" && route.data.id === MONITOR_ROUTE) return
          const from =
            route.data.type === "session" ? { type: "session", sessionID: route.data.sessionID } : { type: "home" }
          dialog.clear()
          route.navigate({ type: "plugin", id: MONITOR_ROUTE, data: { from } })
        },
      },
      {
        name: "artifact.list",
        title: "Plans and research notes",
        category: "Session",
        slashName: "artifacts",
        slashAliases: ["plans"],
        run: () => {
          dialog.replace(() => <DialogArtifacts />)
        },
      },
      {
        name: "background.list",
        title: "Background subagents",
        category: "Session",
        slashName: "tasks",
        slashAliases: ["background"],
        run: () => {
          dialog.replace(() => <DialogBackground />)
        },
      },
      {
        name: "session.new",
        title: "New session",
        suggested: route.data.type === "session",
        category: "Session",
        slashName: "new",
        slashAliases: ["clear"],
        run: () => {
          route.navigate({
            type: "home",
          })
          dialog.clear()
        },
      },
      {
        // XCOD-218: a Claude Code / Codex session in its own session view ("/external claude" etc. from the prompt).
        name: "external.start",
        title: "Start Claude Code or Codex session",
        category: "Session",
        slashName: "external",
        run: () => {
          dialog.replace(() => <DialogExternal />)
        },
      },
      // XCOD-250: /claude and /codex, listed only while external sessions are on and the user has no
      // command of that name (theirs wins; this one stays reachable as /external claude).
      ...(["claude", "codex"] as const).map((tool) => {
        const unavailable = toolUnavailable(
          tool,
          externalTools()?.find((item) => item.tool === tool),
        )
        return {
          name: `external.${tool}`,
          title: `Give ${EXTERNAL_LABEL[tool]} a task`,
          desc: unavailable ?? `Give ${EXTERNAL_LABEL[tool]} a task: /${tool} <task>, or pick a session`,
          category: "Session",
          slashName: tool,
          slashMuted: unavailable !== undefined,
          hidden: !externalOn() || sync.data.command.some((item) => item.name === tool),
          run: () => {
            dialog.clear()
            void runExternalCommand(tool, "")
          },
        }
      }),
      {
        name: "workspace.copy_path",
        title: "Copy worktree path",
        category: "Workspace",
        enabled: () => currentWorktreeWorkspace() !== undefined,
        run: async () => {
          const workspace = currentWorktreeWorkspace()
          if (!workspace?.directory) return
          await clipboard
            .write?.(workspace.directory)
            .then(() => toast.show({ message: "Copied worktree path", variant: "info" }))
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "workspace.list",
        title: "Manage workspaces",
        category: "Workspace",
        hidden: !Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
        slashName: "workspaces",
        run: () => {
          dialog.replace(() => <DialogWorkspaceList />)
        },
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `session.quick_switch.${i + 1}`,
        title: `Switch to session in quick slot ${i + 1}`,
        category: "Session",
        hidden: true,
        run: () => {
          local.session.quickSwitch(i + 1)
        },
      })),
      {
        name: "model.list",
        title: "Switch model",
        suggested: true,
        category: "Mode",
        slashName: "models",
        // Bias /mo toward /models over /move without changing global fuzzy scoring.
        slashAliases: ["mo"],
        run: () => {
          // XCOD-254: in a Claude Code / Codex session, the tool's models; Lunos's aren't offered there.
          const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
          if (sessionID && externalOf(sync.session.get(sessionID))) {
            dialog.replace(() => <DialogExternalModel sessionID={sessionID} />)
            return
          }
          dialog.replace(() => <DialogModel />)
        },
      },
      {
        name: "model.cycle_recent",
        title: "Model cycle",
        category: "Mode",
        hidden: true,
        run: () => {
          local.model.cycle(1)
        },
      },
      {
        name: "model.cycle_recent_reverse",
        title: "Model cycle reverse",
        category: "Mode",
        hidden: true,
        run: () => {
          local.model.cycle(-1)
        },
      },
      {
        name: "model.cycle_favorite",
        title: "Favorite cycle",
        category: "Mode",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(1)
        },
      },
      {
        name: "model.cycle_favorite_reverse",
        title: "Favorite cycle reverse",
        category: "Mode",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(-1)
        },
      },
      {
        name: "mode.list",
        title: "Switch mode",
        category: "Mode",
        slashName: "modes",
        run: () => {
          dialog.replace(() => <DialogMode />)
        },
      },
      {
        // XCOD-210: /agents edits agents. It used to be a deprecated alias of /modes (XCOD-40).
        name: "agent.edit",
        title: "Edit agents",
        category: "Mode",
        slashName: "agents",
        run: () => {
          dialog.replace(() => <DialogAgentList />)
        },
      },
      {
        name: "mcp.list",
        title: "Toggle MCPs",
        category: "Mode",
        slashName: "mcps",
        run: () => {
          dialog.replace(() => <DialogMcp />)
        },
      },
      {
        name: "mode.cycle",
        title: "Mode cycle",
        category: "Mode",
        hidden: true,
        run: () => {
          local.mode.move(1)
        },
      },
      {
        name: "variant.cycle",
        title: "Variant cycle",
        category: "Mode",
        run: () => {
          local.model.variant.cycle()
        },
      },
      {
        name: "variant.list",
        title: "Switch model variant",
        category: "Mode",
        hidden: local.model.variant.list().length === 0,
        slashName: "variants",
        run: () => {
          if (local.model.variant.list().length === 0) {
            return toast.show({
              title: "No variants available",
              message: "The current model does not support any variants.",
              variant: "info",
            })
          }
          dialog.replace(() => <DialogVariant />)
        },
      },
      {
        name: "mode.cycle.reverse",
        title: "Mode cycle reverse",
        category: "Mode",
        hidden: true,
        run: () => {
          local.mode.move(-1)
        },
      },
      {
        name: "provider.list",
        title: "Providers",
        suggested: !connected(),
        slashName: "providers",
        // XCOD-130: the old slash name still resolves here, with a rename hint. Remove in 1.21.0.
        slashAliases: ["connect"],
        slashAliasHints: { connect: "/connect is now /providers" },
        run: () => {
          dialog.replace(() => <DialogProviders />)
        },
        category: "Provider",
      },
      {
        // XCOD-130: pre-rename command id, kept for plugins and /tui/execute-command callers.
        name: "provider.connect",
        title: "Providers",
        category: "Provider",
        hidden: true,
        run: () => {
          dialog.replace(() => <DialogProviders />)
        },
      },
      ...(sync.data.console_state.switchableOrgCount > 1
        ? [
            {
              name: "console.org.switch",
              title: "Switch org",
              suggested: Boolean(sync.data.console_state.activeOrgName),
              slashName: "org",
              slashAliases: ["orgs", "switch-org"],
              run: () => {
                dialog.replace(() => <DialogConsoleOrg />)
              },
              category: "Provider",
            },
          ]
        : []),
      ...(account.host
        ? [
            {
              // XCOD-273: the Welcome screen's sign-in, at any time.
              name: "account.login",
              title: "Sign in to your Lunos account",
              slashName: "login",
              run: async () => {
                dialog.clear()
                if (account.exempt() === "offline")
                  return toast.show({
                    variant: "warning",
                    message: "Offline mode (LUNOS_OFFLINE) is on: signing in is off.",
                  })
                const signed = await account.host?.current()
                if (signed)
                  return toast.show({
                    variant: "info",
                    message: `Already signed in as ${signed.email ?? signed.sub}. /logout first to switch account.`,
                  })
                account.login()
              },
              category: "Account",
            },
            {
              name: "account.logout",
              title: "Sign out of your Lunos account",
              slashName: "logout",
              run: async () => {
                dialog.clear()
                const result = await account.host?.logout()
                toast.show({
                  variant: "info",
                  message:
                    result?.revoked === false
                      ? "Signed out here; the sign-in service couldn't be told."
                      : "Signed out.",
                })
                account.signedOut()
              },
              category: "Account",
            },
            {
              name: "account.show",
              title: "Your Lunos account",
              desc: "Plan, organisations, devices; sign out everywhere; delete the account",
              slashName: "account",
              // XCOD-312: a disabled account's /account is the notice again (Lunos Cloud would refuse the rest).
              run: () => (account.disabled() ? account.showDisabled() : dialog.replace(() => <DialogAccount />)),
              category: "Account",
            },
            {
              // XCOD-318: feedback to the Lunos team (the session's id only if you choose to share it).
              name: "account.feedback",
              title: "Send feedback to the Lunos team",
              slashName: "feedback",
              run: async () => {
                if (!account.host?.feedback)
                  return toast.show({
                    variant: "warning",
                    message: "This Lunos can't send feedback; update it (/update).",
                  })
                if (account.exempt() === "offline")
                  return toast.show({
                    variant: "warning",
                    message: "Offline mode (LUNOS_OFFLINE) is on: feedback can't be sent.",
                  })
                if (!(await account.host?.current()))
                  return toast.show({
                    variant: "info",
                    message: "Sign in to your Lunos account first (/login) to send feedback.",
                  })
                dialog.replace(() => (
                  <DialogFeedback sessionID={route.data.type === "session" ? route.data.sessionID : undefined} />
                ))
              },
              category: "Account",
            },
          ]
        : []),
      {
        // XCOD-128: every configuration option in one place; /config is Claude Code's name for it.
        name: "settings.open",
        title: "Settings",
        slashName: "settings",
        slashAliases: ["config"],
        run: () => {
          // XCOD-259: `/settings <section> [sub-tab]` lands there; an unknown name shows the home.
          const request = takeSettingsRequest()
          // XCOD-273: /settings account is /account.
          if (account.host && request && "unknown" in request && /^account/i.test(request.unknown))
            return dialog.replace(() => <DialogAccount />)
          if (request && "unknown" in request)
            toast.show({ variant: "warning", message: `No settings section "${request.unknown}"` })
          const area = request && "category" in request ? request : undefined
          dialog.replace(
            () => <DialogSettings tab="settings" area={area?.category} sub={area?.sub} />,
            undefined,
            area
              ? { back: () => dialog.replace(() => <DialogSettings tab="settings" focus={`+area:${area.category}`} />) }
              : undefined,
          )
        },
        category: "System",
      },
      {
        name: "opencode.status",
        title: "View status",
        slashName: "status",
        run: () => {
          dialog.replace(() => <DialogStatus />)
        },
        category: "System",
      },
      {
        name: "opencode.debug",
        title: "View debug info",
        slashName: "debug",
        run: () => {
          dialog.replace(() => <DialogDebug />)
        },
        category: "System",
      },
      {
        name: "opencode.logs",
        title: "View logs",
        slashName: "logs",
        run: () => {
          dialog.replace(() => <DialogLogs />)
        },
        category: "System",
      },
      {
        name: "theme.switch",
        title: "Switch theme",
        slashName: "themes",
        run: () => {
          dialog.replace(() => <DialogThemeList />)
        },
        category: "System",
      },
      {
        name: "theme.switch_mode",
        title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
        run: () => {
          setMode(mode() === "dark" ? "light" : "dark")
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "theme.mode.lock",
        title: locked() ? "Unlock theme mode" : "Lock theme mode",
        run: () => {
          if (locked()) unlock()
          else lock()
          dialog.clear()
        },
        category: "System",
      },
      {
        // XCOD-257: whether LSP works, each server's state and why one failed.
        name: "lsp.panel",
        title: "Language servers (LSP)",
        slashName: "lsp",
        run: () => {
          dialog.replace(() => <DialogLsp />)
        },
        category: "System",
      },
      {
        name: "help.show",
        title: "Help",
        slashName: "help",
        run: () => {
          dialog.replace(() => <DialogHelp />)
        },
        category: "System",
      },
      {
        name: "docs.open",
        title: "Open docs",
        run: () => {
          openUrl("https://docs.lunos.tech/docs/").catch(() => {})
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "app.whatsnew",
        title: "What's new",
        desc: "What changed since your previous version",
        slashName: "whatsnew",
        run: () => {
          dialog.clear()
          showWhatsNew(kv.get("whats_new_from"))
        },
        category: "System",
      },
      {
        name: "app.upgrade",
        title: "Update Lunos",
        slashName: "update",
        // `/upgrade` was the name until XCOD-147; it keeps working.
        slashAliases: ["upgrade"],
        run: () => {
          dialog.clear()
          void runUpgrade(undefined)
        },
        category: "System",
      },
      ...(props.restart
        ? [
            {
              name: "app.restart",
              title: "Restart Lunos",
              desc: props.restart.attach ? "Restart this client (the server keeps running)" : undefined,
              slashName: "restart",
              run: () => {
                dialog.clear()
                void restart(false)
              },
              category: "System",
            },
            {
              name: "app.restart.fresh",
              title: "Restart Lunos in a new session",
              run: () => {
                dialog.clear()
                void restart(true)
              },
              category: "System",
            },
          ]
        : []),
      // XCOD-297: /settings turned the sandbox off: restart without it (asked first if work is running).
      {
        name: "sandbox.off",
        title: "Restart without the sandbox",
        hidden: true,
        run: () => void restart(false, "off"),
        category: "System",
      },
      // XCOD-281: the sandbox's Retry, its doctor and the last failure's log, from the keyboard.
      ...(sandbox.host
        ? [
            {
              name: "sandbox.retry",
              title: "Retry the sandbox",
              slashName: "sandbox-retry",
              run: () => {
                dialog.clear()
                retrySandbox()
              },
              category: "System",
            },
            {
              name: "sandbox.doctor",
              title: "Check the sandbox (lunos sandbox doctor)",
              slashName: "sandbox-doctor",
              run: () => void sandboxDoctor(),
              category: "System",
            },
          ]
        : []),
      // XCOD-286: app.exit and app.quit (Quit Lunos, /exit:lunos), external-session aware.
      ...externalExit.commands(),
      {
        name: "app.debug",
        title: "Toggle debug panel",
        category: "System",
        run: () => {
          renderer.toggleDebugOverlay()
          dialog.clear()
        },
      },
      {
        name: "app.console",
        title: "Toggle console",
        category: "System",
        run: () => {
          renderer.console.toggle()
          dialog.clear()
        },
      },
      {
        name: "app.heap_snapshot",
        title: "Write heap snapshot",
        category: "System",
        run: async () => {
          const files = await props.onSnapshot?.()
          toast.show({
            variant: "info",
            message: `Heap snapshot written to ${files?.join(", ")}`,
            duration: 5000,
          })
          dialog.clear()
        },
      },
      {
        name: "terminal.suspend",
        title: "Suspend terminal",
        category: "System",
        hidden: true,
        enabled: process.platform !== "win32",
        run: () => {
          renderer.suspend()
          process.once("SIGCONT", () => renderer.resume())
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
        category: "System",
        run: () => {
          setTerminalTitleEnabled((prev) => {
            const next = !prev
            kv.set("terminal_title_enabled", next)
            if (!next) renderer.setTerminalTitle("")
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title:
          tuiConfig.reduced_motion === true
            ? "Animations are off (reduced_motion in config)"
            : animationsEnabled(tuiConfig.reduced_motion, kv.get("animations_enabled"))
              ? "Disable animations"
              : "Enable animations",
        category: "System",
        run: () => {
          if (tuiConfig.reduced_motion !== true)
            kv.set("animations_enabled", !animationsEnabled(tuiConfig.reduced_motion, kv.get("animations_enabled")))
          dialog.clear()
        },
      },
      {
        // XCOD-311: attention.sound, saved to the user config and applied at once. Unbound by default.
        name: "app.toggle.sounds",
        title: "Mute / unmute sounds",
        category: "System",
        run: () => {
          dialog.clear()
          const next = !tuiConfig.attention.sound
          void sdk.client.config
            .settingsSet({ settingsSetInput: { key: "tui.attention.sound", value: String(next), scope: "user" } })
            .then((result) => {
              if (!result.data?.ok) throw new Error(result.data && !result.data.ok ? result.data.error : "no answer")
              tuiConfig.attention.sound = next
              toast.show({
                variant: "info",
                message: next
                  ? tuiConfig.attention.enabled
                    ? "Sounds on"
                    : "Sounds on, but alerts are off (/settings notifications)"
                  : "Sounds muted",
              })
            })
            .catch((error: unknown) =>
              toast.show({
                variant: "error",
                message: `Sounds not changed: ${error instanceof Error ? error.message : String(error)}`,
              }),
            )
        },
      },
      {
        name: "app.toggle.file_context",
        title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
        category: "System",
        run: () => {
          kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
        category: "System",
        run: () => {
          const current = kv.get("diff_wrap_mode", "word")
          kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
        category: "System",
        run: () => {
          setPasteSummaryEnabled((prev) => {
            const next = !prev
            kv.set("paste_summary_enabled", next)
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.session_directory_filter",
        title: kv.get("session_directory_filter_enabled", true)
          ? "Disable session directory filtering"
          : "Enable session directory filtering",
        category: "System",
        run: async () => {
          kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
          await sync.session.refresh()
          dialog.clear()
        },
      },
      {
        // XCOD-310: Manual / Auto for the current workflow in this session (<leader>p).
        name: "permission.mode",
        title:
          local.approval.current()?.mode === "auto"
            ? `Manual approval for ${Locale.titlecase(local.mode.current()?.name ?? "this workflow")}`
            : `Auto-approve for ${Locale.titlecase(local.mode.current()?.name ?? "this workflow")}`,
        category: "System",
        run: () => {
          local.approval.toggle()
          dialog.clear()
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  )

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    // XCOD-286: a focused prompt in a Claude Code / Codex session takes these keys itself (ctrl+c
    // interrupts a working tool first), so this binding doesn't race it.
    enabled: () => externalExit.globalKeys(promptRef.current),
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  event.on("tui.command.execute", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
      // XCOD-280: an error the server reports is a background failure (an MCP server, a plugin…).
      log: evt.properties.variant === "error",
    })
  })

  event.on("tui.session.select", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  // One flow for the reminder dialog and /update. `target` undefined means "latest";
  // the server resolves it from the lunos-ai registry entry.
  async function runUpgrade(target: string | undefined) {
    const running = upgrading()
    if (running) {
      // The package manager can't be stopped safely once it runs, so a second /update only says so.
      toast.show({
        variant: "info",
        message: `An update is already running (${upgradeStepText(running.step, running.version || undefined)}). It can't be cancelled while installing.`,
      })
      return
    }
    const started = Date.now()
    setUpgrading({ step: target ? "installing" : "checking", version: target ?? "", started, stepStarted: started })

    const result = await sdk.client.global.upgrade({ target }).finally(() => setUpgrading(undefined))

    if (result.error || !result.data?.success) {
      // A refused upgrade comes back as a 400 whose body is `{ success: false, error }`.
      const body = (result.error ?? result.data) as { error?: unknown } | undefined
      const reason =
        typeof body?.error === "string" ? body.error : result.error ? errorMessage(result.error) : "Update failed"
      toast.show({
        variant: "error",
        title: "Update Failed",
        // XCOD-111: always the full `npm i -g lunos-ai@<version> --allow-scripts=lunos-ai`, using
        // the version the update check found when /update didn't name one.
        message: `${reason}\nTo update manually, run: ${manualInstallCommand(target ?? updateNotice())}`,
        duration: 15000,
      })
      return
    }

    setAvailableVersion(undefined)
    setUpgradedTo(result.data.version)
    // XCOD-129: the app stays open; /restart relaunches the new version back in this session.
    await DialogAlert.show(
      dialog,
      "Update Complete",
      `Updated to Lunos v${result.data.version}. ${updateRestartHint(result.data.version)}`,
    )
  }

  event.on("installation.upgrade-progress", (evt) => {
    const current = upgrading()
    if (!current) return
    const { step, version } = evt.properties
    if (step === current.step && version === current.version) return
    setUpgrading({ ...current, step, version, stepStarted: step === current.step ? current.stepStarted : Date.now() })
  })

  event.on("installation.update-available", async (evt) => {
    const version = evt.properties.version
    // Kept after the dialog is dismissed or skipped: the bottom-right notice stays until the
    // update is installed.
    setAvailableVersion(version)

    const skipped = kv.get("skipped_version")
    if (skipped && !isVersionGreater(version, skipped)) return
    // XCOD-273: not over the Welcome screen; the bottom-right notice still says an update exists.
    if (account.blocks()) return

    const choice = await DialogConfirm.show(
      dialog,
      `Update Available`,
      `${newVersionMessage(version)} (you have ${InstallationVersion}), or /update here.\nRelease notes: https://github.com/AxsionDev/Lunos/releases/tag/v${version}\n\nUpdate now?`,
      "skip",
    )

    // Once per new version: "skip" and Esc both mean "not now", and the bottom-right notice keeps
    // saying the update exists. Without this the dialog blocked every start (XCOD-147).
    if (choice !== true) {
      kv.set("skipped_version", version)
      return
    }

    await runUpgrade(version)
  })
  // The update check (XCOD-147) starts only once mounted, when the SDK's event subscription (set up
  // in its provider's onMount, which runs first) and the handler above both exist.
  onMount(() => props.onListening?.())

  // XCOD-276: the start-up timeline ends at the first frame that shows the home screen (or Welcome).
  createEffect(() => {
    const welcome = account.blocks() && (account.phase() === "welcome" || account.phase() === "disabled")
    if (!welcome && !(shown() && !account.blocks())) return
    renderer.once("frame", () => StartupTrace.firstFrame(welcome ? "first frame (welcome)" : "first frame"))
    renderer.requestRender()
  })

  // XCOD-276: the home screen doesn't wait for plugins or the server: plugin slots fill in as plugins
  // load. A session waits for its data, and a plugin's own screen for the plugins.
  const shown = createMemo(() => {
    if (route.data.type === "session") return sync.ready
    if (route.data.type === "plugin") return ready()
    return true
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    if (route.data.id === MONITOR_ROUTE) return <AgentMonitor params={route.data.data} />
    const render = pluginRuntime.routes.get(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        !Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
          ? () => Selection.copy(renderer, toast, clipboard)
          : undefined
      }
    >
      <Show when={Flag.OPENCODE_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      {/* XCOD-273: the Welcome screen stands in front of the app, without waiting for plugins or sync. */}
      <Show when={account.blocks() && account.phase() === "welcome"}>
        <Welcome />
      </Show>
      {/* XCOD-312: a disabled account's notice, in front of the app until it's left for read-only use. */}
      <Show when={account.blocks() && account.phase() === "disabled"}>
        <DisabledAccount />
      </Show>
      <Show when={!account.blocks()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session" && sync.ready}>
              <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
                {(_) => <Session />}
              </Show>
            </Match>
          </Switch>
          {plugin()}
        </box>
        <StartupStatus plugins={ready} />
        <SandboxStatus retry={retrySandbox} openLog={openSandboxLog} />
        <Show when={upgrading()} fallback={<UpdateNotice version={updateNotice()} />}>
          <UpdateProgress progress={upgrading()} />
        </Show>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>
        <pluginRuntime.Slot name="app" />
      </Show>
    </box>
  )
}
