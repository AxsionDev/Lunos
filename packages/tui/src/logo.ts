// Lunos wordmark. Kept in the "left" (muted) / "right" (bold) two-tone shape used
// by the Logo component, but the word isn't split — it renders entirely in "right".
// Hand-built box-drawing art (same approach as the prior Ratio wordmark it replaces) —
// needs a look in an actual terminal/TUI before shipping.
//
// Still exported for the non-interactive CLI banner (packages/opencode/src/cli/ui.ts,
// via packages/opencode/src/cli/logo.ts's re-export) — that plain/ANSI fallback path
// doesn't render the interactive TUI splash below, so this text wordmark stays live.
export const logo = {
  left: ["", "", "", ""],
  right: [
    "                        ",
    "█    █  █ █▄ █ █▀▀█ █▀▀▀",
    "█    █  █ █ ▄█ █  █ ▀▀▀█",
    "█▄▄▄ ▀▄▄▀ ▀  ▀ ▀▀▀▀ ▄▄▄█",
  ],
}

// Home-screen splash art ("Moonlit cove", XCOD-6). Hand-built block-character
// shapes — needs a look in an actual terminal/TUI before shipping.
export const splash = {
  wordmark: "lunos",
  moon: [" ▄▄▄ ", "▄███▄", "▀███▀", " ▀▀▀ "],
  cloud: ["  ▄▄▄  ", " ▀▀▀▀▀ "],
  waterWidth: 9,
  reflectionWidth: 6,
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}
