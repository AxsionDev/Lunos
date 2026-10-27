import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { feedbackInput, readScreenshot, SCREENSHOT_TYPES, type Screenshot } from "@/utils/feedback"
import { createSdkForServer } from "@/utils/server"
import { showToast } from "@/utils/toast"

/**
 * XCOD-318: the Feedback button's dialog. What you write, an optional screenshot you choose, and (in
 * a session) a box to share that session's id, unticked by default. The local server sends it on to
 * Lunos Cloud with this machine's sign-in, with the Lunos version and OS; never the conversation.
 * Taking the screenshot for you (desktop window capture) is a follow-up: you attach one.
 */
export function DialogFeedback(props: { sessionID?: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const [text, setText] = createSignal("")
  const [consent, setConsent] = createSignal(false)
  const [screenshot, setScreenshot] = createSignal<Screenshot>()
  const [problem, setProblem] = createSignal<string>()
  const [sending, setSending] = createSignal(false)

  const choose = async (file: File | undefined) => {
    setProblem(undefined)
    setScreenshot(undefined)
    if (!file) return
    const read = await readScreenshot(file)
    if ("error" in read) return setProblem(language.t("feedback.screenshot.invalid"))
    setScreenshot(read)
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const http = server.current?.http
    if (!http || !text().trim() || sending()) return
    setSending(true)
    const input = feedbackInput({
      text: text(),
      consent: consent(),
      sessionId: props.sessionID,
      screenshot: screenshot(),
      desktop: platform.platform === "desktop",
    })
    const result = await createSdkForServer({ server: http, fetch: platform.fetch ?? globalThis.fetch })
      .global.feedback({ globalFeedbackInput: input })
      .catch((error: unknown) => ({ error, data: undefined }))
    setSending(false)
    const failed = result.error ?? (result.data && !result.data.success ? result.data : undefined)
    if (failed) {
      const message = (failed as { error?: unknown }).error
      return showToast({
        title: language.t("feedback.failed"),
        description: typeof message === "string" ? message : language.t("common.requestFailed"),
      })
    }
    dialog.close()
    showToast({ variant: "success", icon: "circle-check", title: language.t("feedback.sent") })
  }

  return (
    <Dialog title={language.t("feedback.title")} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={submit} class="flex flex-col gap-6 p-6 pt-0">
        <p class="text-14-regular text-text-base">{language.t("feedback.description")}</p>
        <TextField
          multiline
          autofocus
          label={language.t("feedback.title")}
          hideLabel
          value={text()}
          onChange={setText}
          maxLength={5000}
          class="min-h-24 w-full"
        />
        <label class="flex flex-col gap-2 text-13-regular text-text-base">
          {language.t("feedback.screenshot")}
          <input
            type="file"
            accept={SCREENSHOT_TYPES.join(",")}
            onChange={(event) => void choose(event.currentTarget.files?.[0])}
          />
        </label>
        <Show when={problem()}>
          <p role="alert" class="text-13-regular text-text-critical-base">
            {problem()}
          </p>
        </Show>
        <Show when={props.sessionID}>
          <Checkbox checked={consent()} onChange={setConsent}>
            {language.t("feedback.consent")}
          </Checkbox>
        </Show>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={sending() || !text().trim()}>
            {language.t("common.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
