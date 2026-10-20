import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"

/** How long MCP servers that failed to connect at start stay named in the line. */
const FAILED_FOR = 10_000

/**
 * The words for what's still starting, or undefined when nothing is. `mcp` is undefined until the
 * server has reported its MCP servers.
 */
export function startupStatus(input: {
  status: "loading" | "partial" | "complete"
  plugins: boolean
  configured: string[]
  mcp?: Record<string, { status: string }>
  failedShown: boolean
}) {
  const parts: string[] = []
  if (input.status === "loading") parts.push("Starting…")
  if (!input.plugins) parts.push("plugins loading")
  if (input.configured.length > 0) {
    if (input.status !== "complete" || !input.mcp) parts.push(`MCP connecting… (${input.configured.length})`)
    else if (input.failedShown) {
      const failed = input.configured.filter((name) => input.mcp?.[name]?.status === "failed")
      if (failed.length) parts.push(`MCP ${failed.join(", ")} didn't connect`)
    }
  }
  return parts.length ? parts.join(" · ") : undefined
}

/**
 * XCOD-276: one muted line under the app while start-up work finishes behind the first frame: the
 * server's data, TUI plugins, MCP servers. Replaces the "Loading plugins…" overlay; the screen and
 * the prompt work the whole time.
 */
export function StartupStatus(props: { plugins: () => boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const configured = createMemo(() =>
    Object.entries(sync.data.config.mcp ?? {})
      .filter(([, entry]) => (entry as { enabled?: boolean }).enabled !== false)
      .map(([name]) => name),
  )
  const [failedShown, setFailedShown] = createSignal(true)
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    if (sync.status !== "complete" || timer) return
    timer = setTimeout(() => setFailedShown(false), FAILED_FOR)
    timer.unref?.()
  })
  onCleanup(() => clearTimeout(timer))

  const text = createMemo(() =>
    startupStatus({
      status: sync.status,
      plugins: props.plugins(),
      configured: configured(),
      mcp: sync.status === "complete" ? sync.data.mcp : undefined,
      failedShown: failedShown(),
    }),
  )

  return (
    <Show when={text()}>
      {(value) => (
        <box flexShrink={0} height={1} paddingLeft={2} paddingRight={2}>
          <text fg={theme.textMuted} wrapMode="none">
            {value()}
          </text>
        </box>
      )}
    </Show>
  )
}
