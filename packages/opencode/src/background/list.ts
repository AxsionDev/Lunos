import type { BackgroundJob } from "./job"

/** One subagent job as the monitoring surfaces (server route, TUI, app, ACP) show it (XCOD-82). */
export function toItem(job: BackgroundJob.Info, now = Date.now()) {
  const meta = (job.metadata ?? {}) as Record<string, any>
  const model =
    meta.model && typeof meta.model === "object" ? `${meta.model.providerID}/${meta.model.modelID}` : undefined
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    elapsedMs: (job.completed_at ?? now) - job.started_at,
    agent: typeof meta.agent === "string" ? meta.agent : undefined,
    model,
    modelRule: typeof meta.modelRule === "string" ? meta.modelRule : undefined,
    parentSessionID: typeof meta.parentSessionId === "string" ? meta.parentSessionId : undefined,
    sessionID: typeof meta.sessionId === "string" ? meta.sessionId : undefined,
    error: job.error,
  }
}

/** Task jobs only, newest first, optionally only one parent session's. */
export function list(jobs: readonly BackgroundJob.Info[], sessionID?: string, now = Date.now()) {
  return jobs
    .filter((job) => job.type === "task")
    .filter((job) => !sessionID || job.metadata?.parentSessionId === sessionID)
    .toSorted((a, b) => b.started_at - a.started_at)
    .map((job) => toItem(job, now))
}
