import { createComponent, createMemo, For, type Accessor, type JSX } from "solid-js"

/**
 * `<For>` keyed by a string instead of by object identity. A list rebuilt from a reload has new
 * objects for the same rows; `<For>` would throw away every row's DOM (and with it focus, an open
 * text field, a click in flight). Here a row lives as long as its key, and `children` gets an
 * accessor that always reads the row's current value.
 */
export function Keyed<T>(props: {
  each: readonly T[]
  by: (item: T) => string
  children: (item: Accessor<T>) => JSX.Element
}): JSX.Element {
  const byKey = createMemo(() => new Map(props.each.map((item) => [props.by(item), item])))
  const keys = createMemo(() => props.each.map(props.by))
  return createComponent(For<string[], JSX.Element>, {
    get each() {
      return keys()
    },
    children: (key: string) => {
      // A removed key's row may read once more before <For> disposes it: keep its last value.
      let last = byKey().get(key) as T
      const item = () => {
        const value = byKey().get(key)
        if (byKey().has(key)) last = value as T
        return last
      }
      return props.children(item)
    },
  })
}
