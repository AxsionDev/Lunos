import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SecurityReview } from "@/security/review"
import DESCRIPTION from "./security_scan.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  branch: Schema.optional(Schema.String).annotate({
    description: "Scan this branch against its merge base instead of uncommitted changes",
  }),
  base: Schema.optional(Schema.String).annotate({ description: "With branch: the branch it merges into" }),
  pr: Schema.optional(Schema.String).annotate({ description: "Scan this pull request number instead (needs gh)" }),
})

type Metadata = { target: string; findings: number; blocking: number; suppressed: number }

/** XCOD-334: `/security-review`'s re-review after fixes, and a read-only check any agent can run. */
export const SecurityScanTool = Tool.define<typeof Parameters, Metadata, never>(
  "security_scan",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: "security_scan", patterns: ["*"], always: ["*"], metadata: {} })
        const ins = yield* InstanceState.context
        const report = yield* Effect.promise(() =>
          SecurityReview.run({
            cwd: ins.directory,
            spec: params.pr
              ? { kind: "pr", number: params.pr }
              : params.branch
                ? { kind: "branch", name: params.branch, base: params.base }
                : { kind: "uncommitted" },
          }),
        )
        return {
          title: `${report.target}: ${report.findings.length} finding(s)`,
          output: SecurityReview.forModel(report),
          metadata: {
            target: report.target,
            findings: report.findings.length,
            blocking: SecurityReview.blocking(report).length,
            suppressed: report.suppressed.length,
          },
        }
      }),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
