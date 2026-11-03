import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onCleanup, Show } from "solid-js"

const id = "internal:sidebar-remote"

/** How often the row re-reads the state: a phone can end remote, and it ends by itself after 12 hours. */
export const POLL_MS = 5000

export type RemoteRow = { on: boolean; url?: string; expiresAt?: number }

/** "2h 05m left", "12m left", "<1m left" (XCOD-338). */
export function remaining(expiresAt: number | undefined, now = Date.now()) {
  if (!expiresAt) return undefined
  const min = Math.floor((expiresAt - now) / 60_000)
  if (min < 1) return "<1m left"
  const h = Math.floor(min / 60)
  return h > 0 ? `${h}h ${String(min % 60).padStart(2, "0")}m left` : `${min}m left`
}

/**
 * XCOD-338: remote control in the session sidebar. Off, one muted line that turns it on; on, where to
 * open it and how long it lasts. Either way a click runs `/remote`, the same confirm and audit path as
 * the palette, so the sidebar can't turn it on without the question.
 */
export function View(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const [state, setState] = createSignal<RemoteRow | undefined>()
  const [now, setNow] = createSignal(Date.now())
  const read = () =>
    props.api.client.experimental.session
      .remote({ sessionID: props.sessionID })
      .then((res) =>
        setState(res.data ? { on: res.data.on, url: res.data.url, expiresAt: res.data.expiresAt } : undefined),
      )
      .catch(() => setState(undefined))
      .finally(() => setNow(Date.now()))
  void read()
  const timer = setInterval(() => void read(), POLL_MS)
  onCleanup(() => clearInterval(timer))
  const toggle = () => {
    props.api.command?.trigger("session.remote")
    // The dialog answers asynchronously: read again once it's likely done, as well as on the poll.
    setTimeout(() => void read(), 1500)
  }

  return (
    <Show when={state()}>
      {(current) => (
        <box>
          <Show
            when={current().on}
            fallback={
              <text fg={theme().textMuted} onMouseUp={toggle}>
                <b>Remote</b> off · <span style={{ fg: theme().text }}>turn on</span> (/remote)
              </text>
            }
          >
            <box flexDirection="row" gap={1} onMouseUp={toggle}>
              <text flexShrink={0} fg={theme().success}>
                •
              </text>
              <text fg={theme().text}>
                <b>Remote</b> on
                <span style={{ fg: theme().textMuted }}>
                  {" "}
                  · {remaining(current().expiresAt, now()) ?? ""} · turn off
                </span>
              </text>
            </box>
            <Show when={current().url}>
              <text fg={theme().textMuted} wrapMode="char">
                {current().url}
              </text>
            </Show>
          </Show>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 160,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
