// XCOD-286: exiting inside a Claude Code / Codex session closes that session and returns to the view
// it was opened from, as exiting the tool itself does; Lunos keeps running. Quitting Lunos is explicit
// (`/exit:lunos`, Quit Lunos in the palette, or exit again from a Lunos view), and stops any tool
// that is still working first, so no `claude` or `codex` process outlives it.
import { useExit } from "../context/exit"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useToast } from "../ui/toast"
import { EXTERNAL_LABEL, externalOf, type ExternalTool } from "../util/external"

/** Typed as the prompt, these exit: Lunos in a Lunos view, the tool's session in an external one. */
export const EXIT_WORDS = new Set(["exit", "quit", ":q"])
/** The same as slash commands; the tool's own `/exit` (if it lists one) counts too. */
export const EXIT_SLASHES = new Set(["/exit", "/quit", "/q"])
/** XCOD-254's `:lunos` suffix: Lunos's own exit, from inside an external session too. */
export const QUIT_LUNOS = "/exit:lunos"

/** What the typed prompt asks for: close the session / quit Lunos, or nothing exit-related. */
export function exitIntent(text: string, external: boolean): "close" | "quit" | undefined {
  const trimmed = text.trim()
  if (trimmed === QUIT_LUNOS) return "quit"
  if (EXIT_WORDS.has(trimmed)) return external ? "close" : "quit"
  if (external && EXIT_SLASHES.has(trimmed)) return "close"
  return undefined
}

/** The footer toast after closing: `Closed Claude Code session "fix-auth" · /claude to continue`. */
export function closedMessage(tool: ExternalTool, title: string | undefined) {
  return `Closed ${EXTERNAL_LABEL[tool]} session${title ? ` "${title}"` : ""} · /${tool} to continue`
}

/** "2 Claude Code / Codex sessions are running", for the question asked before quitting. */
export function runningMessage(count: number) {
  return `${count} Claude Code / Codex session${count === 1 ? " is" : "s are"} running. Stop ${count === 1 ? "it" : "them"} and quit?`
}

export function useExternalExit() {
  const sdk = useSDK()
  const sync = useSync()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const exit = useExit()

  const marker = (sessionID: string) => externalOf(sync.session.get(sessionID))
  const busy = (sessionID: string) => (sync.data.session_status?.[sessionID]?.type ?? "idle") !== "idle"

  /** Pending approvals are refused ("Session closed") so the tool doesn't wait on them, then the turn stops. */
  const stop = async (sessionID: string) => {
    const pending = sync.data.permission[sessionID] ?? []
    await Promise.all(
      pending.map((request) =>
        sdk.client.permission
          .reply({ requestID: request.id, reply: "reject", message: "Session closed" })
          .catch(() => undefined),
      ),
    )
    await sdk.client.session.abort({ sessionID }).catch(() => undefined)
  }

  const leave = (sessionID: string) => {
    const tool = marker(sessionID)?.tool
    const title = sync.session.get(sessionID)?.title
    dialog.clear()
    route.leave(sessionID)
    if (tool) toast.show({ variant: "info", message: closedMessage(tool, title), duration: 6000 })
  }

  const confirm = (title: string, message: string, confirmLabel: string, cancelLabel: string) =>
    new Promise<boolean>((resolve) => {
      dialog.replace(
        () => (
          <DialogConfirm
            title={title}
            message={message}
            confirmLabel={confirmLabel}
            label={cancelLabel}
            onConfirm={() => resolve(true)}
            onCancel={() => resolve(false)}
          />
        ),
        () => resolve(false),
      )
    })

  const self = {
    /**
     * Whether app.tsx's global exit binding applies: not while a focused prompt in an external session
     * takes the keys itself (unless an approval or question docked over it has them). Otherwise as
     * before: when the prompt isn't focused, or is empty.
     */
    globalKeys(prompt: { focused: boolean; current: { input: string } } | undefined) {
      if (!prompt?.focused) return true
      const sessionID = self.current()
      if (sessionID && !sync.data.permission[sessionID]?.length && !sync.data.question[sessionID]?.length) return false
      return prompt.current.input === ""
    },
    /** `app.exit` (/exit, /quit, /q and the exit keys) and `app.quit` (/exit:lunos, Quit Lunos). */
    commands() {
      const sessionID = self.current()
      return [
        {
          // In a Claude Code / Codex session this closes that session and goes back; Lunos keeps
          // running. Elsewhere it quits Lunos, asking first if a tool is still working.
          name: "app.exit",
          title: sessionID ? "Close this session" : "Exit the app",
          slashName: "exit",
          slashAliases: ["quit", "q"],
          run: () => {
            const current = self.current()
            void (current ? self.close(current) : self.quit())
          },
          category: "System",
        },
        {
          // Quits Lunos from anywhere, an external session included (XCOD-254's `:lunos` form).
          name: "app.quit",
          title: "Quit Lunos",
          slashName: QUIT_LUNOS.slice(1),
          run: () => void self.quit(),
          category: "System",
        },
      ]
    },
    /** The external session the current view shows, if it is one. */
    current() {
      if (route.data.type !== "session") return undefined
      return marker(route.data.sessionID) ? route.data.sessionID : undefined
    },
    /**
     * Closes external session `sessionID`. Idle: at once (no tool process runs between turns, and the
     * session keeps its history for Continue). Working: asks first; `interrupt` (ctrl+c) interrupts
     * the turn instead, as in the tool, and a second press while idle closes.
     */
    async close(sessionID: string, how: "exit" | "interrupt" = "exit") {
      const tool = marker(sessionID)?.tool
      if (!tool) return
      if (!busy(sessionID)) return leave(sessionID)
      if (how === "interrupt") {
        await stop(sessionID)
        toast.show({
          variant: "info",
          message: `Interrupted ${EXTERNAL_LABEL[tool]} · press again to close the session`,
        })
        return
      }
      const yes = await confirm(
        `${EXTERNAL_LABEL[tool]} is working`,
        "Stop and close?",
        "Stop and close",
        "Keep working",
      )
      if (!yes) return
      await stop(sessionID)
      leave(sessionID)
    },
    /** Quits Lunos. With Claude Code / Codex sessions still working, asks once and stops them first. */
    async quit() {
      const running = Object.keys(sync.data.session_status ?? {}).filter((id) => busy(id) && marker(id))
      if (running.length) {
        const yes = await confirm("Quit Lunos", runningMessage(running.length), "Stop and quit", "Cancel")
        if (!yes) return
        await Promise.all(running.map(stop))
      }
      exit()
    },
  }
  return self
}
