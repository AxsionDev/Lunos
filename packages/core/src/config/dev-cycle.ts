export * as ConfigDevCycle from "./dev-cycle"

import { Schema } from "effect"

/**
 * Dev-Cycle mode (XCOD-302). Declared in both the v1 and v2 config schemas, so the live config path
 * keeps it.
 */
export const Info = Schema.Struct({
  auto_continue: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Continue automatically when a Dev-Cycle turn ends by announcing its next step instead of doing it (on by default; false waits for you to say proceed). Never passes a pending gate, and stops after 3 continuations in a row without progress",
  }),
}).annotate({ identifier: "DevCycleConfig" })
export type Info = Schema.Schema.Type<typeof Info>
