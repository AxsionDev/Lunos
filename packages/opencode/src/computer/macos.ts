import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Control } from "@/control"
import { Desktop } from "./desktop"

// XCOD-339: computer control on macOS. Input is posted as CGEvents and the screen is read through
// the Accessibility API, both from CoreGraphics and ApplicationServices through Bun's FFI, so
// there's nothing to install. Screenshots use the system's `screencapture`. macOS grants the
// Accessibility and Screen Recording permissions to the app Lunos runs in (the terminal, or the
// Lunos desktop app), not to Lunos: `permissions()` says which is missing and where to turn it on.
//
// FFI and structs: Bun passes scalars only. A CGPoint (two doubles) passed by value travels in two
// floating-point registers on both arm64 and x86_64, exactly like two double arguments, so the
// functions taking one are declared with (x: f64, y: f64). Functions returning a struct aren't
// used; the Accessibility API returns points through AXValueGetValue into a buffer instead.

const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
const AX = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
const CARBON = "/System/Library/Frameworks/Carbon.framework/Carbon"

export function libraries() {
  const cg = dlopen(CG, {
    CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
    CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
    CGMainDisplayID: { args: [], returns: FFIType.u32 },
    CGDisplayPixelsWide: { args: [FFIType.u32], returns: FFIType.u32 },
    CGDisplayPixelsHigh: { args: [FFIType.u32], returns: FFIType.u32 },
    CGEventCreateMouseEvent: {
      args: [FFIType.ptr, FFIType.u32, FFIType.f64, FFIType.f64, FFIType.u32],
      returns: "ptr",
    },
    CGEventCreateKeyboardEvent: { args: [FFIType.ptr, FFIType.u16, FFIType.bool], returns: "ptr" },
    CGEventKeyboardSetUnicodeString: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
    CGEventSetFlags: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
    CGEventSetIntegerValueField: { args: [FFIType.ptr, FFIType.u32, FFIType.i64], returns: FFIType.void },
    CGEventGetIntegerValueField: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CGEventCreateScrollWheelEvent2: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32],
      returns: "ptr",
    },
    CGEventPost: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
    CGEventSourceKeyState: { args: [FFIType.i32, FFIType.u16], returns: FFIType.bool },
    CGEventSourceFlagsState: { args: [FFIType.i32], returns: FFIType.u32 },
    CGEventSourceSecondsSinceLastEventType: { args: [FFIType.i32, FFIType.u32], returns: FFIType.f64 },
    CGWindowListCopyWindowInfo: { args: [FFIType.u32, FFIType.u32], returns: "ptr" },
    // Only used to check the CGPoint calling convention (test/computer/macos.test.ts): x of the event's location.
    CGEventGetLocation: { args: [FFIType.ptr], returns: FFIType.f64 },
  })
  const cf = dlopen(CF, {
    CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: "ptr" },
    CFStringGetLength: { args: [FFIType.ptr], returns: FFIType.i32 },
    CFStringGetCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
    CFGetTypeID: { args: [FFIType.ptr], returns: FFIType.u32 },
    CFStringGetTypeID: { args: [], returns: FFIType.u32 },
    CFArrayGetTypeID: { args: [], returns: FFIType.u32 },
    CFNumberGetTypeID: { args: [], returns: FFIType.u32 },
    CFBooleanGetTypeID: { args: [], returns: FFIType.u32 },
    CFArrayGetCount: { args: [FFIType.ptr], returns: FFIType.i32 },
    CFArrayGetValueAtIndex: { args: [FFIType.ptr, FFIType.i64], returns: "ptr" },
    CFDictionaryGetValue: { args: [FFIType.ptr, FFIType.ptr], returns: "ptr" },
    CFNumberGetValue: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.bool },
    CFBooleanGetValue: { args: [FFIType.ptr], returns: FFIType.bool },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    CFRetain: { args: [FFIType.ptr], returns: "ptr" },
  })
  const ax = dlopen(AX, {
    AXIsProcessTrusted: { args: [], returns: FFIType.bool },
    AXUIElementCreateApplication: { args: [FFIType.i32], returns: "ptr" },
    AXUIElementCreateSystemWide: { args: [], returns: "ptr" },
    AXUIElementCopyAttributeValue: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    AXUIElementCopyElementAtPosition: {
      args: [FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.ptr],
      returns: FFIType.i32,
    },
    AXUIElementSetMessagingTimeout: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.i32 },
    AXUIElementGetPid: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    AXValueGetValue: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
  })
  const carbon = dlopen(CARBON, {
    IsSecureEventInputEnabled: { args: [], returns: FFIType.bool },
  })
  return { cg: cg.symbols, cf: cf.symbols, ax: ax.symbols, carbon: carbon.symbols }
}

