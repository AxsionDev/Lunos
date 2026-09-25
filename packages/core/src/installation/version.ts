declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const LUNOS_UPSTREAM_VERSION: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
/** The upstream opencode release this build was last synced from, or undefined in dev builds. */
export const InstallationUpstreamVersion =
  typeof LUNOS_UPSTREAM_VERSION === "string" && LUNOS_UPSTREAM_VERSION ? LUNOS_UPSTREAM_VERSION : undefined

/** The one user-facing version label: "Lunos v1.18.38", or "Lunos dev (local build)". */
export function versionLabel(version = InstallationVersion) {
  return version === "local" ? "Lunos dev (local build)" : `Lunos v${version}`
}

/**
 * npm 12 skips install scripts unless they're allowed, and `lunos-ai`'s postinstall fetches the
 * binary. Without this flag the package installs but `lunos` won't start. npm 10 accepts it too.
 */
export const NPM_ALLOW_SCRIPTS = "--allow-scripts=lunos-ai"

/** The copy-paste command for installing by hand: "npm i -g lunos-ai@1.2.3 --allow-scripts=lunos-ai". */
export function manualInstallCommand(target?: string) {
  return `npm i -g lunos-ai${target ? `@${target}` : ""} ${NPM_ALLOW_SCRIPTS}`
}

/** `versionLabel()` plus the upstream base when known, for bug reports and debug surfaces. */
export function versionDetail(version = InstallationVersion, upstream = InstallationUpstreamVersion) {
  return upstream ? `${versionLabel(version)} · based on opencode ${upstream}` : versionLabel(version)
}
