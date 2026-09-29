declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const LUNOS_UPSTREAM_VERSION: string
  const LUNOS_UPSTREAM_SYNC: UpstreamSync | null
}

/** Written into packages/opencode/package.json by script/upstream-sync.ts (XCOD-118). */
export type UpstreamSync = { commit: string; measuredAt: string; daysBehind: number; commitsBehind: number }

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
/** The upstream opencode release this build was last synced from, or undefined in dev builds. */
export const InstallationUpstreamVersion =
  typeof LUNOS_UPSTREAM_VERSION === "string" && LUNOS_UPSTREAM_VERSION ? LUNOS_UPSTREAM_VERSION : undefined
/** The last upstream sync this build contains, and how far behind upstream it was then. */
export const InstallationUpstreamSync =
  typeof LUNOS_UPSTREAM_SYNC === "object" && LUNOS_UPSTREAM_SYNC ? LUNOS_UPSTREAM_SYNC : undefined

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

/**
 * XCOD-147: the one "new version" line. `quote` wraps the command for plain CLI output, where it
 * reads as something to copy: `There is a new version: 1.18.43 — please run "lunos update"`.
 */
export function newVersionMessage(version: string, quote = false) {
  return `There is a new version: ${version} — please run ${quote ? '"lunos update"' : "lunos update"}`
}

/** Below this many columns the TUI notice uses its short form. */
export const NEW_VERSION_NARROW_WIDTH = 100

/**
 * The TUI's bottom-right notice. The `↑` carries the meaning without the warning colour
 * (XCOD-107/141); the short form keeps the whole version number, never truncating it.
 */
export function newVersionNotice(version: string, width: number) {
  if (width < NEW_VERSION_NARROW_WIDTH) return `↑ New version: ${version} · lunos update`
  return `↑ ${newVersionMessage(version)}`
}

/**
 * What the "Update Complete" alert tells people to do next (XCOD-129): `/restart` relaunches the
 * newly installed version and reopens the session.
 */
export function updateRestartHint(version: string) {
  return `Run /restart to use ${version}.`
}

/** `versionLabel()` plus the upstream base when known, for bug reports and debug surfaces. */
export function versionDetail(version = InstallationVersion, upstream = InstallationUpstreamVersion) {
  return upstream ? `${versionLabel(version)} · based on opencode ${upstream}` : versionLabel(version)
}

/** `lunos --version --verbose`: the version detail plus the upstream lag recorded at the last sync. */
export function versionVerbose(
  version = InstallationVersion,
  upstream = InstallationUpstreamVersion,
  sync = InstallationUpstreamSync,
) {
  if (!sync) return [versionDetail(version, upstream), "upstream lag: not recorded in this build"].join("\n")
  const lag =
    sync.commitsBehind === 0
      ? "up to date with upstream"
      : `${sync.daysBehind} ${sync.daysBehind === 1 ? "day" : "days"} behind upstream (${sync.commitsBehind} commits)`
  return [
    versionDetail(version, upstream),
    `upstream: anomalyco/opencode dev @ ${sync.commit.slice(0, 10)}, ${lag} as of ${sync.measuredAt}`,
  ].join("\n")
}
