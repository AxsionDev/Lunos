import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import type { useSDK } from "../context/sdk"
import type { useToast } from "../ui/toast"
import type { useClipboard } from "../context/clipboard"

export const CONFIRM_ON =
  "You (signed in to your Lunos account) can then follow this session at app.lunos.tech, answer its approvals and questions, send prompts and stop it, for up to 12 hours. It still runs here, under this computer's policy. Lunos keeps one outgoing connection to Lunos Cloud (EU); no port is opened. /remote off ends it."

/** `/remote`, `/remote on`, `/remote off`: what a typed prompt asks for, or undefined when it isn't one. */
export function parseRemote(text: string): "toggle" | "on" | "off" | undefined {
  const m = /^\/remote(?:\s+(on|off))?\s*$/i.exec(text.trim())
  if (!m) return undefined
  return m[1] ? (m[1].toLowerCase() as "on" | "off") : "toggle"
}

/**
 * XCOD-338: turns remote control of a session on or off (`want`), or toggles it. On asks first, then
 * shows and copies the app.lunos.tech link; off ends it at once.
 */
export async function remoteControl(input: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  toast: ReturnType<typeof useToast>
  clipboard: ReturnType<typeof useClipboard>
  sessionID: string
  want: "toggle" | "on" | "off"
}) {
  const { dialog, sdk, toast, clipboard, sessionID } = input
  const fail = (res: { error?: unknown }, fallback: string) => {
    const body = res.error as { message?: unknown; data?: { message?: unknown } } | undefined
    const message =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.data?.message === "string"
          ? body.data.message
          : fallback
    toast.show({ message, variant: "error", duration: 8000 })
  }
  const current = await sdk.client.experimental.session.remote({ sessionID }).catch(() => undefined)
  const on = current?.data?.on === true
  if (on && input.want === "on") {
    toast.show({ message: `Remote control is already on: ${current?.data?.url}`, variant: "info", duration: 8000 })
    return
  }
  if (!on && input.want === "off") {
    toast.show({ message: "Remote control is off.", variant: "info" })
    return
  }
  if (on) {
    // Typed `/remote off` is the answer already; the palette's toggle asks.
    if (input.want === "toggle") {
      const ok = await DialogConfirm.show(
        dialog,
        "Remote control is on",
        `This session can be followed and steered at ${current?.data?.url}. Turn remote control off? It ends at once.`,
      )
      dialog.clear()
      if (ok !== true) return
    }
    const res = await sdk.client.experimental.session.remoteSet({ sessionID, on: false })
    if (res.error) return fail(res, "Couldn't turn remote control off")
    toast.show({ message: "Remote control is off.", variant: "info" })
    return
  }
  const ok = await DialogConfirm.show(dialog, "Turn remote control on?", CONFIRM_ON)
  dialog.clear()
  if (ok !== true) return
  const res = await sdk.client.experimental.session.remoteSet({ sessionID, on: true })
  if (res.error || !res.data?.url) return fail(res, "Couldn't turn remote control on")
  const url = res.data.url
  await (clipboard.write?.(url) ?? Promise.reject())
    .then(() => toast.show({ message: `Remote control is on: ${url} (copied)`, variant: "success", duration: 8000 }))
    .catch(() => toast.show({ message: `Remote control is on: ${url}`, variant: "success", duration: 8000 }))
}
