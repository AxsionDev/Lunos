import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js"
import type { ExternalConfigItem, ExternalConfigSection, ExternalConfigView } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useDialog, type DialogNav } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { openFileInEditor } from "../editor"
import { EXTERNAL_LABEL, type ExternalTool } from "../util/external"

// XCOD-285 §4: Settings › External sessions › Claude Code / Codex. Each tool's own configuration as
// the installed tool reports it (GET /experimental/external/config/:tool), with the layer and file each
// value comes from where the tool says, and "source unknown" where it doesn't. Changes go only through
// the tool's own commands: the exact command and the file it changes are shown, and it runs only after
// the user confirms. Where the tool has no command, the file it names can be opened in the editor.
// Lunos never writes the tool's files.

/** Paths under the home directory as `~/…`. */
function home(file: string) {
  const dir = process.env.HOME
  return dir && file.startsWith(dir + "/") ? "~" + file.slice(dir.length) : file
}

type Result = { tone: "success" | "error" | "info"; text: string }

const NOTHING = (label: string) => `Nothing to do here: ${label} has no command to change it, and names no file for it`

/** What a tool's row says about where a value comes from. */
export function sourceText(item: Pick<ExternalConfigItem, "source">, label: string) {
  if (!item.source) return `source unknown: ${label} doesn't say where this comes from`
  return `from ${item.source.label}`
}

/** The footer of an item's row: its scope, or "source unknown". */
export function scopeText(item: Pick<ExternalConfigItem, "source" | "status">) {
  const scope = item.source ? (item.source.scope ?? "") : "source unknown"
  return [item.status, scope].filter(Boolean).join(" · ")
}

