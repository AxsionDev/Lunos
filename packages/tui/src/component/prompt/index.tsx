import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import { useAnimationsEnabled } from "../../context/motion"
import type { CommandContext } from "@opentui/keymap"
import {
  createEffect,
  createMemo,
  onMount,
  createSignal,
  onCleanup,
  on,
  Show,
  Switch,
  Match,
  useContext,
} from "solid-js"
import { registerOpencodeSpinner } from "../register-spinner"
import path from "path"
import { fileURLToPath } from "url"
import { useLocal } from "../../context/local"
import { Flag } from "@opencode-ai/core/flag/flag"
import { tint, useTheme } from "../../context/theme"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { Spinner } from "../spinner"
import { WorkingTip } from "../tips"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { useBudget } from "../budget-meter"
import { workflowsLabel } from "../../util/workflows"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
import { normalizePromptContent, openEditor } from "../../editor"
import { EXIT_WORDS, exitIntent, useExternalExit } from "../external-exit"
import { promptOffsetWidth } from "../../prompt/display"
import { createStore, produce, unwrap } from "solid-js/store"
import { usePromptHistory, type PromptInfo } from "../../prompt/history"
import { computePromptTraits } from "../../prompt/traits"
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
import { usePromptStash } from "../../prompt/stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteOption, type AutocompleteRef, Autocomplete } from "./autocomplete"
import { leftOpensMonitor, takeoverChoices, takeoverQuestion } from "../../util/agent-monitor"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { AssistantMessage, FilePart, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import { formatDuration } from "../../util/format"
import { createColors, createFrames } from "../../ui/spinner"
import { useDialog } from "../../ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { DialogSelect } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { createDoublePress } from "../../util/dismiss"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { DialogMemory } from "../dialog-memory"
import { DialogWorkspaceUnavailable } from "../dialog-workspace-unavailable"
import { useArgs } from "../../context/args"
import { AccountContext } from "../../context/account"
import { stringifyKeyStroke, type Binding } from "@opentui/keymap"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useLeaderActive, useOpencodeKeymap } from "../../keymap"
import { useTuiConfig } from "../../config"
import { usePromptWorkspace } from "./workspace"
import { usePromptMove } from "./move"
import { readLocalAttachment } from "./local-attachment"
import { useLocation } from "../../context/location"
import { parseRestartSlash } from "../../util/restart"
import { parseSettingsSlash } from "../../util/settings"
import {
  EXTERNAL_BADGE,
  EXTERNAL_LABEL,
  externalAccent,
  externalBadge,
  externalContext,
  bridgeLine,
  externalOf,
  parseExternalSlash,
  parseToolSlash,
} from "../../util/external"
import { lunosCommand, MAPPED, UNAVAILABLE } from "../../util/external-commands"
import * as Sections from "../../util/settings-sections"
import { requestSettings } from "../../util/settings-sections"
import { useSandbox } from "../../context/sandbox"
import { holds, SEND_QUESTION } from "../../util/sandbox"
import { parseMarketplaceSlash, requestDiscover } from "../../util/marketplace"
import { DialogExternal, useExternalCommand, useStartExternal } from "../dialog-external"
import { externalModeLabel } from "../external-profile"

registerOpencodeSpinner()

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
  /**
   * XCOD-262: the Agent Monitor sends the prompt itself (to tagged sessions, or as a new session it
   * stays beside). Resolves true when it took the prompt, which is then cleared and kept in history.
   */
  onIntercept?: (text: string) => boolean | Promise<boolean>
  /** XCOD-262: more `@` completions, listed before agents and files (the monitor's sessions). */
  mentions?: () => AutocompleteOption[]
  /**
   * XCOD-262: keys the host screen takes from the prompt while autocomplete is closed: `always`
   * whatever is typed, `empty` only with nothing typed (the monitor's → and Esc).
   */
  bindings?: () => { always?: Binding<Renderable, KeyEvent>[]; empty?: Binding<Renderable, KeyEvent>[] }
}

function pastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {}
  }
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const DRAFT_RETENTION_MIN_CHARS = 20

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const leader = useLeaderActive()
  const local = useLocal()
  const args = useArgs()
  const paths = useTuiPaths()
  const location = useLocation()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const sdk = useSDK()
  const editor = useEditorContext()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const sandbox = useSandbox()
  const tuiConfig = useTuiConfig()
  // XCOD-260: in a Claude Code / Codex session the prompt says where it goes, in the tool's accent.
  const external = createMemo(() => (props.sessionID ? externalOf(sync.session.get(props.sessionID)) : undefined))
  const externalModel = createMemo(() => {
    if (!props.sessionID || !external()) return
    // XCOD-254: a model chosen with /models shows at once; the tool uses it from the next turn.
    if (external()!.model) return external()!.model
    const messages = sync.data.message[props.sessionID] ?? []
    const last = messages.findLast((item) => item.role === "assistant" && item.providerID === "external")
    const model = last?.role === "assistant" ? last.modelID : undefined
    return model && model !== external()!.tool ? model : undefined
  })
  const dialog = useDialog()
  const toast = useToast()
  const startExternal = useStartExternal()
  const runExternalCommand = useExternalCommand()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = useOpencodeKeymap()
  const modeShortcut = useCommandShortcut("mode.cycle")
  const paletteShortcut = useCommandShortcut("command.palette.show")
  const undoShortcut = useCommandShortcut("input.undo")
  const interruptShortcut = useCommandShortcut("session.interrupt")
  // The hint line's stop key, from the keybinds; the default reads "esc", as the clear key does.
  const stopKey = () => (interruptShortcut() || "escape").replace(/^escape$/, "esc")
  const renderer = useRenderer()
  const externalExit = useExternalExit()
  const dimensions = useTerminalDimensions()
  const themeState = useTheme()
  const { theme, syntax } = themeState
  const accent = createMemo(() => {
    const marker = external()
    return marker ? externalAccent(theme, marker.tool, tuiConfig.external_accent !== false) : undefined
  })
  const cursorColor = () => accent() ?? theme.text
  const kv = useKV()
  const animationsEnabled = useAnimationsEnabled()
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => kv.get("file_context_enabled", true))
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const workspace = usePromptWorkspace(props.sessionID)
  const move = usePromptMove({ projectID: project.project, sessionID: () => props.sessionID })
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const currentProviderLabel = createMemo(() => local.model.parsed().provider)
  const hasRightContent = createMemo(() => Boolean(props.right))

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on("tui.prompt.append", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = cursorColor()
    if (tuiConfig.cursor) input.cursorStyle = tuiConfig.cursor
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })

  // XCOD-298: the next turn's estimate against what's left of the project's budget.
  const budget = useBudget(() => props.sessionID)
  // XCOD-303: whether Build / Dev-Cycle dispatch subagents to do the work (/workflows on|off).
  const workflows = createMemo(() => {
    if (external()) return
    const session = props.sessionID ? sync.session.get(props.sessionID) : undefined
    return workflowsLabel({
      agent: local.mode.current()?.name,
      config: sync.data.config as Parameters<typeof workflowsLabel>[0]["config"],
      metadata: session?.metadata as Record<string, unknown> | undefined,
      child: !!session?.parentID,
    })
  })
  const usage = createMemo(() => {
    if (!props.sessionID) return
    const session = sync.session.get(props.sessionID)
    const msg = sync.data.message[props.sessionID] ?? []
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = session?.cost ?? 0
    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      syncedSessionID = sessionID

      // Only set mode if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.mode.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        // Keep command line --mode if specified.
        if (!args.mode) local.mode.set(msg.agent)
        // XCOD-218: an external session's messages name the tool, not a model to switch to.
        if (msg.model && msg.model.providerID !== "external") {
          local.model.set(msg.model)
          local.model.variant.set(msg.model.variant)
        }
      }
    }
  })

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        hidden: true,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        hidden: true,
        run: async () => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        hidden: true,
        run: async (ctx: CommandContext<Renderable, KeyEvent>) => {
          ctx.event.preventDefault()
          ctx.event.stopPropagation()
          const content = await clipboard.read?.()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
            return
          }
          if (content?.mime === "text/plain") {
            await pasteInputText(content.data)
          }
        },
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return
          // XCOD-313: with text in the prompt, Esc Esc clears it first (escapeClear); the run is untouched.
          if (escapeClears()) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slashName: "editor",
        run: async () => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await openEditor({
            renderer,
            value,
            cwd:
              (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
              project.instance.directory() ||
              paths.cwd,
          })
          if (!content) return
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = normalized.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: normalized,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(normalized)
        },
      },
      {
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slashName: "skills",
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
      {
        title: "Warp",
        desc: "Change the workspace for the session",
        name: "workspace.set",
        category: "Session",
        enabled: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
        slashName: "warp",
        run: () => {
          workspace.open()
        },
      },
      // XCOD-158: by warp, so behind the same experimental flag.
      {
        title: "Sandbox",
        desc: "Move the session into a new sandbox (/sandbox end ends it)",
        name: "sandbox.start",
        category: "Session",
        enabled: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES && !workspace.sandboxed(),
        slashName: "sandbox",
        run: () => {
          void workspace.sandbox()
        },
      },
      {
        title: "End sandbox",
        desc: "Bring the session back, and the sandbox's results with it",
        name: "sandbox.end",
        category: "Session",
        enabled: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES && workspace.sandboxed(),
        run: () => {
          void workspace.endSandbox()
        },
      },
      {
        title: "Move session",
        desc: "Move to another project dir",
        name: "session.move",
        category: "Session",
        slashName: "move",
        run: () => {
          move.open()
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: promptCommands(),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("prompt.palette", [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "prompt.skills",
      "session.interrupt",
      "workspace.set",
      "session.move",
    ]),
  }))

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.input,
        run: () => {
          if (!store.prompt.input) return
          stash.push({
            input: store.prompt.input,
            parts: store.prompt.parts,
          })
          input.extmarks.clear()
          input.clear()
          setStore("prompt", { input: "", parts: [] })
          setStore("extmarkToPartIndex", new Map())
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.input)
            setStore("prompt", { input: entry.input, parts: entry.parts })
            restoreExtmarksFromParts(entry.parts)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.input)
                setStore("prompt", { input: entry.input, parts: entry.parts })
                restoreExtmarksFromParts(entry.parts)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: stashCommands(),
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled,
      bindings: tuiConfig.keybinds.get("prompt.paste"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled && store.prompt.input !== "",
      bindings: tuiConfig.keybinds.get("prompt.clear"),
    }
  })

  // XCOD-255/313: Esc twice clears the prompt, idle or busy: the typed text is the innermost thing Esc
  // can undo. Only on an empty prompt does Esc Esc reach session.interrupt and stop the run.
  // Autocomplete and shell mode take their Esc first, so that press never counts as the first of two.
  useBindings(() => ({
    target: inputTarget,
    enabled: inputTarget() !== undefined && !props.disabled && escapeClears(),
    bindings: [{ key: "escape", desc: "Clear prompt (press twice)", group: "Prompt", cmd: escapeClear }],
  }))

  useBindings(() => ({
    target: inputTarget,
    enabled: inputTarget() !== undefined && !props.disabled && cleared() !== undefined && !hasContent(),
    priority: 10,
    bindings: tuiConfig.keybinds.get("input.undo").map((binding) => ({ ...binding, cmd: restoreCleared })),
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !props.disabled &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0 &&
          // XCOD-285: in a Claude Code / Codex session `!` is typed as is and goes to the tool with the
          // text; Lunos's shell mode would drop it and send the rest to the tool as a prompt.
          !external()
        )
      })(),
      bindings: [
        {
          key: "!",
          desc: "Shell mode",
          group: "Prompt",
          cmd: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  useBindings(() => ({
    target: inputTarget,
    enabled: inputTarget() !== undefined && !props.disabled && store.mode === "normal" && !auto()?.visible,
    priority: 10,
    bindings: props.bindings?.().always ?? [],
  }))

  useBindings(() => ({
    target: inputTarget,
    enabled:
      inputTarget() !== undefined && !props.disabled && store.mode === "normal" && !auto()?.visible && !hasContent(),
    priority: 10,
    bindings: props.bindings?.().empty ?? [],
  }))

  // XCOD-262: ← on an empty prompt opens the Agent Monitor, from home or a top-level session. With
  // text it moves the cursor; a subagent session keeps it for "previous child".
  useBindings(() => ({
    target: inputTarget,
    enabled:
      inputTarget() !== undefined &&
      !props.disabled &&
      leftOpensMonitor({
        enabled: tuiConfig.left_opens_monitor,
        route: route.data.type === "home" || route.data.type === "session" ? route.data.type : "other",
        child: route.data.type === "session" && !!sync.session.get(route.data.sessionID)?.parentID,
        text: store.prompt.input,
        parts: store.prompt.parts.length,
        mode: store.mode,
        autocomplete: !!auto()?.visible,
      }),
    priority: 10,
    bindings: [
      {
        key: "left",
        desc: "Open the Agent Monitor",
        group: "Prompt",
        cmd: () => keymap.dispatchCommand("agent.monitor"),
      },
    ],
  }))

  // XCOD-286: the exit keys that also clear the prompt (ctrl+c) interrupt a working tool, as in the
  // tool. A configured "ctrl+c,ctrl+d" is one binding; split, so each key knows which it is.
  const keyNames = (binding: { key: unknown }) =>
    typeof binding.key === "string"
      ? binding.key
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean)
      : [stringifyKeyStroke(binding.key as Parameters<typeof stringifyKeyStroke>[0])]
  const interruptKeys = createMemo(() => new Set(tuiConfig.keybinds.get("prompt.clear").flatMap(keyNames)))
  // XCOD-286: in a Claude Code / Codex session the exit keys (ctrl+c, ctrl+d, <leader>q) on an empty
  // prompt close that session, not Lunos. ctrl+c while the tool works interrupts it first, as in the
  // tool; the others ask before stopping it. app.tsx's global binding stands aside while this is live.
  useBindings(() => ({
    target: inputTarget,
    enabled:
      inputTarget() !== undefined &&
      !props.disabled &&
      !!external() &&
      store.mode === "normal" &&
      !auto()?.visible &&
      !hasContent(),
    priority: 10,
    bindings: tuiConfig.keybinds.get("app.exit").flatMap((binding) =>
      keyNames(binding).map((key) => ({
        ...binding,
        key: typeof binding.key === "string" ? key : binding.key,
        cmd: () => {
          if (!props.sessionID) return
          void externalExit.close(props.sessionID, interruptKeys().has(key) ? "interrupt" : "exit")
        },
      })),
    ),
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && store.mode === "shell",
      bindings: [{ key: "escape", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      bindings: [{ key: "backspace", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.previous",
          title: "Previous prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) input.cursorOffset = 0
              return false
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = 0
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.previous"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.next",
          title: "Next prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              )
                input.cursorOffset = input.plainText.length
              return false
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.next"),
    }
  })

  let submitting = false
  const account = useContext(AccountContext)

  // XCOD-276: the prompt works before the server has answered. A prompt sent before then is queued
  // ("Starting…" under it) and sent the moment the data is in; the text stays in the box meanwhile.
  // XCOD-281: one draft, as before. While the sandbox is starting (or required and not running) it
  // also waits: it's only ever sent to the sandbox's server, never to this computer.
  const [queued, setQueuedSignal] = createSignal(false)
  const setQueued = (value: boolean) => {
    setQueuedSignal(value)
    sandbox.setQueued(value)
  }
  const sandboxHolds = () => holds(sandbox.state())
  createEffect(
    on(
      () => [sync.status, sandboxHolds()] as const,
      ([status, held]) => {
        if (status === "loading" || held || !queued()) return
        setQueued(false)
        void submit()
      },
    ),
  )

  // XCOD-281: started again without the sandbox, the prompt that was waiting for it is back in the
  // box. Asked once: it's never sent to this computer unless the user says so.
  let askedSend = false
  createEffect(() => {
    const state = sandbox.state()
    if (askedSend || state?.status !== "off" || !state.queued || !sandbox.queued()) return
    if (!store.prompt.input.trim()) return
    askedSend = true
    dialog.replace(
      () => (
        <DialogSelect<"send" | "discard">
          title={SEND_QUESTION}
          renderFilter={false}
          options={[
            { value: "send", title: "Send" },
            { value: "discard", title: "Discard" },
          ]}
          onSelect={(option) => {
            dialog.clear()
            sandbox.setQueued(false)
            if (option.value === "send") return void submit()
            input.clear()
            setStore("prompt", { input: "", parts: [] })
          }}
        />
      ),
      () => sandbox.setQueued(false),
    )
  })

  async function submit() {
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.input`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting) return false
    submitting = true
    try {
      return await submitInner()
    } finally {
      submitting = false
    }
  }

  /**
   * XCOD-267: before a prompt runs in a session whose Lunos closed with prompts queued for it, the
   * same "Take over this session here?" as the Agent Monitor. Discard happens here; "send" is left
   * to the caller, which sends its prompt with the take-over so it runs after them.
   */
  async function askTakeover(sessionID: string): Promise<"send" | "discard" | "cancel" | undefined> {
    const held = await sdk.client.experimental.session
      .queued({ sessionID }, { throwOnError: true })
      .then((response) => response.data.orphaned)
      .catch(() => 0)
    if (!held) return undefined
    const title = Locale.truncate(sync.session.get(sessionID)?.title ?? "this session", 40)
    const message = takeoverQuestion(title, held)
    const choice = await new Promise<"send" | "discard" | undefined>((resolve) =>
      dialog.replace(
        () => (
          <DialogSelect<"send" | "discard" | "cancel">
            title={message}
            titleView={
              <box flexShrink={1} paddingRight={2}>
                <text fg={theme.text} wrapMode="word">
                  {message}
                </text>
              </box>
            }
            renderFilter={false}
            options={[...takeoverChoices(held), { value: "cancel" as const, title: "Cancel" }]}
            onSelect={(option) => {
              resolve(option.value === "cancel" ? undefined : option.value)
              dialog.clear()
            }}
          />
        ),
        () => resolve(undefined),
      ),
    )
    if (!choice) return "cancel"
    if (choice === "send") return "send"
    return sdk.client.experimental.session
      .takeover({ sessionID, queued: "discard", origin: "session" }, { throwOnError: true })
      .then(
        () => "discard" as const,
        (error: unknown) => {
          toast.show({ title: "Couldn't take the session over", message: errorMessage(error), variant: "error" })
          return "cancel" as const
        },
      )
  }

  async function submitInner() {
    workspace.clearNotice()

    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (workspace.creating() || move.creating()) return false
    if (auto()?.visible) return false
    if (!store.prompt.input) return false
    if (sync.status === "loading" || sandboxHolds()) {
      setQueued(true)
      return false
    }
    // XCOD-273: signed out where the official build needs an account (`lunos logout` in another
    // terminal, say), a prompt shows the Welcome screen instead of failing; the draft stays.
    if (account && !(await account.check())) return false
    // XCOD-94: bare /memory opens the memory browser, before any session is created.
    // `/memory off|on` has arguments and goes to the server like any other command.
    if (store.prompt.input.trim() === "/memory") {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      dialog.replace(() => <DialogMemory />)
      return false
    }
    // XCOD-158: `/sandbox end` has an argument too, so the slash list can't run it.
    if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES && /^\/sandbox\s+end$/.test(store.prompt.input.trim())) {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      void workspace.endSandbox()
      return false
    }
    // XCOD-129: `/restart --fresh` has an argument, so the slash list can't run it; neither goes
    // to the server as a prompt.
    const restartSlash = parseRestartSlash(store.prompt.input)
    if (restartSlash) {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      keymap.dispatchCommand(restartSlash.fresh ? "app.restart.fresh" : "app.restart")
      return false
    }
    // XCOD-306: `/project settings` opens Settings scoped to the session's project.
    if (/^\/project\s+settings\s*$/.test(store.prompt.input.trim())) {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      if (!props.sessionID)
        toast.show({ variant: "info", message: "Open a session in the project first; /projects lists them all" })
      else keymap.dispatchCommand("project.settings")
      return false
    }
    // XCOD-128: `/settings key=value` (or `/config key=value`) changes one setting in the user
    // config, with the same validation and organisation locks as the settings screen.
    const settingsSlash = parseSettingsSlash(store.prompt.input)
    if (settingsSlash) {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      if ("error" in settingsSlash) {
        toast.show({ variant: "warning", message: settingsSlash.error })
        return false
      }
      if ("open" in settingsSlash) {
        requestSettings(Sections.target(settingsSlash.open) ?? { unknown: settingsSlash.open })
        keymap.dispatchCommand("settings.open")
        return false
      }
      void sdk.client.config
        .settingsSet({ settingsSetInput: { key: settingsSlash.key, value: settingsSlash.value, scope: "user" } })
        .then((result) => {
          const data = result.data
          if (!data || !data.ok) {
            toast.show({
              variant: "error",
              message: data && !data.ok ? data.error : "Settings didn't save",
              duration: 8000,
            })
            return
          }
          if (data.key === "tui.theme" && typeof data.value === "string") themeState.set(data.value)
          toast.show({
            variant: "success",
            message: `${data.key} = ${JSON.stringify(data.value)} (saved to ${data.file})${data.restart ? ". /restart to apply it" : ""}`,
            duration: 6000,
          })
        })
      return false
    }
    // XCOD-251: `/marketplace mcp|skills|…|installed|<search words>` has arguments, so the slash list
    // can't run it; the words are left for the Discover view, which the plugins feature owns.
    // A user's own command of the same name wins and goes to the server as usual.
    const marketplaceSlash = parseMarketplaceSlash(store.prompt.input)
    const ownCommand = sync.data.command.some((x) => x.name === store.prompt.input.trim().split(/\s/)[0]!.slice(1))
    if (marketplaceSlash && !ownCommand) {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      requestDiscover(marketplaceSlash)
      keymap.dispatchCommand("plugins.discover")
      return false
    }
    // XCOD-218: `/external claude|codex` or `/external resume <tool> <id>` opens an external session.
    const externalSlash = parseExternalSlash(store.prompt.input)
    if (externalSlash) {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      if ("error" in externalSlash) toast.show({ variant: "warning", message: externalSlash.error })
      else if ("pick" in externalSlash) dialog.replace(() => <DialogExternal />)
      else void startExternal(externalSlash.tool, externalSlash.session)
      return false
    }
    // XCOD-250: `/claude <task>` / `/codex <task>` start a new session of that tool with the task,
    // also from inside another external session. A user's own command of the same name wins, and
    // with external sessions off the text isn't ours.
    const toolSlash = parseToolSlash(store.prompt.input)
    if (
      toolSlash &&
      sync.data.config.external?.enabled !== false &&
      !sync.data.command.some((x) => x.name === toolSlash.tool)
    ) {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      void runExternalCommand(toolSlash.tool, toolSlash.text)
      return false
    }
    // XCOD-262: the Agent Monitor sends the prompt itself, as text: to the sessions it tags, or as a
    // new session it stays beside. The local commands above, and exit, still run here first.
    if (props.onIntercept && !EXIT_WORDS.has(store.prompt.input.trim())) {
      if (store.mode === "shell") {
        toast.show({ variant: "info", message: "Shell commands run in a session: open one to use !" })
        return false
      }
      if (store.prompt.parts.some((part) => part.type !== "text")) {
        toast.show({
          variant: "info",
          message: "The Agent Monitor sends text only: open the session to attach files, images or agents",
        })
        return false
      }
      const text = expandTrackedPastedText(
        store.prompt.input,
        input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
          const partIndex = store.extmarkToPartIndex.get(extmark.id)
          const part = partIndex === undefined ? undefined : store.prompt.parts[partIndex]
          if (part?.type !== "text") return []
          return [{ start: extmark.start, end: extmark.end, text: part.text }]
        }),
      )
      if (!(await props.onIntercept(text))) return false
      history.append({ ...store.prompt, mode: store.mode })
      input.extmarks.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
      props.onSubmit?.()
      input.clear()
      return true
    }
    // XCOD-286: in a Claude Code / Codex session `exit`, `quit`, `:q` and `/exit` (the tool's own
    // included) close that session; `/exit:lunos` quits Lunos. Before the external branch below,
    // which would send them to the tool as typed.
    const external = props.sessionID ? externalOf(sync.session.get(props.sessionID)) : undefined
    const intent = exitIntent(store.prompt.input, !!external)
    if (intent) {
      input.clear()
      setStore("prompt", { input: "", parts: [] })
      if (intent === "close" && props.sessionID) void externalExit.close(props.sessionID)
      else void externalExit.quit()
      return true
    }
    const agent = local.mode.current()
    if (!agent) return false
    // XCOD-218: in an external session the text goes to Claude Code / Codex as typed, its own
    // /commands included; no Lunos model is involved.
    if (props.sessionID && external) {
      const text = store.prompt.input
      // XCOD-254: a Lunos command (`/name`, or `/name:lunos` on a clash) is expanded by Lunos, and the
      // text it makes goes to the tool; anything else goes as typed.
      // `external.share.commands: false` (lockable): nothing is expanded by Lunos, the text goes as typed.
      const command =
        sync.data.config.external?.share?.commands === false
          ? undefined
          : lunosCommand(
              text,
              external.commands ?? [],
              sync.data.command.filter((item) => item.source !== "skill").map((item) => item.name),
            )
      const name = command?.name
      // XCOD-254: `/models` and `/cost` act on the tool's session here, even typed past the list.
      const mapped = command ? undefined : /^\/(\w+)$/.exec(text.trim())?.[1]
      if (mapped && MAPPED.has(mapped) && !(external.commands ?? []).includes(mapped)) {
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        keymap.dispatchCommand(mapped === "models" ? "model.list" : "session.cost")
        return false
      }
      const unavailable = !command && text.startsWith("/") ? text.slice(1).split(/\s/)[0]! : undefined
      if (unavailable && UNAVAILABLE.has(unavailable) && !(external.commands ?? []).includes(unavailable)) {
        toast.show({
          variant: "info",
          message: `/${unavailable} isn't available in a ${EXTERNAL_LABEL[external.tool]} session`,
        })
        return false
      }
      ;(name
        ? sdk.client.session.command(
            { sessionID: props.sessionID, command: name, arguments: command!.args },
            { throwOnError: true },
          )
        : sdk.client.session.prompt(
            // No agent: the current mode (plan, say) mustn't refuse every approval the tool asks for.
            { sessionID: props.sessionID, parts: [{ type: "text", text }] },
            { throwOnError: true },
          )
      ).catch((error: unknown) =>
        toast.show({ title: "Failed to send prompt", message: errorMessage(error), variant: "error" }),
      )
      history.append({ ...store.prompt, mode: store.mode })
      input.extmarks.clear()
      setStore("prompt", { input: "", parts: [] })
      setStore("extmarkToPartIndex", new Map())
      props.onSubmit?.()
      input.clear()
      return true
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }

    const workspaceSession = props.sessionID ? sync.session.get(props.sessionID) : undefined
    const workspaceID = workspaceSession?.workspaceID
    const workspaceStatus = workspaceID ? (project.workspace.status(workspaceID) ?? "error") : undefined
    if (props.sessionID && workspaceID && workspaceStatus !== "connected") {
      dialog.replace(() => (
        <DialogWorkspaceUnavailable
          onRestore={() => {
            workspace.open()
            return false
          }}
        />
      ))
      return false
    }

    // XCOD-267: a Lunos that closed left prompts queued for this session: they go first or are
    // discarded, as the user chooses, before this one runs. Cancel keeps the text.
    const takeover = props.sessionID ? await askTakeover(props.sessionID) : undefined
    if (takeover === "cancel") return false

    const variant = local.model.variant.current()
    let sessionID = props.sessionID
    let finishMoveProgress = false
    if (sessionID == null) {
      const selectedWorkspace = workspace.selection()
      const workspaceID = selectedWorkspace?.type === "existing" ? selectedWorkspace.workspaceID : undefined

      const directory = await move.getDirectory(store.prompt.input)
      if (move.pending() && !directory) return false
      finishMoveProgress = Boolean(move.progress())

      const res = await sdk.client.session.create({
        directory,
        workspace: workspaceID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          id: selectedModel.modelID,
          variant,
        },
      })

      if (res.error) {
        if (finishMoveProgress) move.finishSubmit()
        console.log("Creating a session failed:", res.error)

        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return true
      }

      sessionID = res.data.id
    }

    const inputText = expandTrackedPastedText(
      store.prompt.input,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const partIndex = store.extmarkToPartIndex.get(extmark.id)
        const part = partIndex === undefined ? undefined : store.prompt.parts[partIndex]
        if (part?.type !== "text") return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
    )

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const editorSelection = editorContext()
    const editorParts =
      editorSelection && editor.labelState() === "pending"
        ? [
            {
              type: "text" as const,
              text: formatEditorContext(editorSelection),
              synthetic: true,
              metadata: {
                kind: "editor_context",
                source: editorSelection.source ?? "editor",
                filePath: editorSelection.filePath,
                ranges: editorSelection.ranges,
              },
            },
          ]
        : []

    const commandName = inputText.split("\n")[0].split(" ")[0].slice(1)
    const isCommand = inputText.startsWith("/") && sync.data.command.some((x) => x.name === commandName)
    if (takeover === "send") {
      // The same request the branches below make, run here once the queued prompts have.
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const request =
        store.mode === "shell"
          ? {
              kind: "shell" as const,
              body: {
                agent: agent.name,
                model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID },
                command: inputText,
              },
            }
          : isCommand
            ? {
                kind: "command" as const,
                body: {
                  command: commandName,
                  arguments:
                    firstLine.split(" ").slice(1).join(" ") +
                    (firstLineEnd === -1 ? "" : "\n" + inputText.slice(firstLineEnd + 1)),
                  agent: agent.name,
                  model: `${selectedModel.providerID}/${selectedModel.modelID}`,
                  ...(variant ? { variant } : {}),
                  parts: nonTextParts.filter((x) => x.type === "file"),
                },
              }
            : {
                kind: "prompt" as const,
                body: {
                  agent: agent.name,
                  model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID },
                  ...(variant ? { variant } : {}),
                  parts: [...editorParts, { type: "text", text: inputText }, ...nonTextParts],
                },
              }
      const sent = await sdk.client.experimental.session
        .takeover(
          { sessionID: sessionID!, queued: "send", origin: "session", text: inputText, request },
          { throwOnError: true },
        )
        .then(
          () => true,
          (error: unknown) => {
            toast.show({ title: "Couldn't take the session over", message: errorMessage(error), variant: "error" })
            return false
          },
        )
      if (!sent) return false
      if (store.mode === "shell") setStore("mode", "normal")
      if (request.kind === "prompt" && editorParts.length > 0) editor.markSelectionSent()
    } else if (store.mode === "shell") {
      move.startSubmit()
      void sdk.client.session.shell({
        sessionID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        command: inputText,
      })
      setStore("mode", "normal")
    } else if (isCommand) {
      move.startSubmit()
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      void sdk.client.session.command({
        sessionID,
        command: command.slice(1),
        arguments: args,
        agent: agent.name,
        model: `${selectedModel.providerID}/${selectedModel.modelID}`,
        variant,
        parts: nonTextParts.filter((x) => x.type === "file"),
      })
    } else {
      move.startSubmit()
      sdk.client.session
        .prompt(
          {
            sessionID,
            ...selectedModel,
            agent: agent.name,
            model: selectedModel,
            variant,
            parts: [
              ...editorParts,
              {
                type: "text",
                text: inputText,
              },
              ...nonTextParts,
            ],
          },
          { throwOnError: true },
        )
        .catch((error) => {
          toast.show({
            title: "Failed to send prompt",
            message: errorMessage(error),
            variant: "error",
          })
        })
      if (editorParts.length > 0) editor.markSelectionSent()
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID) {
      if (editorParts.length > 0) editor.preserveSelectionFromNewSession()
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    }
    input.clear()
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteInputText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const filepath = pastedFilepath(pastedContent, terminalEnvironment.platform)
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      const attachment = await readLocalAttachment(filepath)
      const filename = path.basename(filepath)
      if (attachment?.type === "text") {
        pasteText(attachment.content, `[SVG: ${filename ?? "image"}]`)
        return
      }
      if (attachment?.type === "binary") {
        await pasteAttachment({
          filename,
          filepath,
          mime: attachment.mime,
          content: Buffer.from(attachment.content).toString("base64"),
        })
        return
      }
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if (
      (lineCount >= 3 || pastedContent.length > 150) &&
      kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary)
    ) {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const hasContent = () => store.prompt.input !== "" || store.prompt.parts.length > 0
  /** Esc goes to clearing the prompt (XCOD-255/313), idle or busy, rather than to session.interrupt. */
  const escapeClears = () =>
    tuiConfig.double_escape_clear && store.mode === "normal" && !auto()?.visible && hasContent()
  const escapeGuard = createDoublePress(() => tuiConfig.double_escape_ms)
  const [escapeArmed, setEscapeArmed] = createSignal(false)
  const [cleared, setCleared] = createSignal<{ prompt: PromptInfo; mode: "normal" | "shell"; cursor: number }>()
  let escapeTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(escapeTimer))

  function disarmEscape() {
    clearTimeout(escapeTimer)
    escapeGuard.reset()
    setEscapeArmed(false)
  }

  function escapeClear() {
    // A press spent on the prompt never counts toward stopping the run (session.interrupt), so an Esc
    // straight after a clear can't abort it.
    setStore("interrupt", 0)
    // A selection is the innermost thing Esc can undo: drop it, and don't count the press.
    if (input.hasSelection()) {
      input.clearSelection()
      disarmEscape()
      return
    }
    clearTimeout(escapeTimer)
    if (escapeGuard.press() === "armed") {
      setEscapeArmed(true)
      escapeTimer = setTimeout(() => {
        escapeGuard.reset()
        setEscapeArmed(false)
      }, tuiConfig.double_escape_ms)
      return
    }
    setEscapeArmed(false)
    const snapshot = { prompt: structuredClone(unwrap(store.prompt)), mode: store.mode, cursor: input.cursorOffset }
    clearPrompt(true)
    setCleared(snapshot)
    toast.show({ variant: "info", message: `Prompt cleared · ${undoShortcut()} to restore`, duration: 4000 })
  }

  function restoreCleared() {
    const saved = cleared()
    if (!saved) return
    setCleared(undefined)
    input.setText(saved.prompt.input)
    setStore("mode", saved.mode)
    setStore("prompt", saved.prompt)
    restoreExtmarksFromParts(saved.prompt.parts)
    input.cursorOffset = saved.cursor
    toast.show({ variant: "success", message: "Prompt restored", duration: 1500 })
  }

  /** `keep`: always save the prompt to history, not only a long draft (Esc Esc promises ↑ brings it back). */
  function clearPrompt(keep = false) {
    if (
      (keep && store.prompt.input.trim() !== "") ||
      store.prompt.input.trim().length >= DRAFT_RETENTION_MIN_CHARS ||
      store.prompt.parts.length > 0
    ) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    input.clear()
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
  }

  const highlight = createMemo(() => {
    if (leader()) return theme.border
    if (accent()) return accent()!
    if (store.mode === "shell") return theme.primary
    const agent = local.mode.current()
    if (!agent) return theme.border
    return local.mode.color(agent.name)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const agentMetaAlpha = createFadeIn(() => !!local.mode.current(), animationsEnabled)
  const modelMetaAlpha = createFadeIn(() => !!local.mode.current() && store.mode === "normal", animationsEnabled)
  const variantMetaAlpha = createFadeIn(
    () => !!local.mode.current() && store.mode === "normal" && showVariant(),
    animationsEnabled,
  )
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command… "${example}"`
    }
    if (!list().length) return undefined
    return `Ask anything… "${list()[store.placeholder % list().length]}"`
  })

  const spinnerDef = createMemo(() => {
    const agent =
      status().type !== "idle"
        ? (local.mode.list().find((a) => a.name === lastUserMessage()?.agent) ?? local.mode.current())
        : local.mode.current()
    const color = accent() ?? (agent ? local.mode.color(agent.name) : theme.border)
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  const maxHeight = createMemo(() => tuiConfig.prompt?.max_height ?? Math.max(6, Math.floor(dimensions().height / 3)))
  const moveLabelWidth = createMemo(() => Math.max(12, Math.min(44, dimensions().width - 48)))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%">
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
            width="100%"
          >
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={leader() ? theme.textMuted : theme.text}
              focusedTextColor={leader() ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={maxHeight()}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                // Typing after the first Esc starts over; typing after a clear makes it final.
                if (escapeArmed()) disarmEscape()
                if (value !== "") setCleared(undefined)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => setCursorVersion((value) => value + 1)}
              onKeyDown={(e: { preventDefault(): void }) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  keymap.dispatchCommand("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                await pasteInputText(normalizedText)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.parts),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = cursorColor()
                  if (tuiConfig.cursor) input.cursorStyle = tuiConfig.cursor
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={props.disabled ? theme.backgroundElement : cursorColor()}
              cursorStyle={tuiConfig.cursor}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <Show when={external()}>
                  {(marker) => (
                    <text>
                      <span style={{ fg: accent() ?? theme.text, bold: true }}>▸ {EXTERNAL_BADGE[marker().tool]}</span>
                      <Show when={externalModel()}>
                        <span style={{ fg: theme.textMuted }}> · {externalModel()}</span>
                      </Show>
                    </text>
                  )}
                </Show>
                <Show
                  when={!external() && local.mode.current()}
                  fallback={
                    <Show when={!external()}>
                      <Show when={sync.status === "loading"} fallback={<box height={1} />}>
                        <text fg={theme.textMuted}>
                          {sandbox.state()?.status === "starting" || sandbox.state()?.status === "blocked"
                            ? queued()
                              ? "Waiting for sandbox… your prompt is sent once it's ready"
                              : "Waiting for sandbox…"
                            : queued()
                              ? "Starting… your prompt is sent once ready"
                              : "Starting…"}
                        </text>
                      </Show>
                    </Show>
                  }
                >
                  {(agent) => (
                    <>
                      <text fg={fadeColor(highlight(), agentMetaAlpha())}>
                        {store.mode === "shell" ? "Shell" : Locale.titlecase(agent().name)}
                      </text>
                      <Show when={store.mode === "normal" && local.permission.mode === "auto"}>
                        <text fg={fadeColor(theme.textMuted, agentMetaAlpha())}>auto</text>
                      </Show>
                      <Show when={store.mode === "normal"}>
                        <box flexDirection="row" gap={1}>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>·</text>
                          <text
                            flexShrink={0}
                            fg={fadeColor(leader() ? theme.textMuted : theme.text, modelMetaAlpha())}
                          >
                            {local.model.parsed().model}
                          </text>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>{currentProviderLabel()}</text>
                          <Show when={showVariant()}>
                            <text fg={fadeColor(theme.textMuted, variantMetaAlpha())}>·</text>
                            <text>
                              <span style={{ fg: fadeColor(theme.warning, variantMetaAlpha()), bold: true }}>
                                {local.model.variant.current()}
                              </span>
                            </text>
                          </Show>
                        </box>
                      </Show>
                    </>
                  )}
                </Show>
              </box>
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between">
          <Switch>
            <Match when={status().type !== "idle"}>
              <box
                flexDirection="row"
                gap={1}
                flexGrow={1}
                justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
              >
                <box flexShrink={0} flexDirection="row" gap={1}>
                  <box marginLeft={1}>
                    <Show when={animationsEnabled()} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                      <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                    </Show>
                  </box>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    {(() => {
                      const retry = createMemo(() => {
                        const s = status()
                        if (s.type !== "retry") return
                        return s
                      })
                      const message = createMemo(() => {
                        const r = retry()
                        if (!r) return
                        if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                          return "gemini is way too hot right now"
                        if (r.message.length > 80) return r.message.slice(0, 80) + "…"
                        return r.message
                      })
                      const isTruncated = createMemo(() => {
                        const r = retry()
                        if (!r) return false
                        return r.message.length > 120
                      })
                      const [seconds, setSeconds] = createSignal(0)
                      onMount(() => {
                        const timer = setInterval(() => {
                          const next = retry()?.next
                          if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                        }, 1000)

                        onCleanup(() => {
                          clearInterval(timer)
                        })
                      })
                      const handleMessageClick = () => {
                        const r = retry()
                        if (!r) return
                        if (isTruncated()) {
                          void DialogAlert.show(dialog, "Retry Error", r.message)
                        }
                      }

                      const retryText = () => {
                        const r = retry()
                        if (!r) return ""
                        const baseMessage = message()
                        const truncatedHint = isTruncated() ? " (click to expand)" : ""
                        const duration = formatDuration(seconds())
                        const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                        return baseMessage + truncatedHint + retryInfo
                      }

                      return (
                        <Show when={retry()}>
                          <box onMouseUp={handleMessageClick}>
                            <text fg={theme.error}>{retryText()}</text>
                          </box>
                        </Show>
                      )
                    })()}
                  </box>
                </box>
                {/* XCOD-313: Esc Esc clears typed text first; only on an empty prompt does it stop the run. */}
                <text fg={escapeArmed() || store.interrupt > 0 ? theme.primary : theme.text}>
                  {escapeClears() ? "esc" : stopKey()}{" "}
                  <span style={{ fg: escapeArmed() || store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                    {escapeClears()
                      ? escapeArmed()
                        ? "again to clear"
                        : "esc clear"
                      : store.interrupt > 0
                        ? "again to stop"
                        : `${stopKey()} stop`}
                  </span>
                </text>
              </box>
            </Match>
            <Match when={escapeArmed()}>
              <box paddingLeft={3}>
                <text fg={theme.primary}>
                  esc <span style={{ fg: theme.textMuted }}>again to clear</span>
                </text>
              </box>
            </Match>
            <Match when={workspace.notice()}>
              {(notice) => (
                <box paddingLeft={3}>
                  <text fg={theme.accent}>{notice()}</text>
                </box>
              )}
            </Match>
            <Match when={workspace.label()}>
              {(label) => (
                <box paddingLeft={3} flexDirection="row" gap={1}>
                  <Show when={workspace.creating()}>
                    <Spinner color={theme.accent} />
                  </Show>
                  <text fg={workspace.creating() ? theme.accent : theme.text}>
                    {(() => {
                      const item = label()
                      if (item.type === "new") {
                        if (workspace.creating())
                          return `Creating ${item.workspaceType}${".".repeat(workspace.creatingDots())}`
                        return (
                          <>
                            Workspace <span style={{ fg: theme.textMuted }}>(new {item.workspaceType})</span>
                          </>
                        )
                      }
                      return (
                        <>
                          Workspace <span style={{ fg: theme.textMuted }}>{item.workspaceName}</span>
                        </>
                      )
                    })()}
                  </text>
                </box>
              )}
            </Match>
            <Match when={move.progress()}>
              {(progress) => (
                <box paddingLeft={3}>
                  <Spinner color={theme.accent}>
                    {progress()}
                    <span style={{ fg: theme.textMuted }}>{".".repeat(move.creatingDots())}</span>
                  </Spinner>
                </box>
              )}
            </Match>
            <Match when={move.pendingNew()}>
              <box paddingLeft={3}>
                <text fg={theme.accent}>(new working copy)</text>
              </box>
            </Match>
            <Match when={true}>
              {props.hint ?? (
                <Show when={props.sessionID} fallback={<text />}>
                  {/* XCOD-286: in an external session this side gives way (cut, one line), so the exit hint
                      and the commands on the right stay whole. */}
                  <box
                    marginLeft={1}
                    {...(external() ? { flexShrink: 1, minWidth: 0, marginRight: 2, overflow: "hidden" as const } : {})}
                  >
                    {/* XCOD-254: an external session shows what the Lunos bridge offers instead of the directory. */}
                    <Show
                      when={bridgeLine(external()?.bridge)}
                      fallback={
                        <text fg={theme.textMuted} wrapMode={external() ? "none" : undefined}>
                          {location()?.directory ?? paths.cwd}
                        </text>
                      }
                    >
                      {(line) => (
                        <text fg={line().warning ? theme.warning : theme.textMuted} wrapMode="none">
                          {line().text}
                        </text>
                      )}
                    </Show>
                  </box>
                </Show>
              )}
            </Match>
          </Switch>
          <Show when={status().type !== "retry"}>
            <box gap={2} flexDirection="row" flexShrink={external() ? 0 : undefined}>
              <Show when={external()}>
                {(marker) => (
                  <text fg={accent() ?? theme.text} wrapMode="none" flexShrink={0}>
                    {externalBadge(
                      marker().tool,
                      externalModel(),
                      externalModeLabel(marker()),
                      externalContext(marker().context),
                    )}
                  </text>
                )}
              </Show>
              <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  <text fg={editorContextLabelState() === "pending" ? theme.secondary : theme.textMuted}>{file()}</text>
                )}
              </Show>
              <Switch>
                <Match when={store.mode === "normal"}>
                  {/* XCOD-303: before the first turn there's no usage line to carry it. */}
                  <Show when={!usage() && workflows()}>
                    {(label) => (
                      <text fg={theme.textMuted} wrapMode="none">
                        {label()}
                      </text>
                    )}
                  </Show>
                  <Switch>
                    <Match when={usage()}>
                      {(item) => (
                        <text fg={theme.textMuted} wrapMode="none">
                          {[item().context, item().cost, budget()?.line, workflows()].filter(Boolean).join(" · ")}
                        </text>
                      )}
                    </Match>
                    {/* XCOD-260: Lunos's agent modes don't apply to a Claude Code / Codex session. */}
                    <Match when={!external()}>
                      <text fg={theme.text}>
                        {modeShortcut()} <span style={{ fg: theme.textMuted }}>modes</span>
                      </text>
                    </Match>
                  </Switch>
                  {/* XCOD-286: here exit closes the tool's session; quitting Lunos is explicit. */}
                  <Show when={external()}>
                    <text fg={theme.text} wrapMode="none" flexShrink={0}>
                      exit <span style={{ fg: theme.textMuted }}>closes</span> · /exit:lunos{" "}
                      <span style={{ fg: theme.textMuted }}>quits Lunos</span>
                    </text>
                  </Show>
                  <text fg={theme.text}>
                    {paletteShortcut()} <span style={{ fg: theme.textMuted }}>commands</span>
                  </text>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text fg={theme.text}>
                    esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                  </text>
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
        {/* XCOD-278: a tip under the working indicator once a turn has run a while. */}
        <WorkingTip busy={() => props.sessionID !== undefined && status().type !== "idle"} />
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        mentions={props.mentions}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
