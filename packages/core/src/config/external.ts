export * as ConfigExternal from "./external"

import { Schema } from "effect"

/**
 * XCOD-204: driving Claude Code and Codex CLI from Lunos. Uses the user's own install and login;
 * Lunos never stores, copies or proxies their credentials. Declared in both config schemas.
 * Lock `external` (or `external.enabled`) with `$locked` to turn it off for an organisation.
 */
const Tool = Schema.Struct({
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "The tool's executable, when it isn't on PATH",
  }),
  permission_mode: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Permission mode passed to the tool on every run. Unset means its safe default (every edit and command is approved in Lunos). Unsafe modes (bypassPermissions, danger-full-access) are refused here; pass them per run only",
  }),
})

export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Allow Lunos to start Claude Code and Codex CLI sessions (default true). Lock it to turn it off",
  }),
  claude: Tool.pipe(Schema.optional).annotate({ description: "Claude Code" }),
  codex: Tool.pipe(Schema.optional).annotate({ description: "Codex CLI" }),
}).annotate({ identifier: "ExternalConfig" })
export type Info = Schema.Schema.Type<typeof Info>
