import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi"
import type { Control } from "@/control"
import { Desktop } from "./desktop"

// XCOD-339: computer control on Windows. Input (SendInput), the stop key (GetAsyncKeyState), the
// window under the pointer and the app in front go through user32 and kernel32 with Bun's FFI.
// The screenshot (GDI), the accessibility tree (UI Automation) and the clipboard run in short
// PowerShell scripts, which Windows always has. Every value a script needs is passed in an
// environment variable, never spliced into the script, so nothing the agent sends can become code.
// Lunos runs per-monitor DPI-aware, so mouse coordinates, UI Automation rectangles and screenshots
// are all physical pixels. Windows needs no permission for any of this; UI Automation can't read
// or drive apps running as administrator from a normal Lunos, and those are refused.
//
// Not verified on a Windows desktop yet: only the bindings and scripts are checked in CI.

export function libraries() {
  const user32 = dlopen("user32.dll", {
    SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.bool },
    GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.bool },
    GetCursorPos: { args: [FFIType.ptr], returns: FFIType.bool },
    SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
    GetForegroundWindow: { args: [], returns: "ptr" },
    // POINT (two int32) by value is one 64-bit integer register on x64.
    WindowFromPoint: { args: [FFIType.i64], returns: "ptr" },
    GetAncestor: { args: [FFIType.ptr, FFIType.u32], returns: "ptr" },
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  })
  const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: "ptr" },
    QueryFullProcessImageNameW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  })
  return { user32: user32.symbols, kernel32: kernel32.symbols }
}

const INPUT_SIZE = 40
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSE = {
  leftDown: 0x2,
  leftUp: 0x4,
  rightDown: 0x8,
  rightUp: 0x10,
  middleDown: 0x20,
  middleUp: 0x40,
  wheel: 0x800,
  hwheel: 0x1000,
} as const
const KEY_UP = 0x2
const KEY_UNICODE = 0x4
const KEY_EXTENDED = 0x1
const WHEEL_DELTA = 120
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const GA_ROOT = 2
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n

/** Virtual-key codes. Letters and digits are their ASCII upper-case code; other characters go as Unicode. */
export const VK: Record<string, number> = {
  enter: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  space: 0x20,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, 0x70 + index])),
}
const EXTENDED = new Set([0x2e, 0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22])
const MODIFIER = { ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b } as const

export function vk(key: string) {
  if (VK[key] !== undefined) return VK[key]
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0)
  return undefined
}

type Libraries = ReturnType<typeof libraries>
/** What FFI returns for a pointer: a number, or a bigint above 2^53. */
type Ref = Pointer | bigint

export class WindowsDesktop implements Desktop.Desktop {
  readonly platform = "win32" as const
  private readonly lib: Libraries
  private indicatorPid: number | undefined
  /** Where Lunos last put the pointer, and when the pointer was last somewhere else. */
  private cursor: { x: number; y: number } | undefined
  private moved: number | undefined

  constructor(lib = libraries()) {
    this.lib = lib
    lib.user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
  }

  async permissions() {
    return []
  }

  async screen() {
    return { width: this.lib.user32.GetSystemMetrics(0), height: this.lib.user32.GetSystemMetrics(1) }
  }

  async frontmost() {
    return this.appOf(this.lib.user32.GetForegroundWindow())
  }

  async appAt(point: Desktop.Point) {
    const packed = (BigInt(Math.round(point.y)) << 32n) | (BigInt(Math.round(point.x)) & 0xffffffffn)
    const window = this.lib.user32.WindowFromPoint(packed)
    if (!window) return this.frontmost()
    const root = this.lib.user32.GetAncestor(window, GA_ROOT) ?? window
    const app = this.appOf(root)
    if (app?.pid === this.indicatorPid) return this.frontmost()
    return app
  }

  async visible() {
    const rows = await powershell<{ id: string; name: string; pid: number }[]>(VISIBLE)
    return rows.filter((row) => row.pid !== this.indicatorPid).map((row) => ({ ...row, id: row.id.toLowerCase() }))
  }

