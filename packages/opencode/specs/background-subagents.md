# Background subagents: defaults, lifecycle and parity (XCOD-82)

## On or off

**Opt-in, through a documented config key:**

```json
{ "subagent": { "background": true } }
```

`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` still works, as an alias.

**Why not on by default:** upstream ships this as experimental. Its follow-up fixes after the feature landed (#27084, 2026-05-14) were all prompt-quality problems: the model polling, sleeping, or asking the task for status while waiting (#29179, #30790, #31162). Those fixes are in Lunos. Whether a given model behaves well is still a per-deployment call, so it's an explicit opt-in. The model only sees the `background` parameter when it's enabled.

## Watching and cancelling

- **TUI:** `/tasks` (alias `/background`, or "Background subagents" in the command palette). Each job shows its title, agent, resolved model, status and elapsed time, updated every second. Enter opens the job's child session; `ctrl+d` cancels a running job.
- **Server:** `GET /experimental/background?sessionID=…` returns the same list, for the app and ACP. `POST /experimental/background/{jobID}/cancel` cancels a job.

## Lifecycle

| Event                                        | What happens to running background jobs                                                                                                                                                                                                                                           | Where / tested by                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent session **aborted**                   | **Cancelled**, recursively: the job, the child's own jobs, and theirs.                                                                                                                                                                                                            | `session/run-state.ts` `cancelBackgroundJobs`; `task.test.ts` "cancelling the parent run cancels running background tasks", "…recursively cancels descendant background tasks"          |
| Parent session **deleted**                   | **Cancelled.** Deleting the child session cancels its job too.                                                                                                                                                                                                                    | `session/session.ts` `cancelBackgroundJobs` on remove; `task.test.ts` "removing the parent session cancels…", "removing the child task session cancels…"                                |
| Parent session **compacted**                 | **Unaffected.** Compaction doesn't touch jobs. When the job finishes, its result arrives in the parent as a new message after the compaction, so it is never summarised away.                                                                                                     | `session/compaction.ts` has no job references; result injection: `task.test.ts` "background tasks complete through the background job service"                                          |
| **Process exits**                            | **Lost, not resumable automatically.** The job registry is process-local by design (`core/src/background-job.ts`), so running work is interrupted and its status is gone. The child session and its transcript so far stay on disk, and the model can continue it with `task_id`. | `core/test/background-job.test.ts` "interrupts live work … after the owning process-local scope closes"; resume: `task.test.ts` "execute resumes an existing task session from task_id" |
| Job **cancelled** from `/tasks` or the route | Same path as aborting the job's own session (`SessionRunState.cancel`), so the job's own descendants stop too.                                                                                                                                                                    | `task.test.ts` "lists a running background task … then cancels it"                                                                                                                      |

## Parity with Claude Code

| Behaviour                       | Claude Code                                 | Lunos                                                                                                                | On purpose?                                                               |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Launching a background subagent | The model can run a task in the background  | Same, through the task tool's `background: true`                                                                     | —                                                                         |
| Result delivery                 | The main agent is notified when it finishes | Same: the result is injected into the parent session as a new message                                                | —                                                                         |
| Seeing running work             | A task list with status                     | `/tasks` with status, elapsed time, agent **and resolved model**, plus a server route                                | Yes: the model column is there because model choice is a residency matter |
| Default                         | Available                                   | **Opt-in** (`subagent.background`)                                                                                   | Yes, see above                                                            |
| Surviving a restart             | Not resumed automatically                   | Not resumed automatically; the child session stays and can be continued with `task_id`                               | —                                                                         |
| Model per subagent              | Per-agent model in the agent file           | Per call (allow-listed), per type, global default, or inherit, all checked against the residency policy before start | Yes                                                                       |
