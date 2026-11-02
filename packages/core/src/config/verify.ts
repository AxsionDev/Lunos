export * as ConfigVerify from "./verify"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

/**
 * How the Build agent checks its work before handing back (XCOD-288). Every key pins what the
 * agent would otherwise find in the project itself (package scripts, *.csproj, Makefile, AGENTS.md).
 * Declared in both the v1 and v2 config schemas, so the live config path keeps it.
 */
export const Info = Schema.Struct({
  build: Schema.String.pipe(Schema.optional).annotate({
    description: 'Command that builds or compiles the project, e.g. "npm run build" or "dotnet build"',
  }),
  test: Schema.String.pipe(Schema.optional).annotate({
    description: 'Command that runs the tests, e.g. "npm test"',
  }),
  start: Schema.String.pipe(Schema.optional).annotate({
    description: 'Command that starts the app, run in the background, e.g. "npm run dev"',
  }),
  ready: Schema.String.pipe(Schema.optional).annotate({
    description: 'Local URL that answers once the app is up, e.g. "http://localhost:4200"',
  }),
  check: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description:
      'Requests to make against the running app and the status they must return, e.g. ["GET /api/health -> 200"]',
  }),
  max_attempts: PositiveInt.pipe(Schema.optional).annotate({
    description:
      "How many times the agent fixes a failed check and verifies again before handing back with the failure (default 3)",
  }),
  timeout: PositiveInt.pipe(Schema.optional).annotate({
    description: "Time budget for verification in minutes, in total (default 10)",
  }),
}).annotate({ identifier: "VerifyConfig" })
export type Info = Schema.Schema.Type<typeof Info>
