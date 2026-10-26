export * as ConfigAuth from "./auth"

import { Schema } from "effect"

/**
 * XCOD-273: whether starting the TUI needs a Lunos account. The official distribution (npm
 * `lunos-ai`, the installers) is built with sign-in required; a build from source isn't. Only read
 * from managed config, so a repository can't switch it off for everyone who opens it. Declared in
 * both config schemas; `"$locked": ["auth"]` is accepted too.
 */
export const Info = Schema.Struct({
  required: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Whether the TUI asks you to sign in to a free Lunos account before the first session (default true in the official build, false in a build from source). Only read from managed config; false skips the sign-in screen and makes no Lunos account call",
  }),
}).annotate({ identifier: "AuthConfig" })
export type Info = Schema.Schema.Type<typeof Info>
