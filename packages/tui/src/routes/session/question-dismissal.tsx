import { createSignal, onCleanup } from "solid-js"
import type { QuestionAnswer, QuestionInfo, QuestionRequest, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import type { useSDK } from "../../context/sdk"
import type { useSync } from "../../context/sync"
import type { useToast } from "../../ui/toast"
import type { useTuiConfig } from "../../config"
import { createSoftRejects, formatLateAnswer, isDismissedQuestion } from "../../util/dismiss"
import type { QuestionDraft } from "./question"

type Held = { request: QuestionRequest; directory?: string; draft: QuestionDraft }

/**
 * Session-level half of XCOD-98:
 * - a dismissed question is held back for `question.undo_window` ms, during which ctrl+z restores
 *   it exactly as it was and the agent turn is still waiting on it;
 * - once rejected, its "Answer now" reopens the same panel and sends the answer as a new message.
 */
export function createQuestionDismissal(input: {
  sessionID: () => string
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
  config: ReturnType<typeof useTuiConfig>
}) {
  const [held, setHeld] = createSignal<ReadonlyMap<string, Held>>(new Map())
  const restored = new Map<string, QuestionDraft>()

  const rejects = createSoftRejects<Held>({
    window: () => input.config.question.undo_window,
    send: (id, value) => {
      setHeld((current) => {
        const next = new Map(current)
        next.delete(id)
        return next
      })
      void input.sdk.client.question.reject({
        requestID: id,
        directory: value.directory,
        drafts: { answers: value.draft.answers.map((answer) => answer ?? []), custom: value.draft.custom },
      })
    },
  })
  // Leaving the session (or quitting) must never leave the agent waiting on a held question.
  onCleanup(() => rejects.flush())

  const [answering, setAnswering] = createSignal<
    { request: QuestionRequest; callID: string; draft?: QuestionDraft } | undefined
  >()

  /** Reopens a dismissed question from its rejected tool part. */
  function openAnswer(part: ToolPart) {
    if (!isDismissedQuestion(part) || part.state.status !== "error") return
    const questions = (part.state.input?.questions ?? []) as QuestionInfo[]
    if (!questions.length) return
    const saved = part.state.metadata?.dismissed as { answers?: QuestionAnswer[]; custom?: string[] } | undefined
    setAnswering({
      callID: part.callID,
      request: { id: `answer_${part.callID}`, sessionID: part.sessionID, questions },
      draft: saved
        ? { tab: 0, selected: 0, answers: [...(saved.answers ?? [])], custom: [...(saved.custom ?? [])] }
        : undefined,
    })
  }

  return {
    /** Held questions are hidden from the panel until undone or sent. */
    isHeld: (id: string) => held().has(id),
    heldCount: () => held().size,
    dismiss(request: QuestionRequest, directory: string | undefined, draft: QuestionDraft) {
      const value = { request, directory, draft }
      if (input.config.question.undo_window > 0) {
        setHeld((current) => new Map(current).set(request.id, value))
        input.toast.show({
          variant: "info",
          message: "Question dismissed · Undo (ctrl+z)",
          duration: input.config.question.undo_window,
        })
      }
      rejects.dismiss(request.id, value)
    },
    undo() {
      const taken = rejects.undo()
      if (!taken) return
      restored.set(taken.id, taken.value.draft)
      setHeld((current) => {
        const next = new Map(current)
        next.delete(taken.id)
        return next
      })
      input.toast.show({ variant: "success", message: "Question restored", duration: 1500 })
    },
    /** The draft to reopen a restored question with; read once. */
    takeRestored(id: string) {
      const draft = restored.get(id)
      restored.delete(id)
      return draft
    },

    answering,
    openAnswer,
    /** `/answer`: the most recent dismissed question in this session. */
    openLatest() {
      const messages = input.sync.data.message[input.sessionID()] ?? []
      for (const message of [...messages].reverse()) {
        const part = (input.sync.data.part[message.id] ?? []).findLast(isDismissedQuestion)
        if (part?.type === "tool") return (openAnswer(part), true)
      }
      return false
    },
    closeAnswer: () => setAnswering(undefined),
    /** Sends every held dismissal now. */
    flush: () => rejects.flush(),
    async sendAnswer(answers: QuestionAnswer[]) {
      const current = answering()
      if (!current) return
      setAnswering(undefined)
      const sessionID = input.sessionID()
      const last = (input.sync.data.message[sessionID] ?? []).findLast(
        (message): message is UserMessage => message.role === "user",
      )
      // The original tool call has ended with its turn, so this is a new message that says which
      // question it answers. The call id travels in the part's metadata, not in the text.
      await input.sdk.client.session
        .prompt(
          {
            sessionID,
            agent: last?.agent,
            model: last ? { providerID: last.model.providerID, modelID: last.model.modelID } : undefined,
            variant: last?.model.variant,
            parts: [
              {
                type: "text",
                text: formatLateAnswer(current.request.questions, answers),
                metadata: { kind: "question_answer", callID: current.callID },
              },
            ],
          },
          { throwOnError: true },
        )
        .catch((error: unknown) =>
          input.toast.show({
            variant: "error",
            title: "Failed to send answer",
            message: error instanceof Error ? error.message : String(error),
          }),
        )
    },
  }
}

export type QuestionDismissal = ReturnType<typeof createQuestionDismissal>
