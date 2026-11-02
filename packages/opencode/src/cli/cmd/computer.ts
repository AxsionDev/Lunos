import { EOL } from "os"
import { cmd } from "./cmd"

// XCOD-339: `lunos computer setup` walks through the OS permissions computer control needs, and
// `lunos computer status` says what is missing. macOS grants them to the app Lunos runs in, so the
// prompts name that app.

const out = (line = "") => process.stdout.write(line + EOL)

async function load() {
  const { Computer } = await import("@/computer")
  return Computer.get().catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
}

const StatusCommand = cmd({
  command: "status",
  describe: "show whether this computer is ready for computer control",
  handler: async () => {
    const desktop = await load()
    if (typeof desktop === "string") {
      out(desktop)
      process.exitCode = 1
      return
    }
    const missing = await desktop.permissions()
    if (!missing.length) {
      out("Computer control can run here: every permission it needs is granted.")
      out("Turn it on in /settings › Permissions › Browser & computer (computer.enabled).")
      return
    }
    out("Computer control needs:")
    for (const item of missing) out(`- ${item.name}: ${item.how}`)
    out()
    out("Run `lunos computer setup` to open the right settings.")
    process.exitCode = 1
  },
})

const SetupCommand = cmd({
  command: "setup",
  describe: "grant the OS permissions computer control needs",
  handler: async () => {
    const desktop = await load()
    if (typeof desktop === "string") {
      out(desktop)
      process.exitCode = 1
      return
    }
    const missing = await desktop.permissions()
    if (!missing.length) {
      out("Nothing to do: every permission computer control needs is granted.")
      return
    }
    out("Computer control lets the agent see your screen and use the mouse and keyboard, in apps you approve.")
    out("macOS asks you to allow that once, for the app Lunos runs in:")
    out()
    for (const item of missing) out(`- ${item.name}: ${item.how}`)
    out()
    if (desktop.platform !== "darwin") return
    const { MacDesktop } = await import("@/computer/macos")
    if (missing.some((item) => item.name === "Screen Recording") && desktop instanceof MacDesktop)
      desktop.requestScreenRecording()
    const pane = missing.some((item) => item.name === "Accessibility")
      ? "Privacy_Accessibility"
      : "Privacy_ScreenCapture"
    await Bun.spawn(["open", `x-apple.systempreferences:com.apple.preference.security?${pane}`]).exited
    out("System Settings is open at the right page. Turn the switch on, quit and reopen the app, then run")
    out("`lunos computer status` to check.")
  },
})

export const ComputerCommand = cmd({
  command: "computer",
  describe: "computer control: check and grant the OS permissions it needs",
  builder: (yargs) => yargs.command(StatusCommand).command(SetupCommand).demandCommand(),
  handler: () => {},
})
