import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import type { DialogContext } from "../ui/dialog"
import type { useSDK } from "../context/sdk"
import type { useToast } from "../ui/toast"
import type { useClipboard } from "../context/clipboard"
import { errorMessage } from "../util/error"

// XCOD-191: /share with "share": "cloud". Uploads the session to the organisation's Lunos console
// through the server, with the same rules and code as `lunos share <session>` (sharing setting,
// residency check against the console's declared region, audit, sanitize, link).

type Choice = { sanitize: boolean; link: boolean }

const CHOICES: DialogSelectOption<Choice>[] = [
  {
    title: "Share with your organisation",
    description: "the whole session, as lunos export writes it; members see it on the console",
    value: { sanitize: false, link: false },
  },
  {
    title: "Share redacted",
    description: "transcript and file data redacted first, as lunos export --sanitize",
    value: { sanitize: true, link: false },
  },
  {
    title: "Share, with a link",
    description: "also a link that works without signing in, for 30 days (or your organisation's maximum)",
    value: { sanitize: false, link: true },
  },
  {
    title: "Share redacted, with a link",
    description: "redacted first, plus a link that works without signing in",
    value: { sanitize: true, link: true },
  },
]

export async function shareToConsole(input: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  toast: ReturnType<typeof useToast>
  clipboard: ReturnType<typeof useClipboard>
  sessionID: string
}) {
  const { dialog, sdk, toast, clipboard } = input
  const choice = await new Promise<Choice | undefined>((resolve) => {
    dialog.replace(
      () => (
        <DialogSelect
          title="Share this session with your organisation's Lunos console"
          options={CHOICES}
          onSelect={(option) => resolve(option.value)}
        />
      ),
      () => resolve(undefined),
    )
  })
  if (!choice) return
  dialog.clear()
  toast.show({ variant: "info", message: "Sharing with your organisation…" })
  const result = await sdk.client.session
    .shareConsole({
      sessionID: input.sessionID,
      sessionShareConsoleInput: { sanitize: choice.sanitize, ...(choice.link ? { link: true } : {}) },
    })
    .catch((error) => ({ error, data: undefined }))
  if (result.error || !result.data) {
    toast.show({ variant: "error", title: "Not shared", message: errorMessage(result.error), duration: 10_000 })
    return
  }
  const done = result.data
  // The URL is shown, not only copied: a terminal without clipboard access still gets it.
  await clipboard.write?.(done.url).catch(() => undefined)
  await DialogAlert.show(
    dialog,
    `Shared with ${done.org}`,
    [
      `On ${done.host}: ${done.url}`,
      ...(done.link ? [`Link (works without signing in until ${done.link.expiresAt}): ${done.link.url}`] : []),
      `Revoke it with: lunos share revoke ${done.id}`,
    ].join("\n"),
  )
}
