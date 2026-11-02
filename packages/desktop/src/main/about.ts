import type { AboutPanelOptionsOptions } from "electron"

/** The About box (XCOD-123): the Lunos version, and the upstream opencode release it's based on (XCOD-90). */
export function aboutPanel(version: string, upstream: string | undefined): AboutPanelOptionsOptions {
  return {
    applicationName: "Lunos",
    applicationVersion: version,
    version: upstream ? `based on opencode ${upstream}` : "",
    copyright: "ITService EOOD (Axsion). MIT licence. Lunos is a fork of opencode.",
    website: "https://lunos.tech",
    credits: "https://github.com/AxsionDev/Lunos",
  }
}
