export * as ConfigLog from "./log"

import { Schema } from "effect"

/**
 * How long Lunos keeps its run logs (one per run, in the log directory). The newest 10 runs are
 * always kept. Read from your global config and the organisation's managed config, which can lock
 * it with `$locked: ["log"]`. Declared in both the v1 and v2 config schemas.
 */
export const Info = Schema.Struct({
  retention_days: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional).annotate({
    description: "Days a failed run's log is kept, beyond the newest 10 runs. Default 14",
  }),
  max_mb: Schema.Number.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: "Most space all run logs together may take, in MB; the oldest are removed first. Default 50",
  }),
}).annotate({ identifier: "LogConfig" })
export type Info = Schema.Schema.Type<typeof Info>
