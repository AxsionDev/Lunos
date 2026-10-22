import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  assignAvatars,
  blink,
  elapsed,
  glyph,
  halfCell,
  halfRows,
  PIXEL_COLOR,
  plainName,
  subagentsOf,
  tokens,
  type Avatar,
  type Pixel,
  type SubagentEntry,
  type SubagentState,
} from "../../util/subagent-avatar"
import {
  forgetWaiting,
  GROUP_GLYPH,
  groupSubagents,
  ROW_LABEL,
  toggle,
  type GroupView,
  type Overrides,
} from "../../util/subagent-groups"
import { askText } from "../../util/agent-monitor"
import { animationsEnabled, prefersReducedMotion } from "../../util/motion"

// XCOD-287: the subagents this session launched, each with its own pixel-art animal and name.
const id = "internal:sidebar-subagents"

/** Shown once, the first time a session has a subagent. */
export const FIRST_RUN_NOTICE = "Lunos now splits work across subagents by default. Turn off in Settings."
const NOTICE_KEY = "subagents_notice_shown"

/** Where a session's expand/collapse choices are kept (kv.json, so they survive a restart). */
export const groupsKey = (sessionID: string) => `subagent_groups:${sessionID}`

/** How deep nested subagents (`subagent_depth` > 1) are followed. */
const MAX_NEST = 8

type Listed = SubagentEntry & { parent?: string }

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function color(theme: TuiThemeCurrent, look: Avatar, pixel: Pixel | undefined) {
  if (!pixel || pixel === ".") return theme.backgroundPanel
  if (pixel === "B") return theme[look.body]
  if (pixel === "M") return theme[look.mark]
  return theme[PIXEL_COLOR[pixel]]
}

