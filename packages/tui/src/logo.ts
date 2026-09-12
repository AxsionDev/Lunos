// Lunos wordmark. Kept in the "left" (muted) / "right" (bold) two-tone shape used
// by the Logo component, but the word isn't split — it renders entirely in "right".
// Hand-built box-drawing art (same approach as the prior Ratio wordmark it replaces) —
// needs a look in an actual terminal/TUI before shipping.
export const logo = {
  left: ["", "", "", ""],
  right: [
    "                        ",
    "█    █  █ █▄ █ █▀▀█ █▀▀▀",
    "█    █  █ █ ▄█ █  █ ▀▀▀█",
    "█▄▄▄ ▀▄▄▀ ▀  ▀ ▀▀▀▀ ▄▄▄█",
  ],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
