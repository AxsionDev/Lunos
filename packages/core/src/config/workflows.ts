export * as ConfigWorkflows from "./workflows"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

/**
 * Dynamic workflows (XCOD-303). Declared in both the v1 and v2 config schemas, so the live config
 * path keeps it.
 */
export const Info = Schema.Struct({
  dynamic: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      'The main agent of every working session (Build, Dev-Cycle, Research, custom primary agents; not Plan) plans the work and dispatches subagents to do it; it keeps only todo, question, task and a few read tools (on by default; false has the main agent do the work itself, with subagents encouraged by subagent.delegate). /workflows on|off switches it for one session; an agent opts out with "dynamic": false',
  }),
  main_reads: NonNegativeInt.pipe(Schema.optional).annotate({
    description:
      "With Dynamic workflows on, how many read, glob, grep, list, lsp and resource reads the main agent makes per turn before they refuse and it dispatches an explore subagent (default 5)",
  }),
}).annotate({ identifier: "WorkflowsConfig" })
export type Info = Schema.Schema.Type<typeof Info>
