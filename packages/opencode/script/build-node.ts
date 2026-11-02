#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    // XCOD-312: the desktop app's server is this bundle. As in script/build.ts (XCOD-273), only the
    // release pipeline sets it, so a disabled Lunos account is shown and refused in the official
    // desktop app too; a build from source leaves it off.
    LUNOS_OFFICIAL_BUILD: JSON.stringify(process.env.LUNOS_OFFICIAL_BUILD === "1"),
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
