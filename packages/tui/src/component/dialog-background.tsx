import { createResource, createSignal, onCleanup } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"

export function elapsed(ms: number) {
  // The API can send "NaN" for a job that hasn't started: nothing to show then.
  if (!Number.isFinite(ms)) return undefined
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The longest model id a row shows whole; longer ones keep their start and end. */
export const MODEL_WIDTH = 32

/**
 * One job's row. XCOD-161: the model sits in the footer, which never shrinks, beside its status and
 * elapsed time. After the title it was clipped off whenever the title was long.
 */
export function row(job: { agent?: string; model?: string; status: string; elapsedMs: number | string }) {
  return {
    description: job.agent,
    footer: [
      job.model ? Locale.truncateMiddle(job.model, MODEL_WIDTH) : undefined,
      job.status,
      elapsed(Number(job.elapsedMs)),
    ]
      .filter(Boolean)
      .join(" · "),
  }
}

/**
 * Background subagents (XCOD-82): every task job with its status, elapsed time, agent, resolved
 * model and title. Enter opens the job's child session; the cancel action stops a running job.
 */
export function DialogBackground() {
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()
  const { theme } = useTheme()
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 1000)
  onCleanup(() => clearInterval(timer))

  const [jobs, { refetch }] = createResource(tick, async () => {
    const result = await sdk.client.experimental.background.list()
    return result.data ?? []
  })

  const options = () =>
    (jobs() ?? []).map((job) => ({
      title: job.title ?? job.id,
      value: job.id,
      ...row(job),
      bg: job.status === "error" ? theme.error : undefined,
      sessionID: job.sessionID ?? job.id,
    }))

  return (
    <DialogSelect
      title="Background subagents"
      placeholder={jobs()?.length === 0 ? "No subagent jobs yet" : "Search subagent jobs"}
      options={options()}
      onSelect={(option) => {
        const job = options().find((item) => item.value === option.value)
        dialog.clear()
        if (job) route.navigate({ type: "session", sessionID: job.sessionID })
      }}
      actions={[
        {
          command: "background.cancel",
          title: "cancel",
          onTrigger: async (option) => {
            const result = await sdk.client.experimental.background.cancel({ jobID: String(option.value) })
            toast.show({
              message: result.data ? "Background subagent cancelled" : "That job isn't running",
              variant: result.data ? "success" : "info",
            })
            await refetch()
          },
        },
      ]}
    />
  )
}
