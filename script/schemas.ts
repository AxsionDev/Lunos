#!/usr/bin/env bun

/**
 * XCOD-174: writes the JSON Schemas Lunos files point at into schemas/, so lunos.tech can publish
 * them (synced at a pinned commit, as with the marketplace manifest) instead of upstream hosting
 * them. Wired into script/generate.ts. `--check` exits non-zero when schemas/ is out of date.
 *
 *   config.json, tui.json   generated from ConfigV1.Info and TuiConfig.Info (packages/opencode/script/schema.ts)
 *   theme.json             packages/web/public/theme.json (TUI themes)
 *   desktop-theme.json     packages/ui/src/theme/desktop-theme.schema.json (desktop themes)
 */

import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"

const root = path.resolve(import.meta.dir, "..")
const OUT = path.join(root, "schemas")
export const SCHEMA_BASE = "https://lunos.tech"

/** The published URL of a schema file. */
export const schemaURL = (name: string) => `${SCHEMA_BASE}/${name}`

async function render() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-schemas-"))
  await $`bun script/schema.ts ${path.join(tmp, "config.json")} ${path.join(tmp, "tui.json")}`
    .cwd(path.join(root, "packages/opencode"))
    .quiet()
  const files: Record<string, unknown> = {
    "config.json": await Bun.file(path.join(tmp, "config.json")).json(),
    "tui.json": await Bun.file(path.join(tmp, "tui.json")).json(),
    "theme.json": await Bun.file(path.join(root, "packages/web/public/theme.json")).json(),
    "desktop-theme.json": await Bun.file(path.join(root, "packages/ui/src/theme/desktop-theme.schema.json")).json(),
  }
  await fs.rm(tmp, { recursive: true, force: true })
  // Every schema names its own Lunos URL, so editors and validators resolve it there.
  return Object.fromEntries(
    Object.entries(files).map(([name, schema]) => [
      name,
      JSON.stringify({ ...(schema as object), $id: schemaURL(name) }, null, 2) + "\n",
    ]),
  )
}

if (import.meta.main) {
  const files = await render()
  const check = process.argv.includes("--check")
  let stale = false
  if (!check) await fs.mkdir(OUT, { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(OUT, name)
    const current = await Bun.file(file)
      .text()
      .catch(() => "")
    if (current === text) continue
    stale = true
    if (check) console.error(`schemas: ${path.relative(root, file)} is out of date; run bun script/schemas.ts`)
    else {
      await Bun.write(file, text)
      console.log(`schemas: updated ${path.relative(root, file)}`)
    }
  }
  if (check && stale) process.exit(1)
}
