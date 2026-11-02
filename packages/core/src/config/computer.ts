export * as ConfigComputer from "./computer"

import { Schema } from "effect"
import { ConfigBrowser } from "./browser"

/**
 * XCOD-339: computer control, where the agent operates desktop apps with screenshots, mouse,
 * keyboard and clipboard. Off by default; a user turns it on in /settings › Permissions › Browser &
 * computer, and an organisation turns it off by locking `computer.enabled` in managed config.
 * Declared in both config schemas.
 *
 * The app rules here are checked by the computer tool itself, before the agent's `computer`
 * permission is asked, so a `"*": "allow"` permission rule can't lift them. Apps are named by their
 * bundle id on macOS (`com.apple.TextEdit`) or executable name on Windows (`notepad.exe`), which an
 * app can't fake the way it can a window title.
 */

/** App categories refused unless an app is named in `computer.allow`. */
export const CATEGORIES = ["banking", "payment", "password_manager", "system_settings", "terminal"] as const
export type Category = (typeof CATEGORIES)[number]

export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Give the qa and general agents the computer tool (off by default): screenshots, mouse, keyboard and clipboard on this computer. Every app asks before the agent acts on it. Lock it to turn computer control off for an organisation",
  }),
  allow: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description:
      'Apps the agent may act on without asking: a macOS bundle id ("com.apple.TextEdit") or a Windows executable ("notepad.exe"). An app named here is allowed even in a denied category',
  }),
  deny: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Apps the agent is never allowed to act on, as bundle ids or executable names. Wins over allow",
  }),
  deny_categories: Schema.Array(Schema.Literals(CATEGORIES)).pipe(Schema.optional).annotate({
    description:
      "App categories refused unless named in allow (default: banking, payment, password_manager, system_settings, terminal)",
  }),
  stop_key: Schema.String.pipe(Schema.optional).annotate({
    description:
      'The key that stops all browser and computer control at once, anywhere on the computer (default "ctrl+alt+escape")',
  }),
  screenshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Keep screenshots in the session history (default false: a screenshot is sent to the model once and never stored)",
  }),
}).annotate({ identifier: "ComputerConfig" })
export type Info = Schema.Schema.Type<typeof Info>

export const DEFAULT_STOP_KEY = ConfigBrowser.DEFAULT_STOP_KEY

export function enabled(config: Info | undefined) {
  return config?.enabled === true
}

export function categories(config: Info | undefined): readonly Category[] {
  return config?.deny_categories ?? CATEGORIES
}