function Sprite(props: { theme: TuiThemeCurrent; look: Avatar; closed: boolean }) {
  const rows = createMemo(() => halfRows(props.closed ? blink(props.look.animal.sprite) : props.look.animal.sprite))
  return (
    <box flexShrink={0}>
      <For each={rows()}>
        {(row) => (
          <text>
            <For each={row}>
              {(cell) => {
                const shown = halfCell(cell)
                return (
                  <span
                    style={{
                      fg: color(props.theme, props.look, shown.fg),
                      bg: color(props.theme, props.look, shown.bg),
                    }}
                  >
                    {shown.char}
                  </span>
                )
              }}
            </For>
          </text>
        )}
      </For>
    </box>
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const api = props.api
  const [open, setOpen] = createSignal(true)
  const theme = () => api.theme.current
  const settings = () => api.state.config.subagent
  const funNames = () => settings()?.fun_names !== false
  const mascots = () => settings()?.mascots !== false
  const noColor = prefersReducedMotion()

  const childInfo = (sessionID: string) => ({
    status: api.state.session.status(sessionID)?.type,
    waiting: api.state.session.permission(sessionID).length > 0 || api.state.session.question(sessionID).length > 0,
    queued: (api.state.session.get(sessionID)?.metadata?.subagent as { queued?: unknown } | undefined)?.queued === true,
    error: lastError(sessionID),
  })
  /** Why a subagent's last turn failed, from its last reply. */
  const lastError = (sessionID: string) => {
    const last = api.state.session.messages(sessionID).findLast((message) => message.role === "assistant")
    const error = last?.role === "assistant" ? last.error : undefined
    if (!error) return undefined
    const message = (error.data as { message?: unknown } | undefined)?.message
    return typeof message === "string" && message ? message : error.name
  }
  const partsOf = (sessionID: string) =>
    api.state.session.messages(sessionID).flatMap((message) => api.state.part(message.id))
  // This session's subagents, and theirs (XCOD-299: nested ones, `subagent_depth` > 1), each after
  // its parent. A child's own subagents are known once its messages reached this TUI.
  const list = createMemo(() => {
    const result: Listed[] = []
    const seen = new Set([props.session_id])
    const walk = (sessionID: string, parent: string | undefined, depth: number) => {
      for (const entry of subagentsOf(partsOf(sessionID), childInfo)) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        result.push({ ...entry, parent })
        if (depth < MAX_NEST) walk(entry.id, entry.id, depth + 1)
      }
    }
    walk(props.session_id, undefined, 1)
    return result
  })
  // Names and animals follow creation order, the same on every surface and after a restart.
  const created = createMemo(() => {
    const items = list().map((item) => ({ id: item.id, at: api.state.session.get(item.id)?.time.created }))
    // One source for every entry: the child sessions' creation times when all are known, else launch
    // order. Mixing the two could swap two parallel siblings' names as their sessions load.
    if (items.some((item) => item.at === undefined)) return items.map((item) => item.id)
    return items.toSorted((a, b) => a.at! - b.at! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((item) => item.id)
  })
  const looks = createMemo(() => assignAvatars(created()))
  const nameOf = (item: SubagentEntry) =>
    funNames() ? looks().get(item.id)!.name : plainName(created().indexOf(item.id))
  const running = createMemo(() => list().filter((item) => item.state === "running").length)

  // XCOD-299: Working, Waiting for action and Completed. What the user opened or collapsed is kept
  // per session; a new ask opens Waiting again, whatever was chosen.
  const overrides = () => api.kv.get<Overrides>(groupsKey(props.session_id), {})
  const grouped = createMemo(() => groupSubagents(list(), { overrides: overrides() }))
  createEffect(() => {
    if (grouped().reopened && api.kv.ready) api.kv.set(groupsKey(props.session_id), forgetWaiting(overrides()))
  })
  const flip = (view: GroupView<Listed>) => api.kv.set(groupsKey(props.session_id), toggle(overrides(), view))

  // One clock for the whole group, only while something runs: the blink (every 600 ms, not with
  // reduced motion) and the elapsed times.
  const animate = () =>
    animationsEnabled(
      // Built-in plugins get the whole TUI config; `reduced_motion` just isn't in the public type.
      (api.tuiConfig as { reduced_motion?: boolean }).reduced_motion,
      api.kv.get<boolean | undefined>("animations_enabled", undefined),
    )
  const [now, setNow] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (running() === 0) return
    const timer = setInterval(() => {
      setNow(Date.now())
      if (animate()) setFrame((x) => (x + 1) % 2)
    }, 600)
    onCleanup(() => {
      clearInterval(timer)
      setFrame(0)
    })
  })

  createEffect(() => {
    if (list().length === 0 || !api.kv.ready || api.kv.get<boolean>(NOTICE_KEY, false)) return
    api.kv.set(NOTICE_KEY, true)
    api.ui.toast({ variant: "info", message: FIRST_RUN_NOTICE })
  })

  const stateColor = (state: SubagentState) =>
    state === "waiting"
      ? theme().warning
      : state === "running"
        ? theme().info
        : state === "failed"
          ? theme().error
          : state === "queued"
            ? theme().textMuted
            : theme().success

  const usage = (item: SubagentEntry) => {
    const child = api.state.session.get(item.id)
    const parts: string[] = []
    if (item.started)
      parts.push(
        elapsed(
          (item.ended ??
            (item.state === "done" || item.state === "failed" ? child?.time.updated : undefined) ??
            now()) - item.started,
        ),
      )
    const t = child?.tokens
    const total = t ? t.input + t.output + t.reasoning + t.cache.read + t.cache.write : 0
    if (total > 0) parts.push(`${tokens(total)} tok`)
    if (child?.cost) parts.push(money.format(child.cost))
    return parts.join(" · ")
  }

  const asks = (sessionID: string) => ({
    permissions: api.state.session.permission(sessionID),
    questions: api.state.session.question(sessionID),
  })
  const fail = (cause: unknown) =>
    api.ui.toast({ variant: "error", message: cause instanceof Error ? cause.message : String(cause) })
  /** Approve or deny a Waiting row's ask, through the same replies as the session view. A question is answered there. */
  async function answer(item: SubagentEntry, allow: boolean) {
    const permission = api.state.session.permission(item.id)[0]
    if (permission) {
      await api.client.permission
        .reply({ requestID: permission.id, reply: allow ? "once" : "reject" }, { throwOnError: true })
        .catch(fail)
      return
    }
    const question = api.state.session.question(item.id)[0]
    if (!question) return
    if (allow) return api.route.navigate("session", { sessionID: item.id })
    await api.client.question.reject({ requestID: question.id }, { throwOnError: true }).catch(fail)
  }
  const press = (fn: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation()
    fn()
  }

  const Row = (row: { item: Listed; depth: number }) => {
    const look = () => looks().get(row.item.id)!
    const ask = () => (row.item.state === "waiting" ? askText(asks(row.item.id)) : undefined)
    return (
      <box
        flexDirection="row"
        gap={1}
        paddingTop={1}
        paddingLeft={4 + row.depth * 2}
        onMouseDown={() => api.route.navigate("session", { sessionID: row.item.id })}
      >
        <Show when={mascots()}>
          <Show
            when={!noColor}
            fallback={
              <text flexShrink={0} fg={theme().text}>
                [{glyph(look().animal)}]
              </text>
            }
          >
            <Sprite theme={theme()} look={look()} closed={row.item.state === "running" && frame() === 1} />
          </Show>
        </Show>
        <box flexGrow={1} flexShrink={1}>
          <text fg={theme().text} wrapMode="none">
            <b>{nameOf(row.item)}</b>
          </text>
          <text fg={theme().textMuted} wrapMode="none">
            {funNames() && mascots() ? `the ${look().animal.name} · ` : ""}@{row.item.agent}
            {row.item.background ? " · bg" : ""}
          </text>
          <text fg={theme().text} wrapMode="none">
            {row.item.description}
          </text>
          {/* Not colour alone (XCOD-141): the glyph and the word carry the state. */}
          <text wrapMode="none">
            <span style={{ fg: stateColor(row.item.state) }}>{GROUP_GLYPH[row.item.state]}</span>{" "}
            <span style={{ fg: row.item.state === "waiting" ? theme().warning : theme().textMuted }}>
              {ask() ?? ROW_LABEL[row.item.state]}
            </span>
          </text>
          <Show when={ask()}>
            <box flexDirection="row" gap={1}>
              <text fg={theme().success} wrapMode="none" onMouseDown={press(() => void answer(row.item, true))}>
                [approve]
              </text>
              <text fg={theme().error} wrapMode="none" onMouseDown={press(() => void answer(row.item, false))}>
                [deny]
              </text>
            </box>
          </Show>
          <Show when={row.item.state === "failed" && row.item.error}>
            <text fg={theme().error} wrapMode="none">
              {row.item.error}
            </text>
          </Show>
          <Show when={usage(row.item)}>
            <text fg={theme().textMuted} wrapMode="none">
              {usage(row.item)}
            </text>
          </Show>
          <Show when={row.item.model}>
            <text fg={theme().textMuted} wrapMode="none">
              {row.item.model}
            </text>
          </Show>
        </box>
      </box>
    )
  }

  // One level under Subagents, each with its own toggle and count; rows one level further in.
  const Section = (section: { view: GroupView<Listed> }) => {
    const view = () => section.view
    const urgent = () => view().group === "waiting" && view().count > 0
    return (
      <box paddingTop={1}>
        <box flexDirection="row" gap={1} paddingLeft={2} onMouseDown={() => flip(view())}>
          <text fg={view().empty ? theme().textMuted : theme().text}>{view().open ? "▼" : "▶"}</text>
          <text fg={view().empty ? theme().textMuted : theme().text}>
            {view().title}{" "}
            <Show when={urgent()} fallback={`(${view().count})`}>
              <span style={{ fg: theme().warning }}>
                <b>
                  <u>({view().count})</u>
                </b>
              </span>
            </Show>
          </text>
        </box>
        <Show when={!view().open && !view().empty && view().summary}>
          <box paddingLeft={6}>
            <text fg={theme().textMuted} wrapMode="none">
              {view().summary}
            </text>
          </box>
        </Show>
        <Show when={view().open}>
          <For each={view().rows}>{(row) => <Row item={row.item} depth={row.depth} />}</For>
        </Show>
      </box>
    )
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>Subagents</b>
            <span style={{ fg: theme().textMuted }}> ({grouped().total}</span>
            <Show when={grouped().waiting > 0}>
              <span style={{ fg: theme().textMuted }}> · </span>
              <span style={{ fg: theme().warning }}>
                <b>
                  <u>{grouped().waiting} need you</u>
                </b>
              </span>
            </Show>
            <span style={{ fg: theme().textMuted }}>)</span>
          </text>
        </box>
        <Show when={open()}>
          <For each={grouped().groups}>{(view) => <Section view={view} />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
