export * as ConfigWorkflows from "./workflows"

import { Schema } from "effect"

/**
 * Dynamic workflows (XCOD-303). Declared in both the v1 and v2 config schemas, so the live config
 * path keeps it.
 */
export const Info = Schema.Struct({
  dynamic: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Build and Dev-Cycle plan the work and dispatch subagents to do it; the main agent keeps only read, search, todo and question tools (on by default; false has the main agent do the work itself, with subagents encouraged by subagent.delegate). /workflows on|off switches it for one session",
  }),
}).annotate({ identifier: "WorkflowsConfig" })
export type Info = Schema.Schema.Type<typeof Info>
