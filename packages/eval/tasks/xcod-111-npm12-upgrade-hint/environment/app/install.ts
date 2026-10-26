/** The copy-paste command for upgrading Lunos by hand, shown in the TUI's "upgrade manually" hint. */
export function manualInstallCommand(target?: string) {
  return `npm i -g lunos-ai${target ? `@${target}` : ""}`
}
