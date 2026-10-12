export * as SessionGroupEvent from "./session-group-event"

import { Event } from "./event"

/**
 * XCOD-205: the session groups on this machine changed (created, renamed, recoloured, collapsed,
 * deleted, or a session moved). Carries nothing: the Sessions window re-reads the overview.
 */
export const Updated = Event.define({
  type: "session.group.updated",
  schema: {},
})

export const Definitions = Event.inventory(Updated)
