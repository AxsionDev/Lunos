import { EOL } from "os"
import { Effect } from "effect"
import { CloudBeta } from "@/cloud/beta"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"

// XCOD-318: `lunos cloud redeem <code>`: redeems a Lunos Cloud private beta code for the signed-in
// account. It admits the account to Lunos Cloud, tags its beta cohort and grants the code's plan (if
// any). Expired, used-up and withdrawn codes are refused with Lunos Cloud's reason.

export const CloudRedeemCommand = effectCmd({
  command: "redeem <code>",
  describe: "redeem a Lunos Cloud beta code for your account",
  instance: false,
  builder: (yargs) =>
    yargs.positional("code", {
      type: "string",
      demandOption: true,
      describe: "the beta code you were sent, e.g. LUNOS-7K2M-…",
    }),
  handler: Effect.fn("Cli.cloud.redeem")(function* (args) {
    const result = yield* Effect.tryPromise({
      try: () => CloudBeta.redeem(String(args.code)),
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
    yield* writeStdoutEffect(`${CloudBeta.redeemedText(result)}${EOL}`)
  }),
})
