import { createContext, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"
import type { SandboxHost, SandboxState } from "../util/sandbox"

// XCOD-281: the sandbox starting behind the TUI, as the command that started the TUI reports it.
// `queued` is whether the prompt in the box was sent while it was starting (and waits for it).

function init(host: SandboxHost | undefined) {
  const [state, setState] = createSignal<SandboxState | undefined>(host?.state(), { equals: false })
  const unsubscribe = host?.subscribe((next) => setState(next))
  onCleanup(() => unsubscribe?.())
  const initial = host?.state()
  const [queued, setQueued] = createSignal(initial?.status === "off" && !!initial.queued)
  return { host, state, queued, setQueued }
}

export type SandboxContext = ReturnType<typeof init>

const ctx = createContext<SandboxContext>()

export function SandboxProvider(props: ParentProps<{ host?: SandboxHost }>) {
  const value = init(props.host)
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

const none: SandboxContext = {
  host: undefined,
  state: () => undefined,
  queued: () => false,
  setQueued: () => false,
}

export function useSandbox() {
  return useContext(ctx) ?? none
}
