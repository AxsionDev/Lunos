// Generic over row type on purpose: `lunos plugin add <name>` needs exactly this and does not
// exist yet (see docs/marketplace-integration.md). Writing an MCP-only resolver would mean
// writing it twice and watching the two drift on ambiguity handling.
export function resolveByName<T extends { name: string; marketplace: string }>(
  entries: readonly T[],
  name: string,
): T[] {
  // Both readings, never just one: npm-scoped plugin names (`@scope/pkg`) contain a slash, so the
  // bare name must match exactly -- but an entry name is a manifest-author string, and letting an
  // exact match win outright would let an entry literally named "lunos-community/context7" in some
  // other marketplace shadow the qualified form. Any overlap goes to the caller's ambiguity error.
  const exact = entries.filter((entry) => entry.name === name)
  const slash = name.indexOf("/")
  if (slash <= 0) return exact
  const marketplace = name.slice(0, slash)
  const bare = name.slice(slash + 1)
  const qualified = entries.filter(
    (entry) => entry.marketplace === marketplace && entry.name === bare && !exact.includes(entry),
  )
  return [...exact, ...qualified]
}
