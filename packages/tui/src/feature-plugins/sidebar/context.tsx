import type { AssistantMessage, ResourceContext, ResourceItem } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const MODE = { always: "always", search: "search", on_demand: "@name" } as const

export function tokens(value: number | undefined) {
  if (!value) return "0"
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

/** "3 always (6.1k tokens) · 5 searchable", the ticket's sidebar line. */
export function summary(list: readonly ResourceItem[]) {
  const usable = list.filter((item) => !item.problem && !item.excluded)
  const always = usable.filter((item) => item.mode === "always")
  const search = usable.filter((item) => item.mode === "search")
  const mention = usable.filter((item) => item.mode === "on_demand")
  const parts = [
    always.length
      ? `${always.length} always (${tokens(always.reduce((sum, item) => sum + (item.tokens ?? 0), 0))} tokens)`
      : "",
    search.length ? `${search.length} searchable` : "",
    mention.length ? `${mention.length} on @name` : "",
  ].filter(Boolean)
  return parts.join(" · ") || "none in use"
}

// XCOD-300: the project's resources, with a per-session exclude; /context has the full breakdown.
async function listResources(api: TuiPluginApi, sessionID: string) {
  const result = await api.client.resource.list({ sessionID }).catch(() => undefined)
  return (result?.data ?? []) as ResourceItem[]
}

async function toggle(api: TuiPluginApi, sessionID: string, item: ResourceItem) {
  await api.client.resource.exclude({ sessionID, name: item.name, excluded: !item.excluded }).catch(() => undefined)
  api.ui.toast({
    variant: "info",
    message: item.excluded
      ? `${item.name} is back in this session's context`
      : `${item.name} is left out of this session's context`,
  })
}

export function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const [version, setVersion] = createSignal(0)
  const [open, setOpen] = createSignal(true)

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  // Refetched after each turn (the indexed times move) and after a toggle.
  const [resources] = createResource(
    () => ({ session: props.session_id, turn: msg().length, version: version() }),
    (input) => listResources(props.api, input.session),
  )

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
      <Show when={(resources() ?? []).length > 0}>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((value) => !value)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().textMuted} wrapMode="word">
            Resources: {summary(resources() ?? [])}
          </text>
        </box>
        <Show when={open()}>
          <For each={resources() ?? []}>
            {(item) => (
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={async () => {
                  if (item.problem) return
                  await toggle(props.api, props.session_id, item)
                  setVersion((value) => value + 1)
                }}
              >
                <text
                  flexShrink={0}
                  fg={item.problem ? theme().error : item.excluded ? theme().textMuted : theme().success}
                >
                  {item.problem ? "!" : item.excluded ? "○" : "●"}
                </text>
                <text fg={item.excluded ? theme().textMuted : theme().text} wrapMode="word">
                  {item.name}{" "}
                  <span style={{ fg: theme().textMuted }}>
                    {item.excluded
                      ? "excluded for this session"
                      : item.problem
                        ? item.problem
                        : `${MODE[item.mode]} · ${tokens(item.tokens)} tok · ${item.state.replace(/^indexed /, "")}`}
                  </span>
                </text>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

/** The /context lines: every part of the last turn's context with its tokens, then the resources. */
export function breakdown(turn: ResourceContext | null | undefined, list: readonly ResourceItem[]) {
  const rows: { title: string; description: string; category: string; item?: ResourceItem }[] = []
  if (turn) {
    const line = (title: string, value: number, note?: string) =>
      rows.push({
        title,
        description: `${value.toLocaleString()} tokens${note ? ` · ${note}` : ""}`,
        category: "Last turn",
      })
    line("System prompt", turn.system)
    line("Instructions", turn.instructions)
    line(
      "Always resources",
      turn.always,
      turn.resources.map((item) => `${item.name} ${tokens(item.tokens)}`).join(", ") || undefined,
    )
    for (const item of turn.dropped)
      rows.push({ title: `  ${item.name} left out`, description: item.reason, category: "Last turn" })
    line("Memory recall", turn.memory)
    line("Attachments", turn.attachments)
    line("Searched resources", turn.searched)
    line("@mentioned resources", turn.mentioned)
    const total =
      turn.system + turn.instructions + turn.always + turn.memory + turn.attachments + turn.searched + turn.mentioned
    line("Total", total, "estimated, before the conversation itself")
  }
  for (const item of list)
    rows.push({
      title: `${item.excluded ? "○" : "●"} ${item.name}`,
      description: item.problem
        ? item.problem
        : `${MODE[item.mode]} · ${item.kind} · ${item.scope}${item.trusted ? "" : " · untrusted"} · ${tokens(item.tokens)} tokens · ${item.state}${item.excluded ? " · excluded for this session" : ""}`,
      category: "Resources (Enter toggles for this session)",
      item,
    })
  return rows
}

async function showContext(api: TuiPluginApi, sessionID: string) {
  const [turn, list] = await Promise.all([
    api.client.resource
      .context({ sessionID })
      .then((result) => result.data as ResourceContext | null | undefined)
      .catch(() => undefined),
    listResources(api, sessionID),
  ])
  const rows = breakdown(turn, list)
  if (!rows.length) {
    api.ui.toast({ variant: "info", message: "Nothing to show yet: send a message first, or add a project resource." })
    return
  }
  const DialogSelect = api.ui.DialogSelect
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={turn ? "Context of the last turn" : "Context (no turn yet)"}
      flat
      skipFilter
      options={rows.map((row, index) => ({
        title: row.title,
        value: index,
        description: row.description,
        category: row.category,
      }))}
      onSelect={async (option) => {
        const row = rows[option.value as number]
        if (!row?.item || row.item.problem) return
        await toggle(api, sessionID, row.item)
        await showContext(api, sessionID)
      }}
    />
  ))
  api.ui.dialog.setSize("large")
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
  api.keymap.registerLayer({
    commands: [
      {
        name: "context.show",
        title: "Show what's in context",
        slashName: "context",
        category: "Session",
        namespace: "palette",
        run() {
          const current = api.route.current
          const sessionID = "params" in current ? (current.params?.sessionID as string | undefined) : undefined
          if (!sessionID) {
            api.ui.toast({ variant: "info", message: "Open a session to see its context." })
            return
          }
          void showContext(api, sessionID)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
