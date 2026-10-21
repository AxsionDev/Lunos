import { createStore, reconcile, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ?? initialRoute(startup.initialRoute) ?? { type: "home" },
    )
    // XCOD-286: the views left behind, newest last, so closing a Claude Code / Codex session returns
    // to the one it was opened from. Only a change of view counts, not a new prompt on the same one.
    const history: Route[] = []

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        if (routeKey(route) !== routeKey(store)) {
          history.push(snapshot(unwrap(store)))
          if (history.length > 50) history.shift()
        }
        setStore(reconcile(route))
      },
      /**
       * XCOD-286: leaves session `sessionID` for the view before it; home when there is none. Every
       * visit to that session is forgotten, so a later close never returns into it, and leaving isn't
       * remembered as a visit.
       */
      leave(sessionID: string) {
        const kept = history.filter((route) => !(route.type === "session" && route.sessionID === sessionID))
        history.splice(0, history.length, ...kept)
        while (history.length && routeKey(history.at(-1)!) === routeKey(store)) history.pop()
        setStore(reconcile(history.pop() ?? { type: "home" }))
      },
    }
  },
})

/** A copy: reconcile changes the store's object in place on the next navigate. */
function snapshot(route: Route): Route {
  try {
    return structuredClone(route)
  } catch {
    return { ...route }
  }
}

function routeKey(route: Route) {
  if (route.type === "session") return `session:${route.sessionID}`
  if (route.type === "plugin") return `plugin:${route.id}`
  return "home"
}

function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return { type: "plugin", id: value.id }
  }
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
