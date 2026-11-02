import { createSignal } from "solid-js"
import { useAccount } from "../context/account"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

// XCOD-318: /feedback, to the Lunos team. First what you want to say, then (in a session) whether to
// share that session's id with it: "don't share" is the first choice and the default, and the id is
// sent only when you pick "share". Your version and OS go with it; never the conversation itself.

export const FEEDBACK_HINT = "Goes to the Lunos team with your Lunos version and OS. Never your conversation."

export function DialogFeedback(props: { sessionID?: string }) {
  const dialog = useDialog()
  const account = useAccount()
  const toast = useToast()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)

  const send = async (text: string, consent: boolean) => {
    setBusy(true)
    try {
      await account.host!.feedback!({
        text,
        consent,
        ...(consent && props.sessionID ? { sessionId: props.sessionID } : {}),
      })
      dialog.clear()
      toast.show({ variant: "success", message: "Thank you. Your feedback went to the Lunos team." })
    } catch (cause) {
      setBusy(false)
      toast.show({ variant: "error", message: errorMessage(cause) })
    }
  }

  const consent = (text: string) =>
    dialog.replace(() => (
      <DialogSelect
        title="Share this session's id with your feedback?"
        options={[
          {
            title: "Send without the session id",
            value: false,
            description: "Only what you wrote, your version and OS",
          },
          {
            title: "Send and share this session's id",
            value: true,
            description: `${props.sessionID} — helps us find it in our logs. Never the conversation.`,
          },
        ]}
        onSelect={(option) => void send(text, option.value === true)}
      />
    ))

  return (
    <DialogPrompt
      title="Send feedback"
      placeholder="What works, what doesn't, what you miss"
      busy={busy()}
      busyText="Sending…"
      description={() => <text fg={theme.textMuted}>{FEEDBACK_HINT}</text>}
      onConfirm={(value) => {
        const text = value.trim()
        if (!text) return toast.show({ variant: "warning", message: "Write what you'd like to tell us first." })
        if (props.sessionID) return consent(text)
        void send(text, false)
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
