import { describe, expect, test } from "bun:test"
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Desktop } from "@/computer/desktop"

// XCOD-339: the real macOS layer, as far as it can be checked without posting input or a screen:
// the system libraries bind, the CGPoint calling convention holds, the Stop indicator compiles, and
// app and permission lookups work. Posting input, screenshots and the Accessibility tree need the
// permissions granted to the terminal, and are checked by hand (docs/browser-control.md).

const mac = process.platform === "darwin" ? describe : describe.skip

mac("computer on macOS", () => {
  test("the system libraries bind and the display has a size", async () => {
    const { MacDesktop } = await import("@/computer/macos")
    const desktop = new MacDesktop()
    const screen = await desktop.screen()
    expect(screen.width).toBeGreaterThan(0)
    expect(screen.height).toBeGreaterThan(0)
    const missing = await desktop.permissions()
    for (const item of missing) expect(item.how).toContain("System Settings › Privacy & Security")
    expect(typeof desktop.held(Desktop.parse("ctrl+alt+escape"))).toBe("boolean")
    expect(desktop.lastMouseInput()).toBeLessThanOrEqual(Date.now())
    expect(typeof (await desktop.secureInput())).toBe("boolean")
  })

  test("a CGPoint passed as two doubles arrives as x and y (no event is posted)", async () => {
    const { libraries } = await import("@/computer/macos")
    const lib = libraries()
    const event = lib.cg.CGEventCreateMouseEvent(null, 5, 123.5, 456.25, 0)
    expect(event).not.toBeNull()
    expect(lib.cg.CGEventGetLocation(event)).toBe(123.5)
    // y: the serialized event holds both coordinates.
    const extra = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGEventCreateData: { args: [FFIType.ptr, FFIType.ptr], returns: "ptr" },
      CGPointEqualToPoint: { args: [FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64], returns: FFIType.bool },
    })
    const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
      CFDataGetLength: { args: [FFIType.ptr], returns: FFIType.i32 },
      CFDataGetBytePtr: { args: [FFIType.ptr], returns: "ptr" },
    })
    const data = extra.symbols.CGEventCreateData(null, event)
    const bytes = new Uint8Array(
      toArrayBuffer(cf.symbols.CFDataGetBytePtr(data)!, 0, cf.symbols.CFDataGetLength(data)),
    ).slice()
    const contains = (value: number, size: 4 | 8) => {
      const needle = new Uint8Array(size)
      const view = new DataView(needle.buffer)
      for (const little of [true, false]) {
        if (size === 8) view.setFloat64(0, value, little)
        else view.setFloat32(0, value, little)
        const hex = Buffer.from(needle).toString("hex")
        if (Buffer.from(bytes).toString("hex").includes(hex)) return true
      }
      return false
    }
    expect(contains(456.25, 8) || contains(456.25, 4)).toBe(true)
    expect(extra.symbols.CGPointEqualToPoint(1, 2, 1, 2)).toBe(true)
    expect(extra.symbols.CGPointEqualToPoint(1, 2, 1, 3)).toBe(false)
    lib.cf.CFRelease(data)
    lib.cf.CFRelease(event)
  })

  test("Unicode text and key events are created without being posted", async () => {
    const { libraries, KEYCODES } = await import("@/computer/macos")
    const lib = libraries()
    const event = lib.cg.CGEventCreateKeyboardEvent(null, KEYCODES["a"]!, true)
    expect(event).not.toBeNull()
    const units = Uint16Array.from({ length: 2 }, (_, index) => "é!".charCodeAt(index))
    lib.cg.CGEventKeyboardSetUnicodeString(event, units.length, ptr(units))
    lib.cg.CGEventSetFlags(event, 0x100000)
    lib.cf.CFRelease(event)
    const scroll = lib.cg.CGEventCreateScrollWheelEvent2(null, 1, 2, -3, 0, 0)
    expect(scroll).not.toBeNull()
    lib.cf.CFRelease(scroll)
  })

  test("apps are found by bundle id or name, and the one in front is known", async () => {
    const { MacDesktop, parseAppInfo } = await import("@/computer/macos")
    expect(
      parseAppInfo(`"Finder" ASN:0x0-0x17017:\n    bundleID="com.apple.finder"\n    pid = 527 !cgsConnection`),
    ).toEqual({ id: "com.apple.finder", name: "Finder", pid: 527 })
    const desktop = new MacDesktop()
    expect((await desktop.frontmost())?.id).toBeTruthy()
    expect((await desktop.resolve("Finder"))?.id).toBe("com.apple.finder")
    expect((await desktop.resolve("TextEdit"))?.id).toBe("com.apple.TextEdit")
    expect(await desktop.resolve("No Such App 12345")).toBeUndefined()
    expect(desktop.self()).toContain("tech.lunos.desktop")
  })

  test("the Stop indicator script compiles", async () => {
    const { indicatorScript } = await import("@/computer/macos")
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-indicator-"))
    const proc = Bun.spawn(
      ["osacompile", "-l", "JavaScript", "-o", path.join(dir, "i.scpt"), "-e", indicatorScript("ctrl+alt+escape")],
      { stderr: "pipe" },
    )
    const code = await proc.exited
    const error = await new Response(proc.stderr).text()
    await fs.rm(dir, { recursive: true, force: true })
    expect(error).toBe("")
    expect(code).toBe(0)
  })
})
