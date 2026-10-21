// XCOD-284: deleting sessions for good from /sessions and the Agent Monitor's rail. One confirmation
// that says what goes and what is kept; more than one session also needs its count typed back.
// The server does the deleting (experimental.sessionBulk.delete, the same path as Delete archived).
import type { SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { createSignal, For } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { deleteQuestion, deleteSummary, topLevel, type DeletePreview } from "../util/sessions-overview"

export type DeleteOutcome = { deleted: string[]; skipped: { id: string; reason: string }[] }

type Choice = "delete" | "stop" | "skip"

export function useSessionDelete() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()

  /** Asks; Cancel is first, so it is the default, and Esc cancels. The sync row toggles in place. */
  function ask(input: { title: string; lines: string[]; options: { value: Choice; title: string }[]; sync: boolean }) {
    const [cloud, setCloud] = createSignal(true)
    return new Promise<{ choice: Choice; keepCloud: boolean } | undefined>((resolve) =>
      dialog.replace(
        () => (
          <DialogSelect<Choice | "cancel" | "cloud">
            title={input.title}
            titleView={
              <box flexShrink={1} paddingRight={2} flexDirection="column">
                <text fg={theme.text} wrapMode="word">
                  {input.title}
                </text>
                <For each={input.lines}>
                  {(line) => (
                    <text fg={theme.textMuted} wrapMode="word">
                      {line}
                    </text>
                  )}
                </For>
              </box>
            }
            renderFilter={false}
            preserveSelection={true}
            options={[
              { value: "cancel" as const, title: "Cancel" },
              ...input.options,
              ...(input.sync
                ? [
                    {
                      value: "cloud" as const,
                      title: `[${cloud() ? "x" : " "}] Also delete the synced copy on Lunos Cloud`,
                    },
                  ]
                : []),
            ]}
            onSelect={(option) => {
              if (option.value === "cloud") return setCloud((value) => !value)
              resolve(option.value === "cancel" ? undefined : { choice: option.value as Choice, keepCloud: !cloud() })
            }}
          />
        ),
        () => resolve(undefined),
      ),
    )
  }

  /**
   * Confirms and deletes `rows`. Returns what the server did, or undefined when nothing was asked
   * of it (cancelled, a count that didn't match). The caller re-opens its own view.
   */
  return async function remove(
    rows: SessionOverviewItem[],
    opts: { archivedView?: boolean } = {},
  ): Promise<DeleteOutcome | undefined> {
    // A subagent goes with its parent.
    const items = topLevel(rows)
    if (items.length === 0) return undefined
    const preview = await sdk.client.experimental.sessionBulk
      .preview({ sessionIDs: items.map((item) => item.id) }, { throwOnError: true })
      .then((response) => response.data as { items: DeletePreview[]; sync: boolean })
      .catch((cause) => {
        toast.show({ variant: "error", message: errorMessage(cause) })
        return undefined
      })
    if (!preview) return undefined
    const question = deleteQuestion({ items, preview: preview.items, archivedView: opts.archivedView })
    const running = question.running.length
    const single = items.length === 1
    const options: { value: Choice; title: string }[] = running
      ? [
          { value: "stop", title: single ? "Stop and delete" : `Stop ${running} and delete ${items.length}` },
          ...(items.length > running
            ? [{ value: "skip" as const, title: `Skip running ones (delete ${items.length - running})` }]
            : []),
        ]
      : [{ value: "delete", title: single ? "Delete" : `Delete ${items.length}` }]
    const answer = await ask({ title: question.title, lines: question.lines, options, sync: preview.sync })
    if (!answer) return undefined
    const busy = new Set(question.running.map((item) => item.id))
    const targets = answer.choice === "skip" ? items.filter((item) => !busy.has(item.id)) : items
    if (targets.length > 1) {
      // Permanent and many at once: the number is typed back, as Delete archived and Forget all.
      const typed = await DialogPrompt.show(dialog, `Type ${targets.length} to delete ${targets.length} sessions`, {
        placeholder: `type ${targets.length} to confirm`,
      })
      if (typed?.trim() !== String(targets.length)) {
        if (typed !== null) toast.show({ variant: "warning", message: "Nothing was deleted: the count didn't match." })
        return undefined
      }
    }
    const result = await sdk.client.experimental.sessionBulk
      .delete(
        {
          sessionIDs: targets.map((item) => item.id),
          archivedOnly: false,
          stop: answer.choice === "stop",
          keepCloud: answer.keepCloud,
          origin: single ? "single" : "bulk",
        },
        { throwOnError: true },
      )
      .then((response) => response.data)
      .catch((cause) => {
        toast.show({ variant: "error", message: errorMessage(cause) })
        return undefined
      })
    if (!result) return undefined
    toast.show({ variant: result.skipped.length ? "warning" : "success", message: deleteSummary(result) })
    return result
  }
}
