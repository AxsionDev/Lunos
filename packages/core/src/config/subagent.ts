export * as ConfigSubagent from "./subagent"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

/**
 * How subagents run and choose their model (XCOD-82, XCOD-287). Declared in both the v1 and v2 config schemas, so
 * the live config path keeps it (the XCOD-68 / XCOD-93 lesson).
 */
export const Info = Schema.Struct({
  background: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Allow subagents to run in the background while the main agent keeps working (on by default; false turns it off). OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS still turns it on",
  }),
  delegate: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Have the Build agent split development work across subagents running in parallel (on by default; false leaves delegation to the model)",
  }),
  max_parallel: PositiveInt.pipe(Schema.optional).annotate({
    description: "At most this many subagents run at once per session; more wait their turn (default 3)",
  }),
  fun_names: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      'Give subagents funny names in the TUI, such as "Turbo Pickle" (on by default; false shows "Subagent 1")',
  }),
  mascots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Show each subagent's pixel-art animal in the TUI sidebar (on by default)",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Default model for every subagent without its own agent.<name>.model: "inherit" (the main agent\'s model, the default), "small" (small_model) or "provider/model"',
  }),
  variant: Schema.String.pipe(Schema.optional).annotate({
    description: 'Reasoning variant for subagents whose model is overridden: "inherit" or a variant name',
  }),
  dynamic: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional).annotate({
      description: "Let the main agent choose a model per task call, from `allow` only",
    }),
    allow: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
      description: 'Models the main agent may choose per task call ("provider/model")',
    }),
  })
    .pipe(Schema.optional)
    .annotate({ description: "Per-task model selection by the main agent" }),
}).annotate({ identifier: "SubagentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
