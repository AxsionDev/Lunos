export * as LinuxDesktop from "./linux"

// XCOD-339: Linux isn't supported yet. On Wayland, apps can't be driven or captured without the
// compositor's portals, which ask the user for every session; on X11 it would be possible (XTest,
// AT-SPI), but isn't built. Both say so clearly instead of failing half way.

export function reason(env: NodeJS.ProcessEnv = process.env) {
  if (env["WAYLAND_DISPLAY"] || env["XDG_SESSION_TYPE"] === "wayland")
    return "Computer control isn't supported on Wayland. Apps on Wayland can't be driven from outside without the desktop's own permission portals, which Lunos doesn't use yet. The browser tool works."
  if (env["DISPLAY"])
    return "Computer control isn't available on Linux (X11) yet. It works on macOS and Windows; the browser tool works here."
  return "Computer control needs a desktop session, and this Linux has no display."
}
