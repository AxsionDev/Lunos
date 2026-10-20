import { createContext, createEffect, Show, useContext, type ParentProps } from "solid-js"
import { StartupTrace } from "@opencode-ai/core/startup-trace"

export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
  /**
   * XCOD-276: false renders the children at once, without waiting for `ready`, which they read as
   * "the data is loaded". Nothing that only fills in content should hold back the first frame.
   */
  blocking?: boolean
}) {
  const ctx = createContext<T>()

  return {
    context: ctx,
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props) as T & { ready?: boolean }
      // XCOD-276: a provider that waits for something holds back everything under it, the first
      // frame included; the start-up timeline says when each one let go.
      const blocking = input.blocking !== false
      if (blocking && init.ready === false) {
        const end = StartupTrace.begin(`wait for ${input.name.toLowerCase()}`)
        createEffect(() => init.ready && end())
      }
      return (
        <Show when={!blocking || init.ready === undefined || init.ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