const UTF8 = 0x08000100
/** CGEventSourceStateID: what the user's hardware did, and that combined with posted events. */
const HID_STATE = 1
const COMBINED_STATE = 0
const HID_TAP = 0
const EVENT = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, moved: 5, leftDragged: 6, scroll: 22 } as const
const OTHER_DOWN = 25
const OTHER_UP = 26
const CLICK_STATE = 1
const FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, meta: 0x100000 } as const
/** kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements */
const ON_SCREEN = 1 | 16
const AX_TIMEOUT_S = 0.25
/** Containers that only group other elements: left out of the outline unless they have a name. */
const GROUPS = new Set(["AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem", "AXUnknown"])

/** US-layout virtual key codes. Other characters are typed as Unicode with the modifiers held. */
export const KEYCODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  enter: 36,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  tab: 48,
  space: 49,
  "`": 50,
  backspace: 51,
  escape: 53,
  delete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
}

type Libraries = ReturnType<typeof libraries>
/** What FFI returns for a pointer: a number, or a bigint above 2^53. */
type Ref = Pointer | bigint

export class MacDesktop implements Desktop.Desktop {
  readonly platform = "darwin" as const
  private readonly lib: Libraries
  private readonly strings = new Map<string, Ref>()
  private readonly types: { string: number; array: number; number: number; boolean: number }
  private readonly apps = new Map<number, { app: Control.App | undefined; at: number }>()
  private indicatorPid: number | undefined

  constructor(lib = libraries()) {
    this.lib = lib
    this.types = {
      string: lib.cf.CFStringGetTypeID(),
      array: lib.cf.CFArrayGetTypeID(),
      number: lib.cf.CFNumberGetTypeID(),
      boolean: lib.cf.CFBooleanGetTypeID(),
    }
  }

  async permissions() {
    const host = hostApp()
    return [
      ...(this.lib.ax.AXIsProcessTrusted()
        ? []
        : [
            {
              name: "Accessibility",
              how: `System Settings › Privacy & Security › Accessibility: turn on ${host}, then quit and reopen it. This lets Lunos move the mouse, type and read app windows.`,
            },
          ]),
      ...(this.lib.cg.CGPreflightScreenCaptureAccess()
        ? []
        : [
            {
              name: "Screen Recording",
              how: `System Settings › Privacy & Security › Screen & System Audio Recording: turn on ${host}, then quit and reopen it. This lets Lunos take screenshots.`,
            },
          ]),
    ]
  }

  /** Asks macOS to show its Screen Recording prompt (`lunos computer setup` only). */
  requestScreenRecording() {
    return this.lib.cg.CGRequestScreenCaptureAccess()
  }

  async screen() {
    const display = this.lib.cg.CGMainDisplayID()
    return { width: this.lib.cg.CGDisplayPixelsWide(display), height: this.lib.cg.CGDisplayPixelsHigh(display) }
  }

  async frontmost() {
    const asn = (await run(["lsappinfo", "front"])).trim()
    if (!asn) return undefined
    return parseAppInfo(await run(["lsappinfo", "info", "-only", "bundleid", "-only", "pid", asn]))
  }

