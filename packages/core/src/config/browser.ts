export * as ConfigBrowser from "./browser"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

/**
 * XCOD-327: browser control. Off by default; a user turns it on in /settings › Permissions ›
 * Browser & computer, and an organisation turns it off (or restricts its lists) by locking
 * `browser` or `browser.enabled` in managed config. Declared in both config schemas.
 *
 * The site rules here are checked by the browser tool itself, before the agent's `browser`
 * permission is asked, so a `"*": "allow"` permission rule can't lift them.
 */

/** Site categories refused unless a site is named in `browser.allow`. */
export const CATEGORIES = ["banking", "payment", "password_manager", "system_settings"] as const
export type Category = (typeof CATEGORIES)[number]

export const MODES = ["lunos", "extension"] as const

export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Give the qa and general agents the browser tool (off by default). Every site asks before the agent acts on it. Lock it to turn browser control off for an organisation",
  }),
  mode: Schema.Literals(MODES).pipe(Schema.optional).annotate({
    description:
      'Which browser the agent controls. "lunos" (default): a separate Chrome profile Lunos manages. "extension": your own Chrome, Edge or Brave, through the Lunos extension on 127.0.0.1 only',
  }),
  allow: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description:
      'Sites the agent may act on without asking, as host patterns ("localhost", "*.example.com"). A site named here is allowed even in a denied category',
  }),
  deny: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Sites the agent is never allowed to open or act on, as host patterns. Wins over allow",
  }),
  deny_categories: Schema.Array(Schema.Literals(CATEGORIES)).pipe(Schema.optional).annotate({
    description:
      "Site categories refused unless named in allow (default: banking, payment, password_manager, system_settings)",
  }),
  stop_key: Schema.String.pipe(Schema.optional).annotate({
    description:
      'The key that stops browser control at once: in the controlled browser, and on macOS and Windows from any app while the agent drives the browser (default "ctrl+alt+escape")',
  }),
  headless: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Run the Lunos browser without a window (default false; always headless inside a sandbox)",
  }),
  executable: Schema.String.pipe(Schema.optional).annotate({
    description: "The Chrome, Chromium, Edge or Brave executable for the Lunos browser, when it isn't found",
  }),
  port: PositiveInt.pipe(Schema.optional).annotate({
    description: "The 127.0.0.1 port the Lunos extension connects to (default 47615)",
  }),
  screenshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Keep screenshots in the session history (default false: a screenshot is sent to the model once and never stored)",
  }),
}).annotate({ identifier: "BrowserConfig" })
export type Info = Schema.Schema.Type<typeof Info>

export const DEFAULT_PORT = 47615
export const DEFAULT_STOP_KEY = "ctrl+alt+escape"

export function enabled(config: Info | undefined) {
  return config?.enabled === true
}

export function categories(config: Info | undefined): readonly Category[] {
  return config?.deny_categories ?? CATEGORIES
}
