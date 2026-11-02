import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { AuditLog } from "@/audit/log"
import { InstanceRef } from "@/effect/instance-ref"
import { SecurityReview } from "@/security/review"
import { SecurityRules } from "@/security/rules"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"

/**
 * XCOD-334: the security review, headless, for CI and pre-commit hooks. Exit codes: 0 when nothing
 * at or above `--fail-on` (High) is left unsuppressed, 1 when something is, 2 when the review
 * couldn't run (not a git repository, `gh` missing for `--pr`), so CI can tell "vulnerable" from
 * "broken".
 */
export const SecurityReviewCommand = effectCmd({
  command: "security-review",
  describe: "review changes for secrets, injection, auth, crypto, config and vulnerable dependencies",
  builder: (yargs) =>
    yargs
      .option("branch", { type: "string", describe: "review this branch against its merge base" })
      .option("base", {
        type: "string",
        describe: "with --branch: the branch it merges into (default: the remote's default)",
      })
      .option("pr", { type: "string", describe: "review this pull request (needs gh)" })
      .option("sarif", { type: "string", describe: "also write SARIF 2.1.0 to this file" })
      .option("format", { choices: ["text", "json"] as const, default: "text" as const })
      .option("osv", {
        type: "boolean",
        default: true,
        describe: "look changed dependencies up in OSV (--no-osv to skip)",
      })
      .option("fail-on", { choices: SecurityRules.SEVERITIES, default: "high" as const }),
  handler: Effect.fn("Cli.securityReview")(function* (args) {
    const ctx = yield* InstanceRef
    const cwd = ctx?.directory ?? process.cwd()
    const spec = args.pr
      ? { kind: "pr" as const, number: String(args.pr) }
      : args.branch
        ? { kind: "branch" as const, name: args.branch, base: args.base }
        : { kind: "uncommitted" as const }
    const report = yield* Effect.tryPromise(() => SecurityReview.run({ cwd, spec, osv: args.osv })).pipe(
      Effect.catch((error) =>
        fail(
          `security review could not run: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
          2,
        ),
      ),
    )
    yield* Effect.promise(() => AuditLog.flush())
    if (args.sarif)
      yield* Effect.promise(() =>
        Bun.write(path.resolve(cwd, args.sarif!), JSON.stringify(SecurityReview.sarif(report), null, 2) + EOL),
      )
    yield* writeStdoutEffect(
      args.format === "json"
        ? JSON.stringify({ ...report, blocking: SecurityReview.blocking(report, args.failOn).length }, null, 2) + EOL
        : SecurityReview.markdown(report),
    )
    const blocking = SecurityReview.blocking(report, args.failOn)
    if (blocking.length)
      return yield* fail(
        `${blocking.length} finding(s) at or above ${args.failOn}: fix them or suppress with "// ${SecurityReview.MARKER} <reason>"`,
        1,
      )
  }),
})