  async appAt(point: Desktop.Point) {
    const window = this.windows().find(
      (item) =>
        point.x >= item.x && point.x < item.x + item.width && point.y >= item.y && point.y < item.y + item.height,
    )
    return window ? this.app(window.pid) : this.frontmost()
  }

  async visible() {
    const pids = [
      ...new Set(
        this.windows()
          .filter((item) => item.layer === 0)
          .map((item) => item.pid),
      ),
    ]
    const apps = await Promise.all(pids.map((pid) => this.app(pid)))
    return apps.filter((app): app is Control.App => app !== undefined)
  }

  async capture(input: { region?: Desktop.Rect; width: number }) {
    // mkdtemp makes the folder readable by this user only; it's gone when the call returns.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-screen-"))
    try {
      const raw = path.join(dir, "raw.png")
      const out = path.join(dir, "out.jpg")
      const region = input.region
        ? ["-R", [input.region.x, input.region.y, input.region.width, input.region.height].map(Math.round).join(",")]
        : ["-m"]
      await run(["screencapture", "-x", "-t", "png", ...region, raw])
      await run([
        "sips",
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "70",
        "--resampleWidth",
        String(input.width),
        raw,
        "--out",
        out,
      ])
      const size = await run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", out])
      const bytes = await Bun.file(out).bytes()
      return {
        url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
        width: Number(size.match(/pixelWidth: (\d+)/)?.[1] ?? input.width),
        height: Number(size.match(/pixelHeight: (\d+)/)?.[1] ?? 0),
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  async move(point: Desktop.Point) {
    this.mouse(EVENT.moved, point, 0)
  }

  async click(point: Desktop.Point, button: "left" | "right" | "middle", count: number) {
    const [down, up, code] =
      button === "left"
        ? [EVENT.leftDown, EVENT.leftUp, 0]
        : button === "right"
          ? [EVENT.rightDown, EVENT.rightUp, 1]
          : [OTHER_DOWN, OTHER_UP, 2]
    this.mouse(EVENT.moved, point, 0)
    await Bun.sleep(30)
    for (const clicks of Array.from({ length: Math.max(1, count) }, (_, index) => index + 1)) {
      this.mouse(down, point, code, clicks)
      this.mouse(up, point, code, clicks)
    }
  }

  async drag(from: Desktop.Point, to: Desktop.Point) {
    this.mouse(EVENT.moved, from, 0)
    await Bun.sleep(30)
    this.mouse(EVENT.leftDown, from, 0, 1)
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await Bun.sleep(15)
      this.mouse(
        EVENT.leftDragged,
        { x: from.x + ((to.x - from.x) * step) / 10, y: from.y + ((to.y - from.y) * step) / 10 },
        0,
      )
    }
    this.mouse(EVENT.leftUp, to, 0, 1)
  }

  async scroll(point: Desktop.Point, dx: number, dy: number) {
    this.mouse(EVENT.moved, point, 0)
    await Bun.sleep(20)
    // Wheel 1 is vertical, positive up; wheel 2 horizontal, positive left.
    const event = this.lib.cg.CGEventCreateScrollWheelEvent2(null, 1, 2, -dy, -dx, 0)
    this.post(event)
  }

  async type(text: string) {
    for (const char of Array.from(text)) {
      if (char === "\n" || char === "\r") this.press(KEYCODES.enter!, 0)
      else if (char === "\t") this.press(KEYCODES.tab!, 0)
      else this.unicode(char, 0)
      await Bun.sleep(6)
    }
  }

  async key(combo: Desktop.Combo) {
    const flags =
      (combo.shift ? FLAG.shift : 0) |
      (combo.ctrl ? FLAG.ctrl : 0) |
      (combo.alt ? FLAG.alt : 0) |
      (combo.meta ? FLAG.meta : 0)
    const code = KEYCODES[combo.key]
    if (code !== undefined) return this.press(code, flags)
    this.unicode(combo.key, flags)
  }

  async focused() {
    const system = this.lib.ax.AXUIElementCreateSystemWide()
    if (!system) return undefined
    const element = this.copy(system, "AXFocusedUIElement")
    this.lib.cf.CFRelease(system)
    if (!element) return undefined
    const described = this.describe(element)
    this.lib.cf.CFRelease(element)
    return described
  }

  async elementAt(point: Desktop.Point) {
    const system = this.lib.ax.AXUIElementCreateSystemWide()
    if (!system) return undefined
    this.lib.ax.AXUIElementSetMessagingTimeout(system, AX_TIMEOUT_S)
    const out = new BigUint64Array(1)
    const error = this.lib.ax.AXUIElementCopyElementAtPosition(system, point.x, point.y, ptr(out))
    this.lib.cf.CFRelease(system)
    if (error !== 0 || !out[0]) return undefined
    const element = Number(out[0]) as Ref
    const described = this.describe(element)
    this.lib.cf.CFRelease(element)
    return described
  }

  async tree(app: Control.App, limit: number) {
    if (!app.pid) return []
    const root = this.lib.ax.AXUIElementCreateApplication(app.pid)
    if (!root) return []
    this.lib.ax.AXUIElementSetMessagingTimeout(root, AX_TIMEOUT_S)
    const window = this.copy(root, "AXFocusedWindow") ?? this.first(root, "AXWindows")
    this.lib.cf.CFRelease(root)
    if (!window) return []
    const found: Desktop.Element[] = []
    const deadline = Date.now() + 2_000
    const walk = (element: Ref, depth: number) => {
      if (found.length >= limit || depth > 30 || Date.now() > deadline) return
      const described = this.describe(element)
      const shown = !(GROUPS.has(described.role) && !described.name && !described.value)
      if (shown) found.push({ ...described, depth })
      const children = this.copy(element, "AXChildren")
      if (!children) return
      const count = this.lib.cf.CFGetTypeID(children) === this.types.array ? this.lib.cf.CFArrayGetCount(children) : 0
      for (const index of Array.from({ length: count }, (_, i) => i)) {
        const child = this.lib.cf.CFArrayGetValueAtIndex(children, index)
        if (child) walk(child, shown ? depth + 1 : depth)
      }
      this.lib.cf.CFRelease(children)
    }
    walk(window, 0)
    const button = this.copy(window, "AXDefaultButton")
    if (button && found[0]) {
      found[0].defaultButton = this.text(button, "AXTitle")
      this.lib.cf.CFRelease(button)
    }
    this.lib.cf.CFRelease(window)
    return found
  }

  async secureInput() {
    return this.lib.carbon.IsSecureEventInputEnabled()
  }

  async open(id: string) {
    await run(["open", "-b", id])
  }

  async resolve(id: string) {
    const running = await this.running()
    const wanted = id.toLowerCase().replace(/\.app$/, "")
    const match = running.find((app) => app.id.toLowerCase() === wanted || app.name.toLowerCase() === wanted)
    if (match) return match
    const bundle = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id)
      ? (await run(["mdfind", `kMDItemCFBundleIdentifier == '${id}'`]).catch(() => "")).split("\n")[0]
      : await installed(id.replace(/\.app$/i, ""))
    if (!bundle) return undefined
    const bundleId = (
      await run([
        "plutil",
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
        path.join(bundle, "Contents", "Info.plist"),
      ]).catch(() => "")
    ).trim()
    if (!bundleId) return undefined
    return { id: bundleId, name: path.basename(bundle, ".app") }
  }

  async readClipboard() {
    return run(["pbpaste", "-Prefer", "txt"])
  }

  async writeClipboard(text: string) {
    const proc = Bun.spawn(["pbcopy"], { stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" })
    await proc.exited
  }

  held(combo: Desktop.Combo) {
    const code = KEYCODES[combo.key]
    if (code === undefined || !this.lib.cg.CGEventSourceKeyState(COMBINED_STATE, code)) return false
    const flags = this.lib.cg.CGEventSourceFlagsState(COMBINED_STATE)
    return (
      (!combo.ctrl || (flags & FLAG.ctrl) !== 0) &&
      (!combo.alt || (flags & FLAG.alt) !== 0) &&
      (!combo.shift || (flags & FLAG.shift) !== 0) &&
      (!combo.meta || (flags & FLAG.meta) !== 0)
    )
  }

  lastMouseInput() {
    const seconds = Math.min(
      ...[EVENT.moved, EVENT.leftDown, EVENT.rightDown, EVENT.leftDragged, EVENT.scroll].map((type) =>
        this.lib.cg.CGEventSourceSecondsSinceLastEventType(HID_STATE, type),
      ),
    )
    return Number.isFinite(seconds) ? Date.now() - seconds * 1000 : undefined
  }

  indicator(input: { stopKey: string; onStop: () => void }) {
    const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", indicatorScript(input.stopKey)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
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
    return [process.env["__CFBundleIdentifier"], ...Desktop.LUNOS_APPS].filter((id): id is string => !!id)
  }

  // ---------------------------------------------------------------------------------------------

  private post(event: Ref | null) {
    if (!event) throw new Error("macOS refused to create the input event.")
    this.lib.cg.CGEventPost(HID_TAP, event)
    this.lib.cf.CFRelease(event)
  }

  private mouse(type: number, point: Desktop.Point, button: number, clicks?: number) {
    const event = this.lib.cg.CGEventCreateMouseEvent(null, type, point.x, point.y, button)
    if (event && clicks) this.lib.cg.CGEventSetIntegerValueField(event, CLICK_STATE, clicks)
    this.post(event)
  }

  private press(code: number, flags: number) {
    for (const down of [true, false]) {
      const event = this.lib.cg.CGEventCreateKeyboardEvent(null, code, down)
      if (event) this.lib.cg.CGEventSetFlags(event, flags)
      this.post(event)
    }
  }

  private unicode(char: string, flags: number) {
    const units = Uint16Array.from({ length: char.length }, (_, index) => char.charCodeAt(index))
    for (const down of [true, false]) {
      const event = this.lib.cg.CGEventCreateKeyboardEvent(null, 0, down)
      if (event) {
        this.lib.cg.CGEventSetFlags(event, flags)
        this.lib.cg.CGEventKeyboardSetUnicodeString(event, units.length, ptr(units))
      }
      this.post(event)
    }
  }

  private cfstr(text: string) {
    const existing = this.strings.get(text)
    if (existing) return existing
    const created = this.lib.cf.CFStringCreateWithCString(null, ptr(Buffer.from(text + "\0")), UTF8)
    if (!created) throw new Error(`CFString ${text}`)
    this.strings.set(text, created)
    return created
  }

  /** A copied attribute value (release it), or undefined. */
  private copy(element: Ref, attribute: string) {
    const out = new BigUint64Array(1)
    const error = this.lib.ax.AXUIElementCopyAttributeValue(element, this.cfstr(attribute), ptr(out))
    return error === 0 && out[0] ? (Number(out[0]) as Ref) : undefined
  }

  private first(element: Ref, attribute: string) {
    const list = this.copy(element, attribute)
    if (!list) return undefined
    const count = this.lib.cf.CFGetTypeID(list) === this.types.array ? this.lib.cf.CFArrayGetCount(list) : 0
    const item = count ? this.lib.cf.CFArrayGetValueAtIndex(list, 0) : null
    // Owned by the caller, like a copied attribute: retained before the array goes.
    if (item) this.lib.cf.CFRetain(item)
    this.lib.cf.CFRelease(list)
    return item ?? undefined
  }

  private string(value: Ref) {
    if (this.lib.cf.CFGetTypeID(value) !== this.types.string) return undefined
    const length = this.lib.cf.CFStringGetLength(value)
    const buffer = Buffer.alloc(length * 4 + 1)
    if (!this.lib.cf.CFStringGetCString(value, ptr(buffer), buffer.length, UTF8)) return undefined
    return buffer.toString("utf8", 0, buffer.indexOf(0))
  }

  private text(element: Ref, attribute: string) {
    const value = this.copy(element, attribute)
    if (!value) return undefined
    const result =
      this.string(value) ??
      (this.lib.cf.CFGetTypeID(value) === this.types.number ? String(this.number(value)) : undefined) ??
      (this.lib.cf.CFGetTypeID(value) === this.types.boolean ? String(this.lib.cf.CFBooleanGetValue(value)) : undefined)
    this.lib.cf.CFRelease(value)
    return result?.trim() || undefined
  }

  private number(value: Ref) {
    const out = new Float64Array(1)
    this.lib.cf.CFNumberGetValue(value, 6, ptr(out))
    return out[0]!
  }

  private vector(element: Ref, attribute: string, type: 1 | 2) {
    const value = this.copy(element, attribute)
    if (!value) return undefined
    const out = new Float64Array(2)
    const ok = this.lib.ax.AXValueGetValue(value, type, ptr(out))
    this.lib.cf.CFRelease(value)
    return ok ? [out[0]!, out[1]!] : undefined
  }

  private describe(element: Ref): Desktop.Element {
    const role = this.text(element, "AXRole") ?? "AXUnknown"
    const subrole = this.text(element, "AXSubrole")
    const secure = subrole === "AXSecureTextField"
    const position = this.vector(element, "AXPosition", 1)
    const size = this.vector(element, "AXSize", 2)
    return {
      role,
      name: this.text(element, "AXTitle") ?? this.text(element, "AXLabel"),
      // A password field's value is never read.
      value: secure ? undefined : this.text(element, "AXValue"),
      description: this.text(element, "AXDescription") ?? this.text(element, "AXPlaceholderValue"),
      secure: secure || undefined,
      frame: position && size ? { x: position[0]!, y: position[1]!, width: size[0]!, height: size[1]! } : undefined,
    }
  }

  /** On-screen windows front to back, without Lunos's own Stop indicator. */
  private windows() {
    const list = this.lib.cg.CGWindowListCopyWindowInfo(ON_SCREEN, 0)
    if (!list) return []
    const count = this.lib.cf.CFArrayGetCount(list)
    const read = (dict: Ref, key: string) => {
      const value = this.lib.cf.CFDictionaryGetValue(dict, this.cfstr(key))
      return value ? this.number(value) : undefined
    }
    const windows = Array.from({ length: count }, (_, index) => this.lib.cf.CFArrayGetValueAtIndex(list, index))
      .filter((dict): dict is Ref => !!dict)
      .flatMap((dict) => {
        const bounds = this.lib.cf.CFDictionaryGetValue(dict, this.cfstr("kCGWindowBounds"))
        const pid = read(dict, "kCGWindowOwnerPID")
        if (!bounds || pid === undefined) return []
        return [
          {
            pid,
            layer: read(dict, "kCGWindowLayer") ?? 0,
            alpha: read(dict, "kCGWindowAlpha") ?? 1,
            x: read(bounds, "X") ?? 0,
            y: read(bounds, "Y") ?? 0,
            width: read(bounds, "Width") ?? 0,
            height: read(bounds, "Height") ?? 0,
          },
        ]
      })
    this.lib.cf.CFRelease(list)
    return windows.filter((item) => item.pid !== this.indicatorPid && item.alpha > 0 && item.layer < 1000)
  }

  private async app(pid: number) {
    const cached = this.apps.get(pid)
    if (cached && Date.now() - cached.at < 30_000) return cached.app
    const app = parseAppInfo(await run(["lsappinfo", "info", "-only", "bundleid", "-only", "pid", `#${pid}`]))
    this.apps.set(pid, { app, at: Date.now() })
    return app
  }

  private async running() {
    const text = await run(["lsappinfo", "list"])
    return text
      .split(/\n(?=\s*\d+\) )/)
      .map(parseAppInfo)
      .filter((app): app is Control.App => app !== undefined)
  }
}

/** Parses one app from `lsappinfo info` / `lsappinfo list` output. */
export function parseAppInfo(text: string): Control.App | undefined {
  const name = text.match(/"([^"]+)" ASN:/)?.[1]
  const id = text.match(/bundleID="([^"]+)"/)?.[1]
  const pid = Number(text.match(/pid = (\d+)/)?.[1])
  if (!id) return undefined
  return { id, name: name ?? id, pid: Number.isFinite(pid) && pid > 0 ? pid : undefined }
}

