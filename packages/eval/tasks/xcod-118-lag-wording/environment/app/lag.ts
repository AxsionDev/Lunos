export type Lag = { commits: number; days: number }

export function describeLag(value: Lag) {
  if (value.commits === 0) return "up to date with upstream"
  return `${value.days} days behind upstream (${value.commits} commits)`
}

/** shields.io endpoint JSON for the README badge. */
export function badge(value: Lag) {
  const color = value.days <= 7 ? "brightgreen" : value.days <= 14 ? "yellow" : "red"
  const message = value.commits === 0 ? "up to date" : `${value.days} days (${value.commits} commits)`
  return { schemaVersion: 1, label: "behind upstream", message, color }
}
