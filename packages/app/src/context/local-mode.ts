export function hasCustomMode(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveMode<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
