// Generic over row type on purpose: `lunos plugin add <name>` needs exactly this and does not
// exist yet (see docs/marketplace-integration.md). Writing an MCP-only resolver would mean
// writing it twice and watching the two drift on ambiguity handling.
export function resolveByName<T extends { name: string; marketplace: string }>(
  entries: readonly T[],
  name: string,
): T[] {
  const slash = name.indexOf("/")
  if (slash > 0) {
    const marketplace = name.slice(0, slash)
    const bare = name.slice(slash + 1)
    return entries.filter((entry) => entry.marketplace === marketplace && entry.name === bare)
  }
  return entries.filter((entry) => entry.name === name)
}
