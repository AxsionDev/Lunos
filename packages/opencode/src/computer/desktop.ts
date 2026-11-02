export * as Desktop from "./desktop"

import type { Control } from "@/control"

// XCOD-339: what computer control needs from the operating system. One backend per platform
// (macos.ts, windows.ts, linux.ts), loaded only when the computer tool is first used, and a fake in
// the unit tests. Coordinates here are the OS's own: points on macOS, physical pixels on Windows
// (Lunos runs DPI-aware), with the origin at the top left of the main display.

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }

/** What the accessibility tree says about one element. */
export type Element = {
  role: string
  name?: string
  value?: string
  description?: string
  /** A password field (AXSecureTextField, UIA IsPassword). Never typed into. */
  secure?: boolean
  frame?: Rect
  /** Depth in the tree, for the outline. */
  depth?: number
  /** The window's default button (what Return presses), when the element is a window. */
  defaultButton?: string
}

export type Missing = {
  /** "Accessibility", "Screen Recording", "X11"… */
  name: string
  /** What the user does to grant it. */
  how: string
}

export type Combo = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }

export interface Desktop {
  readonly platform: NodeJS.Platform
  /** OS permissions computer control lacks, with how to grant each. Empty when it can run. */
  permissions(): Promise<Missing[]>
  /** The main display's size, in the coordinates mouse events use. */
  screen(): Promise<{ width: number; height: number }>
  /** The app whose window has keyboard focus. */
  frontmost(): Promise<Control.App | undefined>
  /** The app owning the topmost window at a point: where a click there would land. */
  appAt(point: Point): Promise<Control.App | undefined>
  /** Apps with a window on screen now, front to back. */
  visible(): Promise<Control.App[]>
  /** A JPEG of the screen (or a region of it), scaled to `width` pixels wide, as a data URL. Never written to disk past the call. */
  capture(input: { region?: Rect; width: number }): Promise<{ url: string; width: number; height: number }>
  move(point: Point): Promise<void>
  click(point: Point, button: "left" | "right" | "middle", count: number): Promise<void>
  /** Press at `from`, move to `to`, release. */
  drag(from: Point, to: Point): Promise<void>
  /** Scroll by lines at a point (positive dy scrolls down). */
  scroll(point: Point, dx: number, dy: number): Promise<void>
  /** Types a short run of text as Unicode, without key codes (any layout). */
  type(text: string): Promise<void>
  key(combo: Combo): Promise<void>
  /** The element with keyboard focus. */
  focused(): Promise<Element | undefined>
  /** The element at a point. */
  elementAt(point: Point): Promise<Element | undefined>
  /** The accessibility outline of an app's focused window, capped at `limit` elements. */
  tree(app: Control.App, limit: number): Promise<Element[]>
  /** Whether the OS has secure keyboard entry on (a password field anywhere has focus). */
  secureInput(): Promise<boolean>
  /** Opens or brings forward an app by bundle id (macOS), executable or Start-menu name (Windows). */
  open(id: string): Promise<void>
  /** Resolves what the agent asked to open into the app it is, without opening it. */
  resolve(id: string): Promise<Control.App | undefined>
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  /** Whether every key of the combo is held right now. Synchronous and cheap: polled for the stop key. */
  held(combo: Combo): boolean
  /** When the OS last saw mouse input (ms since epoch), including Lunos's own. Synchronous. */
  lastMouseInput(): number | undefined
  /** Shows "Lunos is controlling your computer · Stop"; calls onStop when Stop is clicked. */
  indicator(input: { stopKey: string; onStop: () => void }): { close(): void } | undefined
  /** The ids of the app Lunos itself runs in (its terminal, the desktop app). Never controlled. */
  self(): string[]
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  del: "delete",
  backspace: "backspace",
  pgup: "pageup",
  pgdn: "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  spacebar: "space",
  " ": "space",
}

/** Parses "ctrl+shift+t", "cmd+a", "Return" into a combo. Modifier names are platform-neutral. */
export function parse(input: string): Combo {
  const parts = input
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
  const key = parts.at(-1) ?? ""
  const mods = parts.slice(0, -1)
  return {
    ctrl: mods.some((m) => m === "ctrl" || m === "control"),
    alt: mods.some((m) => m === "alt" || m === "option" || m === "opt"),
    shift: mods.includes("shift"),
    meta: mods.some((m) => ["cmd", "command", "meta", "super", "win", "windows"].includes(m)),
    key: KEY_ALIASES[key] ?? key,
  }
}

export function same(a: Combo, b: Combo) {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta && a.key === b.key
}

export function format(combo: Combo) {
  return [combo.ctrl && "ctrl", combo.alt && "alt", combo.shift && "shift", combo.meta && "cmd", combo.key]
    .filter(Boolean)
    .join("+")
}

/** Key names every backend maps. Single characters (letters, digits, punctuation) work too. */
export const KEYS = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "space",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
] as const

/** Lunos's own app ids, for `self()`: the desktop app in every channel. */
export const LUNOS_APPS = ["tech.lunos.desktop", "tech.lunos.desktop.dev", "tech.lunos.desktop.beta", "lunos.exe"]
