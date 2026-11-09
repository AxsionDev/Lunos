import { describe, expect, test } from "bun:test"
import { createRenderEffect, createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { Keyed } from "../src/utils/keyed"

type Row = { id: string; label: string }

function mount(initial: Row[]) {
  const [rows, setRows] = createSignal(initial)
  const root = document.createElement("div")
  let made = 0
  const dispose = render(
    () =>
      createComponent(Keyed<Row>, {
        get each() {
          return rows()
        },
        by: (row: Row) => row.id,
        children: (row: () => Row) => {
          made++
          const span = document.createElement("span")
          span.dataset.id = row().id
          // What a row's JSX does: its text follows the row's current value.
          createRenderEffect(() => (span.textContent = row().label))
          return span
        },
      }),
    root,
  )
  const node = (id: string) => root.querySelector<HTMLElement>(`[data-id="${id}"]`)
  return { root, setRows, node, made: () => made, dispose }
}

describe("Keyed", () => {
  test("a rebuilt list with the same keys keeps every element; each row reads its current value", () => {
    const view = mount([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ])
    const a = view.node("a")
    const b = view.node("b")
    // New wrapper objects, as a reload builds them: a plain <For> would replace both elements.
    view.setRows([
      { id: "a", label: "Alpha renamed" },
      { id: "b", label: "Beta" },
    ])
    expect(view.node("a")).toBe(a)
    expect(view.node("b")).toBe(b)
    expect(view.node("a")?.textContent).toBe("Alpha renamed")
    expect(view.made()).toBe(2)
    view.dispose()
  })

  test("keys that come and go add and remove only their own elements, in the list's order", () => {
    const view = mount([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ])
    const a = view.node("a")
    view.setRows([
      { id: "c", label: "Gamma" },
      { id: "a", label: "Alpha" },
    ])
    expect(view.node("b")).toBeNull()
    expect(view.node("a")).toBe(a)
    expect([...view.root.children].map((el) => (el as HTMLElement).dataset.id)).toEqual(["c", "a"])
    expect(view.made()).toBe(3)
    view.dispose()
  })
})
