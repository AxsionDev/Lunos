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
  ordered,
  PIXEL_COLOR,
  plainName,
  STATE_LABEL,
  subagentsOf,
  tokens,
  type Avatar,
  type Pixel,
  type SubagentEntry,
  type SubagentState,
} from "../../util/subagent-avatar"
import { STATUS_GLYPH } from "../../util/status-glyph"
import { animationsEnabled, prefersReducedMotion } from "../../util/motion"

// XCOD-287: the subagents this session launched, each with its own pixel-art animal and name.
const id = "internal:sidebar-subagents"

/** Shown once, the first time a session has a subagent. */
export const FIRST_RUN_NOTICE = "Lunos now splits work across subagents by default. Turn off in Settings."
const NOTICE_KEY = "subagents_notice_shown"

// Not colour alone (XCOD-141): every state has its own glyph and its label is always shown.
const STATE_GLYPH: Record<SubagentState, string> = {
  waiting: STATUS_GLYPH.attention,
  running: STATUS_GLYPH.pending,
  queued: STATUS_GLYPH.off,
  done: STATUS_GLYPH.ok,
  failed: STATUS_GLYPH.error,
}

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
  const [doneOpen, setDoneOpen] = createSignal(false)
  const theme = () => api.theme.current
  const settings = () => api.state.config.subagent
  const funNames = () => settings()?.fun_names !== false
  const mascots = () => settings()?.mascots !== false
  const noColor = prefersReducedMotion()

  const list = createMemo(() =>
    subagentsOf(
      api.state.session.messages(props.session_id).flatMap((message) => api.state.part(message.id)),
      (sessionID) => ({
        status: api.state.session.status(sessionID)?.type,
        waiting: api.state.session.permission(sessionID).length > 0 || api.state.session.question(sessionID).length > 0,
        queued:
          (api.state.session.get(sessionID)?.metadata?.subagent as { queued?: unknown } | undefined)?.queued === true,
      }),
    ),
  )
  // Names and animals follow creation order, the same on every surface and after a restart.
  const created = createMemo(() =>
    list()
      .map((item) => ({ id: item.id, at: api.state.session.get(item.id)?.time.created ?? item.started ?? 0 }))
      .toSorted((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((item) => item.id),
  )
  const looks = createMemo(() => assignAvatars(created()))
  const nameOf = (item: SubagentEntry) =>
    funNames() ? looks().get(item.id)!.name : plainName(created().indexOf(item.id))
  const sorted = createMemo(() => ordered(list()))
  const active = createMemo(() => sorted().filter((item) => item.state !== "done" && item.state !== "failed"))
  const finished = createMemo(() => sorted().filter((item) => item.state === "done" || item.state === "failed"))
  const running = createMemo(() => list().filter((item) => item.state === "running").length)

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

  const Row = (row: { item: SubagentEntry }) => {
    const look = () => looks().get(row.item.id)!
    return (
      <box
        flexDirection="row"
        gap={1}
        paddingTop={1}
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
          <text wrapMode="none">
            <span style={{ fg: stateColor(row.item.state) }}>{STATE_GLYPH[row.item.state]}</span>{" "}
            <span style={{ fg: theme().textMuted }}>{STATE_LABEL[row.item.state]}</span>
          </text>
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

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>Subagents</b>
            <span style={{ fg: theme().textMuted }}>
              {" "}
              ({list().length}
              {running() > 0 ? `, ${running()} working` : ""})
            </span>
          </text>
        </box>
        <Show when={open()}>
          <For each={active()}>{(item) => <Row item={item} />}</For>
          <Show when={finished().length > 0}>
            <box flexDirection="row" gap={1} paddingTop={1} onMouseDown={() => setDoneOpen((x) => !x)}>
              <text fg={theme().textMuted}>{doneOpen() ? "▼" : "▶"}</text>
              <text fg={theme().textMuted}>Done ({finished().length})</text>
            </box>
            <Show when={doneOpen()}>
              <For each={finished()}>{(item) => <Row item={item} />}</For>
            </Show>
          </Show>
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
