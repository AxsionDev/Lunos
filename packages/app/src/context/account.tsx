import { makeEventListener } from "@solid-primitives/event-listener"
import { createContext, createEffect, createSignal, on, useContext, type ParentProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { parseAccount, SUPPORT_EMAIL, type Disabled } from "@/utils/account-disabled"
import { createSdkForServer } from "@/utils/server"
import { showToast } from "@/utils/toast"

/**
 * XCOD-312: whether the active server's machine was told the Lunos account is disabled. Asked when
 * the app starts, when the server changes, when the window comes back into focus, and after a send
 * is refused. Only the server's local record is read (`GET /global/account`): no Lunos Cloud call. A
 * server without the route (older, or a v2 sidecar) answers "not disabled". While disabled the
 * notice covers the app until it's left for read-only use; a send brings it back, and the session
 * loop refuses the prompt on the server side too.
 */
function createAccount() {
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const [disabled, setDisabled] = createSignal<Disabled>()
  const [notice, setNotice] = createSignal(false)
  let asked = 0

  const refresh = async () => {
    const http = server.current?.http
    if (!http) return setDisabled(undefined)
    const ask = ++asked
    const found = await createSdkForServer({ server: http, fetch: platform.fetch ?? globalThis.fetch })
      .global.account.get()
      .then((result) => (result.error ? undefined : parseAccount(result.data)))
      .catch(() => undefined)
    // A server switch while this was in flight: its answer is the one that counts.
    if (ask !== asked) return
    const was = disabled()
    setDisabled(found)
    if (!found) return setNotice(false)
    if (!was) setNotice(true)
  }

  createEffect(
    on(
      () => server.key,
      () => void refresh(),
    ),
  )
  makeEventListener(window, "focus", () => void refresh())

  return {
    disabled,
    /** Whether the full-screen notice stands in front of the app. */
    notice,
    refresh,
    /** Leaves the notice for the app, read-only: past sessions, no new prompts. */
    viewReadOnly: () => setNotice(false),
    /**
     * Before a prompt, a command or a shell command goes out: false (with a toast, the draft kept)
     * while the account is disabled. A refused one asks again, so the notice shows the newest state.
     */
    allowSend() {
      if (!disabled()) return true
      showToast({
        title: language.t("account.disabled.title"),
        description: `${language.t("account.disabled.readOnly")} ${language.t("account.disabled.contact", { email: SUPPORT_EMAIL })}`,
      })
      void refresh()
      return false
    },
  }
}

export type AccountContext = ReturnType<typeof createAccount>

const Context = createContext<AccountContext>()

export function AccountProvider(props: ParentProps) {
  return <Context.Provider value={createAccount()}>{props.children}</Context.Provider>
}

/** Undefined outside the provider (the Sessions window's tests, storybook): nothing is blocked there. */
export function useAccount() {
  return useContext(Context)
}
