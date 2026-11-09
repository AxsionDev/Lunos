import { describe, expect, test } from "bun:test"
import { Desktop } from "@/computer/desktop"

// XCOD-339: the Windows layer. Its PowerShell scripts are parsed wherever PowerShell is installed
// (pwsh on macOS and Linux too). On Windows (CI's windows leg) the user32/kernel32 bindings load
// and the read-only calls run; nothing is clicked or typed.

const shell = Bun.which("powershell.exe") ?? Bun.which("pwsh")
const windows = process.platform === "win32" ? describe : describe.skip

describe("computer on Windows: scripts", () => {
  // Multi-line scripts on stdin (`-Command -`) printed nothing and exited 0: every call returned null.
  test.skipIf(!shell)("a multi-line script runs and prints its result", async () => {
    const { powershellArgv } = await import("@/computer/windows")
    const script =
      '$x = if ($env:LUNOS_X) {\n  "got $env:LUNOS_X"\n} else {\n  "none"\n}\n$x | ConvertTo-Json -Compress\n'
    const argv = powershellArgv(script)
    argv[0] = shell!
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, LUNOS_X: "é ok" } })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(JSON.parse(out.trim())).toBe("got é ok")
  })

  test.skipIf(!shell)("every PowerShell script parses", async () => {
    const { SCRIPTS } = await import("@/computer/windows")
    for (const [name, script] of Object.entries(SCRIPTS)) {
      const proc = Bun.spawn(
        [
          shell!,
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:LUNOS_SCRIPT, [ref]$null, [ref]$e); $e.Count",
        ],
        { env: { ...process.env, LUNOS_SCRIPT: script }, stdout: "pipe", stderr: "pipe" },
      )
      const out = (await new Response(proc.stdout).text()).trim()
      await proc.exited
      expect(`${name}: ${out}`).toBe(`${name}: 0`)
    }
  })

  test("key names map to virtual-key codes", async () => {
    const { vk } = await import("@/computer/windows")
    expect(vk("enter")).toBe(0x0d)
    expect(vk("a")).toBe(0x41)
    expect(vk("7")).toBe(0x37)
    expect(vk("f12")).toBe(0x7b)
    expect(vk("é")).toBeUndefined()
    for (const key of Desktop.KEYS) expect(vk(key)).toBeDefined()
  })
})

windows("computer on Windows: the system", () => {
  test("the bindings load and read-only calls work", async () => {
    const { WindowsDesktop } = await import("@/computer/windows")
    const desktop = new WindowsDesktop()
    expect(await desktop.permissions()).toEqual([])
    const screen = await desktop.screen()
    expect(screen.width).toBeGreaterThan(0)
    expect(desktop.held(Desktop.parse("ctrl+alt+escape"))).toBe(false)
    // undefined until the mouse is seen to move (always so on a CI runner nobody uses).
    const moved = desktop.lastMouseInput()
    if (moved !== undefined) expect(moved).toBeLessThanOrEqual(Date.now())
    const front = await desktop.frontmost()
    if (front) expect(front.id).toMatch(/\.exe$/)
    // Found through PATH; cmd.exe is on every Windows (Server 2025 runners have no Notepad).
    expect((await desktop.resolve("cmd"))?.id).toBe("cmd.exe")
  })
})

describe("computer on Linux", () => {
  test("Wayland and X11 say clearly that they aren't supported", async () => {
    const { LinuxDesktop } = await import("@/computer/linux")
    expect(LinuxDesktop.reason({ WAYLAND_DISPLAY: "wayland-0" })).toContain("isn't supported on Wayland")
    expect(LinuxDesktop.reason({ DISPLAY: ":0" })).toContain("X11")
    expect(LinuxDesktop.reason({})).toContain("no display")
  })
})
