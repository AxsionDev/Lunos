import { createContext, For, useContext, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "./border"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "./dialog"
import { DialogLog } from "../component/dialog-logs"
export type ToastOptions = {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration: number
  /** XCOD-280: a background failure: the toast offers "Open log", which shows this run's log. */
  log?: boolean
  /**
   * XCOD-281: stays until closed (`duration` is ignored). Another toast shows over it for its own
   * duration, and then it's back.
   */
  sticky?: boolean
  /** XCOD-281: buttons under the message; choosing one closes the toast. */
  actions?: { label: string; onSelect: () => void }[]
}
type ToastInput = Omit<ToastOptions, "duration"> & { duration?: number }

export function Toast() {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()

  return (
    <Show when={toast.currentToast}>
      {(current) => (
        <box
          position="absolute"
          justifyContent="center"
          alignItems="flex-start"
          top={2}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundPanel}
          borderColor={theme[current().variant]}
          border={["left", "right"]}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <Show when={current().title}>
            <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
              {current().title}
            </text>
          </Show>
          <text fg={theme.text} wrapMode="word" width="100%">
            {current().message}
          </text>
          <Show when={current().log}>
            <text
              marginTop={1}
              fg={theme.primary}
              attributes={TextAttributes.UNDERLINE}
              onMouseUp={() => {
                toast.dismiss()
                dialog.replace(() => <DialogLog />)
              }}
            >
              Open log (/logs)
            </text>
          </Show>
          <Show when={current().actions?.length}>
            <box flexDirection="row" gap={2} marginTop={1}>
              <For each={current().actions}>
                {(action) => (
                  <text
                    fg={theme.primary}
                    attributes={TextAttributes.BOLD}
                    onMouseUp={() => {
                      toast.dismiss()
                      action.onSelect()
                    }}
                  >
                    [{action.label}]
                  </text>
                )}
              </For>
              <Show when={current().sticky}>
                <text fg={theme.textMuted} onMouseUp={() => toast.dismiss()}>
                  [×]
                </text>
              </Show>
            </box>
          </Show>
        </box>
      )}
    </Show>
  )
}

function init() {
  const [store, setStore] = createStore({
    currentToast: null as ToastOptions | null,
  })

  let timeoutHandle: NodeJS.Timeout | null = null
  // XCOD-281: the sticky toast, shown again once a passing one has gone.
  let pinned: ToastOptions | null = null
  let showingPinned = false

  const toast = {
    show(options: ToastInput) {
      const toastOptions = { ...options, duration: options.duration ?? 5000 }
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = null
      setStore("currentToast", toastOptions)
      showingPinned = !!toastOptions.sticky
      if (toastOptions.sticky) {
        pinned = toastOptions
        return
      }
      timeoutHandle = setTimeout(() => {
        showingPinned = !!pinned
        setStore("currentToast", pinned)
      }, toastOptions.duration).unref()
    },
    error: (err: any) => {
      if (err instanceof Error)
        return toast.show({
          variant: "error",
          message: err.message,
        })
      toast.show({
        variant: "error",
        message: "An unknown error has occurred",
      })
    },
    /** Closes the toast showing; a sticky one under it comes back. Closing the sticky one closes it for good. */
    dismiss() {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = null
      if (showingPinned) pinned = null
      showingPinned = !!pinned
      setStore("currentToast", pinned)
    },
    get currentToast(): ToastOptions | null {
      return store.currentToast
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
