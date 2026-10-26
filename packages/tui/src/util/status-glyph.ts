// XCOD-141: every status dot in the TUI also changes shape, so a state never relies on colour alone
// (WCAG 1.4.1). Colour-blind users, monochrome terminals and NO_COLOR all still see the difference.
export const STATUS_GLYPH = {
  ok: "•",
  error: "✕",
  attention: "!",
  off: "○",
  pending: "…",
} as const

export type StatusKind = keyof typeof STATUS_GLYPH

// MCP server, LSP server and workspace statuses mapped onto the shared kinds.
export function statusKind(status: string | undefined): StatusKind {
  switch (status) {
    case "connected":
      return "ok"
    case "failed":
    case "error":
    case "needs_client_registration":
      return "error"
    case "needs_auth":
      return "attention"
    case "connecting":
      return "pending"
    default:
      return "off"
  }
}

export function statusGlyph(status: string | undefined) {
  return STATUS_GLYPH[statusKind(status)]
}

// Marks the focused choice in a row of buttons (permission prompt, confirm dialog) with a glyph as
// well as the highlight colour. Same width either way, so the row does not shift.
export function selectionMarker(selected: boolean) {
  return selected ? "›" : " "
}
