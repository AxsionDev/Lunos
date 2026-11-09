#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

// The desktop app runs this bundle in Electron's Node, which can't load bun: modules: one static
// `import ... from "bun:ffi"` (computer control, XCOD-339) and the whole server fails to start.
// Computer control binds system libraries through bun:ffi, so in this bundle it gets a stand-in
// that refuses when first used; the rest of the server loads.
const bunFfiStub: import("bun").BunPlugin = {
  name: "bun-ffi-stub",
  setup(build) {
    build.onResolve({ filter: /^bun:ffi$/ }, () => ({ path: "bun:ffi", namespace: "bun-ffi-stub" }))
    build.onLoad({ filter: /.*/, namespace: "bun-ffi-stub" }, () => ({
      loader: "js",
      contents: `const unavailable = () => { throw new Error("Computer control isn't available in the desktop app's built-in server; use the Lunos CLI.") }
export const dlopen = unavailable
export const ptr = unavailable
export const CString = unavailable
export const FFIType = new Proxy({}, { get: (_, key) => key })
`,
    }))
  },
}

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  plugins: [bunFfiStub],
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

// Guard: Node rejects any bun: import at load time, before a line of the server runs.
const output = await Bun.file("./dist/node/node.js").text()
const bunImports = output.match(/^import\s[^;]*?from\s*["']bun:[^"']+["']/gm) ?? []
if (bunImports.length > 0) {
  console.error(`dist/node/node.js imports bun: modules, which Node can't load:\n${bunImports.join("\n")}`)
  process.exit(1)
}

console.log("Build complete")
