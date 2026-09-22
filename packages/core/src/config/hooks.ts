export * as ConfigHooks from "./hooks"

import { Schema } from "effect"

/**
 * Config-driven lifecycle hooks: shell commands keyed to events Lunos already
 * dispatches, so a user can run a linter after an edit without writing a plugin.
 *
 * These are executed by the built-in `config-hooks` plugin, which registers against
 * the existing `Plugin.trigger` dispatch rather than introducing a second hook path.
 */

export const DEFAULT_TIMEOUT = 30_000

/**
 * Events a hook can bind to. Deliberately limited to what Lunos actually
 * dispatches today — see `docs/hooks.md` for the mapping to Claude Code's larger
 * event surface and why the rest have no Lunos equivalent.
 */
export const Event = Schema.Literals([
  "tool.execute.before",
  "tool.execute.after",
  "command.execute.before",
  "session.created",
  "session.idle",
  "session.compacted",
  "session.deleted",
  "session.error",
])
export type Event = typeof Event.Type

export class Matcher extends Schema.Class<Matcher>("ConfigV2.Hooks.Matcher")({
  tool: Schema.String.pipe(Schema.optional).annotate({
    description: "Glob matched against the tool name, e.g. `edit` or `bash`. Omit to match every tool.",
  }),
  file: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Glob matched against the file path a tool touched, e.g. `**/*.ts`. Only meaningful for tools that act on a file.",
  }),
}) {}

export class Entry extends Schema.Class<Entry>("ConfigV2.Hooks.Entry")({
  command: Schema.String.pipe(Schema.Array).annotate({
    description:
      "Command and arguments to run, as an array — not passed through a shell, so no quoting or injection concerns.",
  }),
  matcher: Matcher.pipe(Schema.optional).annotate({
    description: "Restricts which events fire this hook. Omit to fire on every occurrence of the event.",
  }),
  environment: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional).annotate({
    description: "Extra environment variables for the command, on top of the inherited environment.",
  }),
  timeout: Schema.Number.pipe(Schema.optional).annotate({
    description: `Milliseconds before the command is killed. Defaults to ${DEFAULT_TIMEOUT}.`,
  }),
  disabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Set true to keep the hook configured but inactive.",
  }),
}) {}

export const Info = Schema.Record(Event, Schema.Array(Entry))
export type Info = typeof Info.Type
