import { createMemo } from "solid-js"
import { ConfigExternal } from "@opencode-ai/core/config/external"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useTuiConfig } from "../config"
import { OPENCODE_BASE_MODE, useBindings } from "../keymap"
import { externalOf, refusalMessage } from "../util/external"

/**
 * XCOD-285: the key profile of a Claude Code session, so the keys do what they do in the tool. Only
 * what the installed tool reports is bound:
 *
 *   Shift+Tab (Lunos's mode.cycle.reverse key, rebindable) cycles Claude Code's permission mode
 *   through the modes this install's `--help` lists (ConfigExternal.cycle: default/manual → acceptEdits
 *   → plan). The running turn switches at once and later turns start in it. Inside the session the
 *   tool's binding wins over Lunos's agent cycle; elsewhere Lunos's key is untouched.
 *
 * Codex has no mode to cycle (its sandbox and approval policy are per thread), so it binds nothing.
 */
export function useExternalKeyProfile(sessionID: () => string | undefined) {
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const tuiConfig = useTuiConfig()
  const marker = createMemo(() => {
    const id = sessionID()
    return id ? externalOf(sync.session.get(id)) : undefined
  })
  // What this Claude Code reports, asked once (it runs `claude --help`).
  let modes: Promise<string[]> | undefined
  const reported = () =>
    (modes ??= sdk.client.experimental.external
      .tools()
      .then((result) => ConfigExternal.cycle(result.data?.find((item) => item.tool === "claude")?.permissionModes))
      .catch(() => []))

  const cycle = async () => {
    const id = sessionID()
    const current = marker()
    if (!id || current?.tool !== "claude") return
    const list = await reported()
    const target = ConfigExternal.next(list, current.permissionMode ?? current.mode)
    if (!target) {
      toast.show({ variant: "info", message: "This Claude Code doesn't list permission modes to cycle" })
      return
    }
    await sdk.client.experimental.external
      .mode({ sessionID: id, mode: target }, { throwOnError: true })
      .catch((error: unknown) =>
        toast.show({ variant: "error", message: refusalMessage(error, "The permission mode wasn't changed") }),
      )
  }

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: marker()?.tool === "claude",
    priority: 10,
    bindings: tuiConfig.keybinds.get("mode.cycle.reverse").map((binding) => ({
      ...binding,
      desc: "Cycle Claude Code's permission mode",
      group: "Claude Code",
      cmd: () => void cycle(),
    })),
  }))
}

/**
 * XCOD-285: the permission mode for the status line, as the tool names it: the one chosen in this
 * session, else the one the tool reported. Its default (`default`, or `manual`) shows nothing.
 */
export function externalModeLabel(marker: { permissionMode?: string; mode?: string } | undefined) {
  const mode = marker?.permissionMode ?? marker?.mode
  if (!mode || mode === "default" || mode === "manual") return undefined
  return mode
}
