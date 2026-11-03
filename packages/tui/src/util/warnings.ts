import { RunLog } from "@opencode-ai/core/observability/run-log"

type Listener = (...args: any[]) => void

/**
 * XCOD-341: while the TUI owns the screen, a process warning (MaxListenersExceededWarning, a
 * deprecation …) written to stderr lands on top of it and stays there. Bun and Node print warnings
 * from a "warning" listener of their own; this takes its place and writes them to the run log
 * (/logs) instead. The returned function puts the original listeners back, for after the TUI.
 */
export function routeWarnings(note: (title: string, lines: string[]) => void = RunLog.note) {
  const original = process.listeners("warning") as Listener[]
  for (const listener of original) process.off("warning", listener)
  const route = (warning: Error) => {
    const code = (warning as Error & { code?: string }).code
    note(`warning: ${warning.name}${code ? ` (${code})` : ""}`, [
      warning.message,
      ...(warning.stack?.split("\n").slice(1, 6) ?? []),
    ])
  }
  process.on("warning", route)
  return () => {
    process.off("warning", route)
    for (const listener of original)
      if (!process.listeners("warning").includes(listener)) process.on("warning", listener)
  }
}
