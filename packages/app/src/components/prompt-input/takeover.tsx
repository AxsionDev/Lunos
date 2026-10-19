import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useBulkConfirm } from "@/pages/sessions/bulk-confirm"
import { formatServerError } from "@/utils/server-errors"

/** The request the session view would have made for a prompt, sent once the queued ones have run. */
export type TakeoverRequest = { kind: "prompt" | "command" | "shell"; body: Record<string, unknown> }

export type SessionTakeover = {
  /**
   * Before a prompt runs in a session whose Lunos closed with prompts queued for it: the same
   * "Take over this session here?" as the Agent Monitor. Discard happens here; "send" is left to
   * `send`, which carries the prompt so it runs after them. Undefined: nothing queued, send as usual.
   */
  ask: (sessionID: string) => Promise<"send" | "discard" | "cancel" | undefined>
  send: (sessionID: string, text: string, request: TakeoverRequest) => Promise<boolean>
}

/** XCOD-267: the full session view asks before its first prompt, as the Sessions window's monitor does. */
export function useSessionTakeover(): SessionTakeover {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const confirm = useBulkConfirm()
  const t = language.t
  const fail = (cause: unknown) => {
    showToast({ title: t("sessions.monitor.takeover.title"), description: formatServerError(cause, t) })
  }

  return {
    async ask(sessionID) {
      const client = sdk().client
      const held = await client.experimental.session
        .queued({ sessionID }, { throwOnError: true })
        .then((response) => response.data.orphaned)
        .catch(() => 0)
      if (!held) return undefined
      const title = sync().session.get(sessionID)?.title ?? sessionID
      const answer = await confirm({
        title: t("sessions.monitor.takeover.title"),
        lines: [t("sessions.monitor.takeover.queuedBody", { title, count: held })],
        confirm: t("sessions.monitor.takeover.confirm"),
        scopeLabel: t("sessions.monitor.takeover.queuedLabel"),
        scopes: [
          { value: "send", label: t("sessions.monitor.takeover.queuedSend", { count: held }) },
          { value: "discard", label: t("sessions.monitor.takeover.queuedDiscard", { count: held }) },
        ],
      })
      if (!answer) return "cancel"
      if (answer.scope !== "discard") return "send"
      return client.experimental.session
        .takeover({ sessionID, queued: "discard", origin: "session" }, { throwOnError: true })
        .then(
          () => "discard" as const,
          (cause: unknown) => (fail(cause), "cancel" as const),
        )
    },
    send(sessionID, text, request) {
      return sdk()
        .client.experimental.session.takeover(
          { sessionID, queued: "send", origin: "session", text, request },
          { throwOnError: true },
        )
        .then(
          () => true,
          (cause: unknown) => (fail(cause), false),
        )
    },
  }
}
