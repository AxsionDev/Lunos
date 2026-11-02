import { AuditLog } from "@/audit/log"
import { SandboxConfig } from "./config"

// XCOD-157: the last line of sandbox.required. The CLI already refuses to start a server on the host
// (and sandboxes `lunos` / `lunos run` instead), but other ways in exist — the desktop app, an
// integration calling a server some other way — so every tool call a session resolves outside a
// sandbox is refused here too, with the reason, whatever surface started it.

type Executable = { execute?: (...args: never[]) => unknown }

/** Replace every tool's execute with a refusal, when sandbox.required holds and this isn't a sandbox. */
export function guard(
  tools: Record<string, Executable>,
  config: { required?: boolean } | undefined,
  session: string,
  isInside = SandboxConfig.inside(),
) {
  const message = SandboxConfig.refusal({ required: config?.required === true }, "agent tools", isInside)
  if (!message) return false
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) continue
    tool.execute = async () => {
      AuditLog.emit("sandbox.refused", { what: "tool", tool: name, session, reason: "sandbox.required" })
      throw new Error(message)
    }
  }
  return true
}

export * as SandboxGuard from "./guard"
