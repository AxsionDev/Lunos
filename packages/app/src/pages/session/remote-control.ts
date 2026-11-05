// XCOD-338: `/remote` in the desktop app, as in the TUI (packages/tui/src/component/remote-control.ts):
// on asks first, then shows and copies the app.lunos.tech link; off ends it at once. The work is done
// by the session's own process through POST /experimental/session/:id/remote.

/** `/remote`, `/remote on`, `/remote off`: what a typed prompt asks for, or undefined when it isn't one. */
export function parseRemote(text: string): "toggle" | "on" | "off" | undefined {
  const m = /^\/remote(?:\s+(on|off))?\s*$/i.exec(text.trim())
  if (!m) return undefined
  return m[1] ? (m[1].toLowerCase() as "on" | "off") : "toggle"
}

type Status = { on: boolean; url?: string }
type Result = { data?: Status; error?: unknown }

export type RemoteControlInput = {
  sessionID: string
  want: "toggle" | "on" | "off"
  client: {
    remote: (input: { sessionID: string }) => Promise<Result>
    remoteSet: (input: { sessionID: string; on: boolean }) => Promise<Result>
  }
  /** Resolves true when the user confirmed. */
  confirm: (input: { title: string; body: string; confirm: string }) => Promise<boolean>
  copy: (text: string) => Promise<boolean>
  toast: (input: { title: string; description?: string; variant: "success" | "error" | "default" }) => void
  t: (key: RemoteKey, params?: { url: string }) => string
}

export type RemoteKey =
  | "session.remote.on.title"
  | "session.remote.on.body"
  | "session.remote.on.confirm"
  | "session.remote.off.title"
  | "session.remote.off.body"
  | "session.remote.off.confirm"
  | "toast.session.remote.on.title"
  | "toast.session.remote.on.copied"
  | "toast.session.remote.already"
  | "toast.session.remote.off.title"
  | "toast.session.remote.onFailed.title"
  | "toast.session.remote.offFailed.title"

/** The reason the process gave for refusing (offline, policy, signed out, ...), shown as it said it. */
export function refusal(error: unknown) {
  if (!error) return undefined
  if (error instanceof Error) return error.message
  const body = error as { message?: unknown; data?: { message?: unknown } }
  if (typeof body.message === "string") return body.message
  if (typeof body.data?.message === "string") return body.data.message
  return undefined
}

/** Turns remote control of a session on or off (`want`), or toggles it. Resolves to whether it is on. */
export async function remoteControl(input: RemoteControlInput): Promise<boolean> {
  const { client, t, toast, sessionID } = input
  const call = (p: Promise<Result>) => p.catch((error: unknown) => ({ error, data: undefined }) as Result)
  const current = await call(client.remote({ sessionID }))
  const on = current.data?.on === true
  const url = current.data?.url ?? ""
  if (on && input.want === "on") {
    toast({ title: t("toast.session.remote.already", { url }), variant: "default" })
    return true
  }
  if (!on && input.want === "off") {
    toast({ title: t("toast.session.remote.off.title"), variant: "default" })
    return false
  }
  if (on) {
    // Typed `/remote off` is the answer already; the palette's toggle asks.
    if (
      input.want === "toggle" &&
      !(await input.confirm({
        title: t("session.remote.off.title"),
        body: t("session.remote.off.body", { url }),
        confirm: t("session.remote.off.confirm"),
      }))
    )
      return true
    const res = await call(client.remoteSet({ sessionID, on: false }))
    if (res.error) {
      toast({ title: t("toast.session.remote.offFailed.title"), description: refusal(res.error), variant: "error" })
      return true
    }
    toast({ title: t("toast.session.remote.off.title"), variant: "default" })
    return false
  }
  const ok = await input.confirm({
    title: t("session.remote.on.title"),
    body: t("session.remote.on.body"),
    confirm: t("session.remote.on.confirm"),
  })
  if (!ok) return false
  const res = await call(client.remoteSet({ sessionID, on: true }))
  if (res.error || !res.data?.url) {
    toast({ title: t("toast.session.remote.onFailed.title"), description: refusal(res.error), variant: "error" })
    return false
  }
  const link = res.data.url
  const copied = await input.copy(link).catch(() => false)
  toast({
    title: t("toast.session.remote.on.title"),
    description: copied ? t("toast.session.remote.on.copied", { url: link }) : link,
    variant: "success",
  })
  return true
}
