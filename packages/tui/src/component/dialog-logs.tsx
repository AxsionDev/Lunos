import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { readFileSync } from "node:fs"
import { RunLog } from "@opencode-ai/core/observability/run-log"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { getScrollAcceleration } from "../util/scroll"

/** The run logs, as `lunos logs` lists them; choosing one shows it (XCOD-280). */
export function DialogLogs() {
  const dialog = useDialog()
  const current = RunLog.current()?.id
  const options = RunLog.list().map((entry) => ({
    value: entry,
    title: `${entry.id}  ${entry.time.toLocaleString()}  ${entry.id === current ? "this run" : entry.result}`,
    truncateTitle: false,
  }))
  return (
    <DialogSelect
      title="Logs"
      placeholder="Search logs"
      footer={<text>{RunLog.dir()}</text>}
      options={options}
      emptyView={<text>No run logs yet. They are kept in {RunLog.dir()}</text>}
      onSelect={(option) => dialog.replace(() => <DialogLog file={option.value.file} />)}
    />
  )
}

/** The last part of a log and where it is: what "Open log" on a failure shows. */
export function DialogLog(props: { file?: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const term = useTerminalDimensions()
  dialog.setSize("xlarge")
  const file = props.file ?? RunLog.current()?.file
  const text = (() => {
    if (!file) return "This run has no log."
    try {
      const lines = readFileSync(file, "utf8").trimEnd().split("\n")
      return lines.slice(-400).join("\n")
    } catch (error) {
      return `Couldn't read the log: ${error instanceof Error ? error.message : String(error)}`
    }
  })()
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Log
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="char">
        {file ?? RunLog.dir()}
      </text>
      <text fg={theme.textMuted}>To report it: lunos bug-report{file ? ` ${RunLog.idOf(file) ?? ""}` : ""}</text>
      {/* Opens at the end, where a failure is. */}
      <scrollbox
        ref={(element: ScrollBoxRenderable) => setTimeout(() => element.scrollTo(element.scrollHeight), 0)}
        height={Math.max(5, Math.floor(term().height * 0.45))}
        backgroundColor={theme.backgroundElement}
        scrollAcceleration={getScrollAcceleration()}
      >
        <text fg={theme.text} wrapMode="char">
          {text}
        </text>
      </scrollbox>
    </box>
  )
}
