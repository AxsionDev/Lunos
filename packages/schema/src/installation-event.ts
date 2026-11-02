export * as InstallationEvent from "./installation-event"

import { Schema } from "effect"
import { Event } from "./event"

export const Updated = Event.define({
  type: "installation.updated",
  schema: {
    version: Schema.String,
  },
})

export const UpdateAvailable = Event.define({
  type: "installation.update-available",
  schema: {
    version: Schema.String,
  },
})

// XCOD-247: the step an update started from the TUI or desktop is on, so they can show it while the
// install runs. `version` is empty while the latest version is still being looked up.
export const UpgradeProgress = Event.define({
  type: "installation.upgrade-progress",
  schema: {
    step: Schema.Literals(["checking", "installing", "verifying"]),
    version: Schema.String,
  },
})

export const Definitions = Event.inventory(Updated, UpdateAvailable, UpgradeProgress)
