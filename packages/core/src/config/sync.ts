export * as ConfigSync from "./sync"

import { Schema } from "effect"

/**
 * Session sync to your Lunos space (lunos-web spec 2026-10-13 §3, C2-C3). On once you're signed in;
 * `false` stops it for this directory. An organisation stops it everywhere with
 * `{"sync": false, "$locked": ["sync"]}` in its policy.
 */
export const Options = Schema.Struct({
  project: Schema.String.pipe(Schema.optional).annotate({
    description: "Lunos space project this directory's sessions sync to (lunos sync link writes it)",
  }),
  exclude: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description:
      "Globs of files whose contents are never uploaded, in addition to .env*, auth.json, *.pem, *.key, id_rsa*",
  }),
}).annotate({ identifier: "SyncOptions" })

export const Info = Schema.Union([Schema.Literal(false), Options]).annotate({ identifier: "SyncConfig" })
export type Info = Schema.Schema.Type<typeof Info>
