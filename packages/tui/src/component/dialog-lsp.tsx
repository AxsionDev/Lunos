import { TextAttributes } from "@opentui/core"
import type { LspOverview, LspServerInfo } from "@opencode-ai/sdk/v2"
import { Show, createResource, onCleanup } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { LspPanel } from "../util/lsp-panel"

// XCOD-257: /lsp, and /settings → Tools → lsp. Whether LSP works, each server's state and why one
// failed, and what to do about it, instead of a raw JSON row.

export function DialogLsp(props: { focus?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [overview, { refetch }] = createResource(() =>
    sdk.client.lsp.servers().then((result) => result.data as LspOverview | undefined),
  )
  // States change as files are read and servers start; the panel follows without reopening.
  const timer = setInterval(() => void refetch(), 2000)
  onCleanup(() => clearInterval(timer))

  const setting = async (key: string, value: string | undefined, scope: "user" | "project" = "user") => {
    const result = await sdk.client.config
      .settingsSet({
        settingsSetInput: { key, value: value ?? "", scope, ...(value === undefined ? { unset: true } : {}) },
      })
      .catch((error: unknown) => ({ data: { ok: false as const, error: String(error) } }))
    const data = result.data as { ok: boolean; error?: string } | undefined
    if (!data?.ok) toast.show({ variant: "error", message: data?.error ?? `Couldn't change ${key}` })
    else toast.show({ variant: "success", message: `${key} saved to the ${scope} config · applies after /restart` })
  }

  const toggle = () => {
    const on = overview()?.enabled !== false
    // Off writes `"lsp": false`; on removes it, so the default (on) applies again.
    void setting("lsp", on ? "false" : undefined).then(() => refetch())
  }

  return (
    <DialogSelect<string>
      title="LSP"
      titleView={
        <box flexDirection="column" flexShrink={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            LSP is {overview()?.enabled === false ? "off" : "on"}
            <span style={{ fg: theme.textMuted }}>
              {" "}
              · downloads {overview()?.downloads === false ? "off (OPENCODE_DISABLE_LSP_DOWNLOAD)" : "allowed"}
            </span>
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            {LspPanel.EXPLANATION}
          </text>
          <Show when={overview()}>{(data) => <text fg={theme.text}>{LspPanel.summary(data())}</text>}</Show>
        </box>
      }
      current={props.focus}
      placeholder="Filter by name or file type"
      options={[
        {
          title: overview()?.enabled === false ? "Turn LSP on" : "Turn LSP off",
          value: "+toggle",
          category: "LSP",
          description: overview()?.enabled === false ? 'removes "lsp": false' : 'writes "lsp": false',
        },
        ...(overview()?.servers ?? []).map((item) => ({
          title: item.id,
          value: item.id,
          category: LspPanel.group(item),
          description: LspPanel.describe(item),
          footer: LspPanel.label(item),
        })),
      ]}
      onSelect={(option) => {
        if (option.value === "+toggle") return toggle()
        const item = overview()?.servers.find((server) => server.id === option.value)
        if (item) dialog.replace(() => <DialogLspServer server={item} setting={setting} />, undefined, back(item.id))
      }}
    />
  )

  function back(id: string) {
    return { back: () => dialog.replace(() => <DialogLsp focus={id} />), generation: dialog.generation }
  }
}

function DialogLspServer(props: {
  server: LspServerInfo
  setting: (key: string, value: string | undefined, scope?: "user" | "project") => Promise<void>
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const reopen = () => dialog.replace(() => <DialogLsp focus={props.server.id} />)
  const stop = async (restart: boolean) => {
    await sdk.client.lsp.stop({ serverID: props.server.id, restart }).catch(() => undefined)
    toast.show({
      variant: "info",
      message: restart
        ? `${props.server.id} restarts when a matching file is read`
        : `${props.server.id} stopped; it starts again when a matching file is read`,
    })
    reopen()
  }
  const showLog = async () => {
    const lines = (await sdk.client.lsp.log({ serverID: props.server.id }).catch(() => undefined))?.data ?? []
    dialog.replace(
      () => (
        <DialogSelect<string>
          title={`${props.server.id}: last ${lines.length} lines of stderr`}
          skipFilter
          options={(lines.length ? lines : ["(nothing written to stderr this session)"]).map((line, index) => ({
            title: line,
            value: String(index),
          }))}
        />
      ),
      undefined,
      { back: reopen, generation: dialog.generation },
    )
  }
  const disabled = props.server.state === "disabled" && props.server.reason === "turned off in config"

  return (
    <DialogSelect<string>
      title={props.server.id}
      titleView={
        <box flexDirection="column" flexShrink={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.server.id} <span style={{ fg: theme.textMuted }}>· {LspPanel.label(props.server)}</span>
          </text>
          {LspPanel.details(props.server).map((line) => (
            <text fg={line.startsWith("Failed") ? theme.error : theme.textMuted} wrapMode="word">
              {line}
            </text>
          ))}
        </box>
      }
      skipFilter
      options={[
        ...(props.server.state === "running" || props.server.state === "failed"
          ? [
              {
                title: "Restart",
                value: "restart",
                description: "stops it and forgets a failure; the next matching file starts it",
              },
            ]
          : []),
        ...(props.server.state === "running" ? [{ title: "Stop", value: "stop" }] : []),
        disabled
          ? { title: "Turn on", value: "on", description: `removes lsp.${props.server.id}.disabled` }
          : { title: "Turn off", value: "off", description: `writes lsp.${props.server.id}.disabled (user config)` },
        { title: "View log", value: "log", description: "the server's stderr this session" },
      ]}
      onSelect={(option) => {
        if (option.value === "restart") return void stop(true)
        if (option.value === "stop") return void stop(false)
        if (option.value === "log") return void showLog()
        const key = `lsp.${props.server.id}.disabled`
        void props.setting(key, option.value === "off" ? "true" : undefined).then(reopen)
      }}
    />
  )
}