  async capture(input: { region?: Desktop.Rect; width: number }) {
    const region = input.region ?? { x: 0, y: 0, ...(await this.screen()) }
    const result = await powershell<{ data: string; width: number; height: number }>(CAPTURE, {
      LUNOS_X: String(Math.round(region.x)),
      LUNOS_Y: String(Math.round(region.y)),
      LUNOS_W: String(Math.round(region.width)),
      LUNOS_H: String(Math.round(region.height)),
      LUNOS_OUT_W: String(Math.round(input.width)),
    })
    return { url: `data:image/jpeg;base64,${result.data}`, width: result.width, height: result.height }
  }

  async move(point: Desktop.Point) {
    this.cursor = { x: Math.round(point.x), y: Math.round(point.y) }
    this.lib.user32.SetCursorPos(this.cursor.x, this.cursor.y)
  }

  async click(point: Desktop.Point, button: "left" | "right" | "middle", count: number) {
    await this.move(point)
    await Bun.sleep(30)
    const [down, up] =
      button === "left"
        ? [MOUSE.leftDown, MOUSE.leftUp]
        : button === "right"
          ? [MOUSE.rightDown, MOUSE.rightUp]
          : [MOUSE.middleDown, MOUSE.middleUp]
    for (const _ of Array.from({ length: Math.max(1, count) })) this.send([mouse(down), mouse(up)])
  }

