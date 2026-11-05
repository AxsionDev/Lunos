import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useBulkConfirm } from "@/pages/sessions/bulk-confirm"
import { showToast } from "@/utils/toast"
import { remoteControl } from "./remote-control"

/** XCOD-338: copies text, falling back to a hidden textarea where the async clipboard isn't allowed. */
async function copy(value: string) {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (
    clipboard?.writeText &&
    (await clipboard.writeText(value).then(
      () => true,
      () => false,
    ))
  )
    return true
  if (typeof document === "undefined" || !document.body) return false
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  document.body.removeChild(textarea)
  return copied
}

/** XCOD-338: `/remote` for the desktop app, bound to this window's server, dialogs and toasts. */
export function useRemoteControl() {
  const sdk = useSDK()
  const language = useLanguage()
  const confirm = useBulkConfirm()
  return (sessionID: string, want: "toggle" | "on" | "off") =>
    remoteControl({
      sessionID,
      want,
      client: {
        remote: (input) => sdk().client.experimental.session.remote(input),
        remoteSet: (input) => sdk().client.experimental.session.remoteSet(input),
      },
      confirm: async (input) => !!(await confirm({ title: input.title, lines: [input.body], confirm: input.confirm })),
      copy,
      toast: (input) => showToast(input),
      t: (key, params) => language.t(key, params),
    })
}
