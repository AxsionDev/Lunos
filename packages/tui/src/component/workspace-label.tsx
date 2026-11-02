import { useTheme } from "../context/theme"
import { statusKind } from "../util/status-glyph"

export type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

export function WorkspaceLabel(props: { type: string; name: string; status?: WorkspaceStatus; icon?: boolean }) {
  const { theme } = useTheme()
  const color = () => {
    if (props.status === "connected") return theme.success
    if (props.status === "error") return theme.error
    return theme.textMuted
  }

  return (
    <>
      {/* XCOD-141: the glyph follows the status too, so it doesn't rely on colour alone. */}
      {props.icon ? <span style={{ fg: color() }}>{workspaceGlyph(props.status)} </span> : undefined}
      <span style={{ fg: theme.text }}>{props.name}</span> <span style={{ fg: theme.textMuted }}>({props.type})</span>
    </>
  )
}

function workspaceGlyph(status: WorkspaceStatus | undefined) {
  const kind = statusKind(status)
  if (kind === "ok") return "●"
  if (kind === "error") return "✕"
  if (kind === "pending") return "…"
  return "○"
}