  async drag(from: Desktop.Point, to: Desktop.Point) {
    await this.move(from)
    await Bun.sleep(30)
    this.send([mouse(MOUSE.leftDown)])
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await Bun.sleep(15)
      await this.move({ x: from.x + ((to.x - from.x) * step) / 10, y: from.y + ((to.y - from.y) * step) / 10 })
    }
    this.send([mouse(MOUSE.leftUp)])
  }

  async scroll(point: Desktop.Point, dx: number, dy: number) {
    await this.move(point)
    await Bun.sleep(20)
    if (dy) this.send([mouse(MOUSE.wheel, -dy * WHEEL_DELTA)])
    if (dx) this.send([mouse(MOUSE.hwheel, dx * WHEEL_DELTA)])
  }

  async type(text: string) {
    for (const char of Array.from(text)) {
      if (char === "\n" || char === "\r") this.send(keyPress(VK.enter!))
      else if (char === "\t") this.send(keyPress(VK.tab!))
      else
        this.send(
          Array.from({ length: char.length }, (_, index) => char.charCodeAt(index)).flatMap((unit) => [
            keyboard(0, unit, KEY_UNICODE),
            keyboard(0, unit, KEY_UNICODE | KEY_UP),
          ]),
        )
      await Bun.sleep(6)
    }
  }

  async key(combo: Desktop.Combo) {
    const mods = (["ctrl", "alt", "shift", "meta"] as const).filter((name) => combo[name]).map((name) => MODIFIER[name])
    const code = vk(combo.key)
    const body =
      code !== undefined
        ? keyPress(code)
        : Array.from({ length: combo.key.length }, (_, index) => combo.key.charCodeAt(index)).flatMap((unit) => [
            keyboard(0, unit, KEY_UNICODE),
            keyboard(0, unit, KEY_UNICODE | KEY_UP),
          ])
    this.send([
      ...mods.map((mod) => keyboard(mod, 0, 0)),
      ...body,
      ...mods.toReversed().map((mod) => keyboard(mod, 0, KEY_UP)),
    ])
  }

  async focused() {
    return (await powershell<Desktop.Element | null>(FOCUSED)) ?? undefined
  }

  async elementAt(point: Desktop.Point) {
    return (
      (await powershell<Desktop.Element | null>(AT_POINT, {
        LUNOS_X: String(Math.round(point.x)),
        LUNOS_Y: String(Math.round(point.y)),
      })) ?? undefined
    )
  }

  async tree(app: Control.App, limit: number) {
    if (!app.pid) return []
    return powershell<Desktop.Element[]>(TREE, { LUNOS_PID: String(app.pid), LUNOS_LIMIT: String(limit) })
  }

  /** Windows has no system-wide secure input; a password field is found through UI Automation's IsPassword. */
  async secureInput() {
    return false
  }

  async open(id: string) {
    await powershell(OPEN, { LUNOS_APP: id })
  }

  async resolve(id: string) {
    const found = await powershell<{ id: string; name: string; pid?: number } | null>(RESOLVE, { LUNOS_APP: id })
    return found ? { ...found, id: found.id.toLowerCase() } : undefined
  }

  async readClipboard() {
    return (await powershell<string | null>(CLIPBOARD_READ)) ?? ""
  }

  async writeClipboard(text: string) {
    await powershell(CLIPBOARD_WRITE, {}, text)
  }

  held(combo: Desktop.Combo) {
    const code = vk(combo.key)
    if (code === undefined) return false
    const down = (key: number) => (this.lib.user32.GetAsyncKeyState(key) & 0x8000) !== 0
    return (
      down(code) &&
      (!combo.ctrl || down(MODIFIER.ctrl)) &&
      (!combo.alt || down(MODIFIER.alt)) &&
      (!combo.shift || down(MODIFIER.shift)) &&
      (!combo.meta || down(MODIFIER.meta))
    )
  }

  /**
   * When the pointer was last somewhere Lunos didn't put it. Windows reports injected and real input
   * alike (and GetLastInputInfo counts keystrokes, such as the user typing their next message), so
   * the pointer's position is compared with where Lunos last moved it instead.
   */
  lastMouseInput() {
    const point = new Int32Array(2)
    if (!this.lib.user32.GetCursorPos(ptr(point))) return this.moved
    const now = { x: point[0]!, y: point[1]! }
    if (this.cursor && (Math.abs(now.x - this.cursor.x) > 2 || Math.abs(now.y - this.cursor.y) > 2))
      this.moved = Date.now()
    this.cursor = now
    return this.moved
  }

  indicator(input: { stopKey: string; onStop: () => void }) {
    const proc = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      {
        stdin: new Blob([INDICATOR]),
        stdout: "pipe",
        stderr: "ignore",
        env: {
          ...process.env,
          LUNOS_PARENT: String(process.pid),
          LUNOS_LABEL: `Lunos is controlling your computer · ${input.stopKey.replace(/escape$/i, "esc")} or`,
        },
      },
    )
    this.indicatorPid = proc.pid
    const closed = { value: false }
    void (async () => {
      const text = await new Response(proc.stdout).text().catch(() => "")
      if (!closed.value && text.includes("stop")) input.onStop()
    })()
    const kill = () => proc.kill()
    process.once("exit", kill)
    return {
      close: () => {
        closed.value = true
        process.off("exit", kill)
        proc.kill()
        this.indicatorPid = undefined
      },
    }
  }

  self() {
    // The terminal Lunos runs in is a terminal app, refused by category; the desktop app by name.
    return [...Desktop.LUNOS_APPS, "lunos dev.exe", "lunos beta.exe"]
  }

  // ---------------------------------------------------------------------------------------------

  private send(inputs: Uint8Array[]) {
    if (!inputs.length) return
    const buffer = new Uint8Array(inputs.length * INPUT_SIZE)
    inputs.forEach((input, index) => buffer.set(input, index * INPUT_SIZE))
    const sent = this.lib.user32.SendInput(inputs.length, ptr(buffer), INPUT_SIZE)
    if (sent !== inputs.length)
      throw new Error(
        "Windows blocked the input. The app in front may be running as administrator, which a normal Lunos can't control.",
      )
  }

  private appOf(window: Ref | null): Control.App | undefined {
    if (!window) return undefined
    const pid = new Uint32Array(1)
    this.lib.user32.GetWindowThreadProcessId(window, ptr(pid))
    if (!pid[0]) return undefined
    const handle = this.lib.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0])
    if (!handle) return undefined
    const name = new Uint16Array(1024)
    const size = new Uint32Array([name.length])
    const ok = this.lib.kernel32.QueryFullProcessImageNameW(handle, 0, ptr(name), ptr(size))
    this.lib.kernel32.CloseHandle(handle)
    if (!ok) return undefined
    const full = String.fromCharCode(...name.subarray(0, size[0]))
    const exe = full.split("\\").at(-1) ?? full
    return { id: exe.toLowerCase(), name: exe.replace(/\.exe$/i, ""), pid: pid[0] }
  }
}

