import { useNavigate } from "@solidjs/router"
import { startTransition } from "solid-js"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { legacySessionHref } from "@/utils/session-route"

/**
 * XCOD-205: opens a session in this window: its project in the sidebar, then the session (a tab in
 * the new layout, the session route in the legacy one). XCOD-235: the main desktop window uses the
 * same, for sessions picked in the Sessions window.
 */
export function useOpenSession() {
  const global = useGlobal()
  const server = useServer()
  const settings = useSettings()
  const tabs = useTabs()
  const navigate = useNavigate()

  return (target: { sessionID: string; directory: string; worktree?: string }) => {
    const conn = server.current
    if (!conn) return
    const current = global.ensureServerCtx(conn)
    const project = target.worktree ?? target.directory
    current.projects.open(project)
    current.projects.touch(project)
    if (!settings.general.newLayoutDesigns()) {
      navigate(legacySessionHref(target.directory, target.sessionID))
      return
    }
    void startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: target.sessionID })
      tabs.select(tab)
    })
  }
}
