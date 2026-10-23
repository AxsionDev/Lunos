// XCOD-303: the footer's "Dynamic workflows: on/off". The same order as the server's
// `DynamicWorkflows.setting` (session/workflows.ts): an organisation lock, then `/workflows on|off`
// in this session (session metadata), then `workflows.dynamic` in config, then on.

const MODES = ["build", "dev-cycle"]

function locked(list: readonly string[] | undefined) {
  return !!list?.some((entry) => entry === "workflows" || entry === "workflows.dynamic")
}

/** "Dynamic workflows: on", with 🔒 when the organisation holds it; undefined outside Build and Dev-Cycle. */
export function workflowsLabel(input: {
  agent: string | undefined
  config: { $locked?: readonly string[]; workflows?: { dynamic?: boolean } }
  metadata: Record<string, unknown> | undefined
  child?: boolean
}) {
  if (input.child || !input.agent || !MODES.includes(input.agent)) return
  const configured = input.config.workflows?.dynamic
  const session = (input.metadata?.workflows as { dynamic?: unknown } | undefined)?.dynamic
  const lock = locked(input.config.$locked)
  const on = lock ? (configured ?? true) : typeof session === "boolean" ? session : (configured ?? true)
  return `Dynamic workflows: ${on ? "on" : "off"}${lock ? " 🔒" : ""}`
}
