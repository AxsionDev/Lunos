export * as CloudContract from "./contract"

import { Schema } from "effect"

/**
 * XCOD-186: the Lunos Cloud worker API, version 1: what `lunos run --cloud` and the `lunos-cloud`
 * workspace adapter send, and what they expect back. The control plane that implements it is
 * commercial and lives elsewhere (open-core policy: commercial code uses the harness only through
 * public interfaces, and those interfaces are MIT, here). Spec: docs/cloud-workers.md.
 *
 * Every request carries `Authorization: Bearer <access token from lunos login>`.
 *
 *   GET    /v1                → Service   (asked before any code leaves the machine)
 *   PUT    /v1/workers/{id}   → Worker    (idempotent; the client picks the id)
 *   GET    /v1/workers/{id}   → Worker
 *   DELETE /v1/workers/{id}   → Finished  (the results branch is pushed before this answers)
 *
 * Errors are `{ "error": { "code", "message" } }` with the status below; the message is shown to
 * the user as is.
 */
export const VERSION = 1

export const ID = Schema.String.check(Schema.isPattern(/^[a-z0-9]{8,32}$/))

/** Where the control plane runs workers. Checked against the residency policy before dispatch. */
export const Service = Schema.Struct({
  api: Schema.Number,
  region: Schema.Literals(["eu", "us", "other"]),
  name: Schema.optional(Schema.String),
})
export type Service = Schema.Schema.Type<typeof Service>

export const CreateWorker = Schema.Struct({
  repo: Schema.Struct({
    /** The remote the worker clones, with the user's own token held by the control plane (AC4). */
    url: Schema.String,
    /** The commit to start from. It must already be on the remote. */
    commit: Schema.String,
    /** The branch the user is on, for the results branch's description. */
    branch: Schema.optional(Schema.String),
  }),
  size: Schema.Literals(["standard", "large"]),
  /**
   * The residency policy as resolved on the user's machine, managed and locked settings included,
   * so the worker enforces the same one (AC7). Null when no policy is set.
   */
  residency: Schema.NullOr(
    Schema.Struct({ allow: Schema.Array(Schema.String), enforce: Schema.optional(Schema.Boolean) }),
  ),
  /**
   * Only what the user named for this run (`--cloud-secret NAME`). Never the stored provider keys
   * from `lunos auth`: those don't leave the machine unless the user names them.
   */
  secrets: Schema.Record(Schema.String, Schema.String),
  client: Schema.Struct({ version: Schema.String }),
})
export type CreateWorker = Schema.Schema.Type<typeof CreateWorker>

export const Status = Schema.Literals(["starting", "running", "stopped", "failed", "destroyed"])

export const Worker = Schema.Struct({
  id: ID,
  status: Status,
  region: Schema.Literals(["eu", "us", "other"]),
  /** The worker's Lunos server, once running. */
  url: Schema.optional(Schema.String),
  auth: Schema.optional(Schema.Struct({ username: Schema.String, password: Schema.String })),
  /** The project directory on the worker. */
  directory: Schema.optional(Schema.String),
  /** Where the results go: always `lunos/cloud/<id>`, never a default branch. */
  branch: Schema.String,
  /** Agent-seconds metered so far: active time only; idle and waiting-for-approval excluded (AC5). */
  activeSeconds: Schema.Number,
})
export type Worker = Schema.Schema.Type<typeof Worker>

export const Finished = Schema.Struct({
  id: ID,
  status: Schema.Literal("destroyed"),
  branch: Schema.String,
  /** False when the run changed nothing, so there's no branch to fetch. */
  pushed: Schema.Boolean,
  commit: Schema.optional(Schema.String),
  activeSeconds: Schema.Number,
})
export type Finished = Schema.Schema.Type<typeof Finished>

export const ErrorBody = Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) })

/** HTTP status → error code, as the control plane must send them. */
export const ERRORS = {
  401: "unauthenticated",
  402: "spending_cap",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "concurrency_limit",
} as const

export const branch = (id: string) => `lunos/cloud/${id}`