function mouse(flags: number, data = 0) {
  const input = new Uint8Array(INPUT_SIZE)
  const view = new DataView(input.buffer)
  view.setUint32(0, INPUT_MOUSE, true)
  view.setInt32(16, data, true)
  view.setUint32(20, flags, true)
  return input
}

function keyboard(code: number, scan: number, flags: number) {
  const input = new Uint8Array(INPUT_SIZE)
  const view = new DataView(input.buffer)
  view.setUint32(0, INPUT_KEYBOARD, true)
  view.setUint16(8, code, true)
  view.setUint16(10, scan, true)
  view.setUint32(12, flags | (EXTENDED.has(code) ? KEY_EXTENDED : 0), true)
  return input
}

function keyPress(code: number) {
  return [keyboard(code, 0, 0), keyboard(code, 0, KEY_UP)]
}

/** Runs a script with `powershell.exe`, the script on stdin, and parses the JSON it prints. */
export async function powershell<T = unknown>(script: string, env: Record<string, string> = {}, input?: string) {
  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
    {
      stdin: new Blob([PRELUDE, script]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env, ...(input === undefined ? {} : { LUNOS_INPUT: input }) },
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`PowerShell failed (${code}): ${err.trim() || out.trim()}`)
  const text = out.trim()
  return (text ? JSON.parse(text) : null) as T
}

const PRELUDE = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace Lunos -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);'
[void][Lunos.Dpi]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4))
`

const UIA = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function Describe($e, $depth) {
  $c = $e.Current
  $value = $null
  if (-not $c.IsPassword) {
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $value = $p.Current.Value }
  }
  $r = $c.BoundingRectangle
  $frame = $null
  if (-not $r.IsEmpty) { $frame = @{ x = $r.X; y = $r.Y; width = $r.Width; height = $r.Height } }
  @{ role = $c.ControlType.ProgrammaticName -replace '^ControlType\\.', ''; name = $c.Name; value = $value; description = $c.HelpText; secure = [bool]$c.IsPassword; frame = $frame; depth = $depth }
}
`

const FOCUSED = `${UIA}
$e = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($e) { Describe $e 0 | ConvertTo-Json -Compress -Depth 4 } else { "null" }
`

const AT_POINT = `${UIA}
$e = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new([double]$env:LUNOS_X, [double]$env:LUNOS_Y))
if ($e) { Describe $e 0 | ConvertTo-Json -Compress -Depth 4 } else { "null" }
`

const TREE = `${UIA}
$p = Get-Process -Id ([int]$env:LUNOS_PID)
$limit = [int]$env:LUNOS_LIMIT
$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$out = New-Object System.Collections.ArrayList
$deadline = (Get-Date).AddSeconds(3)
function Walk($e, $depth) {
  if ($out.Count -ge $limit -or $depth -gt 30 -or (Get-Date) -gt $deadline) { return }
  [void]$out.Add((Describe $e $depth))
  $child = $walker.GetFirstChild($e)
  while ($child -ne $null) { Walk $child ($depth + 1); $child = $walker.GetNextSibling($child) }
}
Walk $root 0
ConvertTo-Json -InputObject @($out) -Compress -Depth 4
`

const VISIBLE = `
$rows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  $path = $null; try { $path = $_.Path } catch {}
  $exe = if ($path) { [System.IO.Path]::GetFileName($path) } else { $_.ProcessName + ".exe" }
  @{ id = $exe; name = $_.ProcessName; pid = $_.Id }
})
ConvertTo-Json -InputObject $rows -Compress
`