export function DialogExternalConfig(props: {
  tool: ExternalTool
  focus?: string
  nav?: DialogNav
  /** What the last command reported, shown above the list's notes. */
  result?: Result
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const renderer = useRenderer()
  const { theme } = useTheme()
  const label = EXTERNAL_LABEL[props.tool]
  const generation = dialog.generation
  const [highlighted, setHighlighted] = createSignal<string | undefined>(props.focus)

  onMount(() => dialog.setSize("large"))

  const [view] = createResource(async (): Promise<ExternalConfigView> => {
    const result = await sdk.client.experimental.external
      .config({ tool: props.tool })
      .catch(() => ({ data: undefined }))
    return (
      result.data ?? {
        tool: props.tool,
        label,
        error: `Couldn't read ${label}'s configuration`,
        sections: [],
        notes: [],
      }
    )
  })

  const items = createMemo(() =>
    (view()?.sections ?? []).flatMap((section) => section.items.map((item) => ({ section, item }))),
  )
  // The highlighted row, or the first one before the cursor moves.
  const current = createMemo(() =>
    highlighted()?.startsWith("+")
      ? undefined
      : (items().find((entry) => entry.item.id === highlighted()) ?? items()[0]),
  )

  /** This view again, on row `focus`, after a picker, prompt or confirm replaced it. */
  function reopen(focus?: string, result?: Result) {
    dialog.replace(
      () => <DialogExternalConfig tool={props.tool} focus={focus ?? highlighted()} nav={props.nav} result={result} />,
      undefined,
      props.nav ? { ...props.nav, generation } : undefined,
    )
  }
  const back = (focus?: string): DialogNav => ({ back: () => reopen(focus), generation })

  async function command(
    change: { action: "mcp.add" | "mcp.remove"; name: string; scope?: string; target?: string },
    focus: string,
  ) {
    const planned = await sdk.client.experimental.external
      .configCommand({ tool: props.tool, ...change, run: false })
      .catch(() => undefined)
    if (!planned?.data) {
      const message = (planned?.error as { data?: { message?: string } } | undefined)?.data?.message
      return reopen(focus, { tone: "error", text: message ?? `${label} can't do that here` })
    }
    const { command: line, file } = planned.data
    const confirmed = await DialogConfirm.show(
      dialog,
      `Run ${label}'s own command?`,
      `Lunos runs:\n  ${line}\n${file ? `${label} changes ${home(file)}.` : `${label} decides which file it changes.`} Lunos doesn't write it.`,
      undefined,
      back(focus),
    )
    if (!confirmed) return reopen(focus)
    const ran = await sdk.client.experimental.external
      .configCommand({ tool: props.tool, ...change, run: true })
      .catch(() => undefined)
    const result = ran?.data
    const ok = result?.ok === true
    reopen(focus, {
      tone: ok ? "success" : "error",
      text: result?.output || (ok ? `${label} ran ${line}` : `${label} reported an error`),
    })
  }

  async function add(section: ExternalConfigSection) {
    const focus = `+add:${section.id}`
    const scopes = section.add?.scopes ?? []
    const scope =
      scopes.length > 1
        ? await new Promise<string | undefined>((resolve) =>
            dialog.replace(
              () => (
                <DialogSelect<string>
                  title={`Where ${label} keeps the server`}
                  placeholder={`the scopes ${label}'s mcp add --help lists`}
                  skipFilter
                  options={scopes.map((item) => ({ title: item, value: item }))}
                  onSelect={(option) => resolve(option.value)}
                />
              ),
              () => resolve(undefined),
              back(focus),
            ),
          )
        : scopes[0]
    if (scopes.length > 1 && !scope) return
    const name = (
      await DialogPrompt.show(dialog, "Server name", { placeholder: "e.g. docs", nav: back(focus) })
    )?.trim()
    if (!name) return reopen(focus)
    const target = (
      await DialogPrompt.show(
        dialog,
        section.add?.url ? "URL, or the command that starts it" : "Command that starts it",
        {
          placeholder: section.add?.url ? "https://… or npx -y some-mcp-server" : "npx -y some-mcp-server",
          nav: back(focus),
        },
      )
    )?.trim()
    if (!target) return reopen(focus)
    await command({ action: "mcp.add", name, ...(scope ? { scope } : {}), target }, focus)
  }

  async function open(file: string, focus: string) {
    const opened = await openFileInEditor({ file, renderer }).catch(() => false)
    reopen(focus, opened ? undefined : { tone: "info", text: `Set $EDITOR to open it from here. The file: ${file}` })
  }

  function actions(section: ExternalConfigSection, item: ExternalConfigItem) {
    const options = [
      ...(item.open
        ? [
            {
              title: "Open in your editor",
              value: "open",
              description: home(item.open),
              footer: "Lunos doesn't write it",
            },
          ]
        : []),
      ...(item.remove
        ? [
            {
              title: `Remove with ${label}'s own command`,
              value: "remove",
              description: "the command and the file it changes are shown before it runs",
            },
          ]
        : []),
    ]
    if (!options.length) return reopen(item.id, { tone: "info", text: NOTHING(label) })
    dialog.replace(
      () => (
        <DialogSelect<string>
          title={`${section.title} › ${item.name}`}
          placeholder={sourceText(item, label)}
          skipFilter
          options={options}
          onSelect={(option) => {
            if (option.value === "open" && item.open) return void open(item.open, item.id)
            if (option.value === "remove")
              return void command({ action: "mcp.remove", name: item.name, scope: item.remove?.scope }, item.id)
          }}
        />
      ),
      undefined,
      back(item.id),
    )
  }

  const options = createMemo(() =>
    (view()?.sections ?? []).flatMap((section) => [
      ...section.items.map((item) => ({
        title: item.name,
        value: item.id,
        category: section.title,
        description: item.value,
        footer: scopeText(item),
      })),
      ...(!section.items.length && section.note
        ? [{ title: section.note, value: `+note:${section.id}`, category: section.title }]
        : []),
      ...(section.add
        ? [
            {
              title: "Add an MCP server…",
              value: `+add:${section.id}`,
              category: section.title,
              footer: `${props.tool} mcp add`,
            },
          ]
        : []),
    ]),
  )

  const footer = () => {
    const entry = current()
    const lines: { text: string; color: typeof theme.text }[] = []
    if (props.result)
      lines.push({
        text: props.result.text,
        color:
          props.result.tone === "success" ? theme.success : props.result.tone === "error" ? theme.error : theme.text,
      })
    if (entry) {
      lines.push({ text: sourceText(entry.item, label), color: entry.item.source ? theme.text : theme.warning })
      if (!entry.item.open && !entry.item.remove) lines.push({ text: NOTHING(label), color: theme.textMuted })
      if (entry.item.detail) lines.push({ text: entry.item.detail, color: theme.textMuted })
      if (entry.item.value && entry.item.value.length > 40)
        lines.push({ text: entry.item.value, color: theme.textMuted })
      if (entry.section.note) lines.push({ text: entry.section.note, color: theme.textMuted })
    } else if (highlighted()?.startsWith("+add:"))
      lines.push({
        text: `Runs ${label}'s own command after you confirm it. Environment variables and headers: add the server in a terminal.`,
        color: theme.textMuted,
      })
    for (const note of view()?.notes ?? []) lines.push({ text: note, color: theme.textMuted })
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
      <DialogSelect<string>
        title="Settings"
        titleView={
          <box flexDirection="row" gap={2}>
            <box flexDirection="row">
              <text fg={theme.textMuted}>{"Settings › External sessions › "}</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {label}
              </text>
            </box>
            <Show when={view()?.version}>
              <text fg={theme.textMuted}>version {view()?.version}</text>
            </Show>
          </box>
        }
        placeholder="Type to filter"
        preserveSelection
        wheel={false}
        current={highlighted()}
        options={options()}
        emptyView={
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={view()?.error ? theme.error : theme.textMuted} wrapMode="word">
              {view.loading ? `Asking ${label}…` : (view()?.error ?? `${label} reported nothing here`)}
            </text>
          </box>
        }
        onMove={(option) => setHighlighted(option.value)}
        onSelect={(option) => {
          if (option.value.startsWith("+note:")) return
          if (option.value.startsWith("+add:")) {
            const section = view()?.sections.find((item) => item.id === option.value.slice("+add:".length))
            if (section) void add(section)
            return
          }
          const entry = items().find((item) => item.item.id === option.value)
          if (entry) actions(entry.section, entry.item)
        }}
        footerHints={[{ title: "actions", label: "enter" }]}
      />
      <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
        {footer()}
      </box>
    </box>
  )
}