const HOSTS: Record<string, string> = {
  "com.apple.terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm",
  "com.mitchellh.ghostty": "Ghostty",
  "dev.warp.warp-stable": "Warp",
  "com.microsoft.vscode": "Visual Studio Code",
  "net.kovidgoyal.kitty": "kitty",
  "com.github.wez.wezterm": "WezTerm",
}

/**
 * The app macOS grants permissions to: the one that started Lunos (its bundle id is in
 * __CFBundleIdentifier), which isn't always the terminal you see, e.g. under tmux.
 */
export function hostApp(id = process.env["__CFBundleIdentifier"]) {
  if (!id) return "the terminal or app Lunos runs in"
  if (id.toLowerCase().startsWith("tech.lunos.desktop")) return "Lunos"
  return HOSTS[id.toLowerCase()] ?? `the app Lunos runs in (${id})`
}

async function installed(name: string) {
  const roots = [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    path.join(os.homedir(), "Applications"),
  ]
  for (const root of roots) {
    const candidate = path.join(root, `${name}.app`)
    if (
      await fs.stat(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate
  }
  return undefined
}

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${err.trim() || out.trim()}`)
  return out
}

/**
 * A small always-on-top panel, "Lunos is controlling your computer · Stop", in JavaScript for
 * Automation. It never takes focus (a non-activating panel), so the agent's keystrokes keep going to
 * the app it controls. It prints "stop" when Stop is clicked, and quits when Lunos does.
 */
export function indicatorScript(stopKey: string) {
  const label = `Lunos is controlling your computer · ${stopKey.replace(/escape$/i, "esc")} or`
  return `
ObjC.import("Cocoa"); ObjC.import("unistd");
const parent = $.getppid();
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
ObjC.registerSubclass({
  name: "LunosStopTarget",
  methods: {
    "stop:": { types: ["void", ["id"]], implementation: function () {
      $.NSFileHandle.fileHandleWithStandardOutput.writeData($("stop\\n").dataUsingEncoding($.NSUTF8StringEncoding));
      app.terminate(null);
    } },
    "tick:": { types: ["void", ["id"]], implementation: function () { if ($.getppid() !== parent) app.terminate(null); } },
  },
});
const target = $.LunosStopTarget.alloc.init;
const width = 420, height = 34;
const frame = $.NSScreen.mainScreen.frame;
const rect = $.NSMakeRect(frame.origin.x + (frame.size.width - width) / 2, frame.origin.y + frame.size.height - height - 40, width, height);
const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(rect, 128, $.NSBackingStoreBuffered, false);
panel.level = 25;
panel.collectionBehavior = 1 | 16 | 256;
panel.hidesOnDeactivate = false;
panel.becomesKeyOnlyIfNeeded = true;
panel.opaque = false;
panel.backgroundColor = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.75, 0.1, 0.1, 0.92);
const text = $.NSTextField.labelWithString(${JSON.stringify(label)});
text.textColor = $.NSColor.whiteColor;
text.frame = $.NSMakeRect(12, 8, width - 90, 18);
panel.contentView.addSubview(text);
const button = $.NSButton.buttonWithTitleTargetAction("Stop", target, "stop:");
button.frame = $.NSMakeRect(width - 76, 3, 68, 28);
panel.contentView.addSubview(button);
panel.orderFrontRegardless;
$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1, target, "tick:", null, true);
app.run;
`
}
