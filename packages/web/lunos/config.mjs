// XCOD-124: Lunos's values for the upstream config.mjs keys that docs pages read.
import upstream from "../config.mjs"

export default {
  ...upstream,
  url: "https://docs.lunos.tech",
  github: "https://github.com/AxsionDev/Lunos",
  email: "security@lunos.tech",
  // No Lunos community channel yet (XCOD-125); pages that link here point at GitHub issues.
  discord: "https://github.com/AxsionDev/Lunos/issues",
  console: "https://github.com/AxsionDev/Lunos#installation",
}