const CAPTURE = `
Add-Type -AssemblyName System.Drawing
$x = [int]$env:LUNOS_X; $y = [int]$env:LUNOS_Y; $w = [int]$env:LUNOS_W; $h = [int]$env:LUNOS_H; $ow = [int]$env:LUNOS_OUT_W
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$oh = [int][Math]::Round($h * $ow / $w)
$out = New-Object System.Drawing.Bitmap $ow, $oh
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $ow, $oh)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]70)
$ms = New-Object System.IO.MemoryStream
$out.Save($ms, $codec, $params)
@{ data = [Convert]::ToBase64String($ms.ToArray()); width = $ow; height = $oh } | ConvertTo-Json -Compress
`

const RESOLVE = `
$name = $env:LUNOS_APP
$exe = if ($name -match '\\.exe$') { $name } else { "$name.exe" }
$running = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -ieq ($exe -replace '\\.exe$', '') -or $_.MainWindowTitle -ieq $name) } | Select-Object -First 1
if ($running) {
  $path = $null; try { $path = $running.Path } catch {}
  $file = if ($path) { [System.IO.Path]::GetFileName($path) } else { $running.ProcessName + ".exe" }
  @{ id = $file; name = $running.ProcessName; pid = $running.Id } | ConvertTo-Json -Compress; exit
}
$cmd = Get-Command $exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$path = if ($cmd) { $cmd.Source } else {
  $key = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe"
  if (Test-Path -LiteralPath $key) { (Get-Item -LiteralPath $key).GetValue("") } else { $null }
}
if ($path) { @{ id = [System.IO.Path]::GetFileName($path); name = [System.IO.Path]::GetFileNameWithoutExtension($path) } | ConvertTo-Json -Compress } else { "null" }
`

const OPEN = `
Start-Process -FilePath $env:LUNOS_APP
"null"
`

const CLIPBOARD_READ = `
$text = Get-Clipboard -Raw -Format Text
ConvertTo-Json -InputObject ([string]$text) -Compress
`

const CLIPBOARD_WRITE = `
Set-Clipboard -Value $env:LUNOS_INPUT
"null"
`

/**
 * A topmost strip, "Lunos is controlling your computer · Stop", that never takes focus
 * (WS_EX_NOACTIVATE), so keystrokes keep going to the app being controlled. Prints "stop" when
 * Stop is clicked; quits when Lunos does.
 */
export const INDICATOR = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System; using System.Windows.Forms; using System.Drawing;
public class LunosStrip : Form {
  public LunosStrip(string label) {
    FormBorderStyle = FormBorderStyle.None; TopMost = true; ShowInTaskbar = false;
    BackColor = Color.FromArgb(190, 26, 26); Width = 440; Height = 36; StartPosition = FormStartPosition.Manual;
    var area = Screen.PrimaryScreen.WorkingArea; Left = area.Left + (area.Width - Width) / 2; Top = area.Top + 8;
    var text = new Label { Text = label, ForeColor = Color.White, AutoSize = false, Left = 10, Top = 9, Width = 340, Height = 20 };
    var stop = new Button { Text = "Stop", Left = 360, Top = 4, Width = 72, Height = 28, BackColor = Color.White };
    stop.Click += (s, e) => { Console.Out.WriteLine("stop"); Console.Out.Flush(); Application.Exit(); };
    Controls.Add(text); Controls.Add(stop);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008; return p; } }
}
"@
$parent = [int]$env:LUNOS_PARENT
$form = New-Object LunosStrip $env:LUNOS_LABEL
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`

/** Every PowerShell script, for the parse check in CI. */
export const SCRIPTS = {
  PRELUDE,
  FOCUSED,
  AT_POINT,
  TREE,
  VISIBLE,
  CAPTURE,
  RESOLVE,
  OPEN,
  CLIPBOARD_READ,
  CLIPBOARD_WRITE,
  INDICATOR,
}
