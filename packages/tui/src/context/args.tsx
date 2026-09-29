import { createSimpleContext } from "./helper"

export interface Args {
  model?: string
  mode?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
  auto?: boolean
  /** XCOD-128: open straight on the settings dialog (`lunos settings`). */
  settings?: "settings" | "status"
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
