#!/usr/bin/env bun

// XCOD-177: third-party licence notices for what the CLI ships, and the licence gate.
//
//   bun script/notices.ts [--output <file>]   write THIRD_PARTY_NOTICES (default: ./THIRD_PARTY_NOTICES)
//   bun script/notices.ts --check             fail on a shipped package whose licence isn't allowed
//
// What ships: the compiled binary can only contain code reachable from packages/opencode's
// production dependencies, so the set is that tree, followed through the workspace packages it
// depends on (core, tui, ...) and resolved the way Bun resolves it (each package's node_modules,
// then its parents'). Dev dependencies, and monorepo packages the CLI doesn't depend on (console,
// web, desktop), are left out. It is a superset of what the bundler keeps after tree-shaking, so a
// notice may name a package the binary doesn't end up using; never the other way round.
//
// Licence texts are each package's own LICENSE / LICENCE / COPYING / NOTICE files, copied as they
// are. A package that ships none gets its declared SPDX id and a link to the standard text, marked
// as such; no copyright holder is ever invented. The Bun runtime compiled into every binary is
// added from script/notices/bun-LICENSE.md, pinned to package.json's Bun version.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs"
import path from "path"

const opencode = path.resolve(import.meta.dir, "..")
const root = path.resolve(opencode, "../..")

export type Pkg = {
  name: string
  version: string
  license?: string
  dir: string
  files: { name: string; text: string }[]
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i

/** The directory of `name` as seen from `from`, following Node/Bun resolution up the tree. */
export function resolvePackage(name: string, from: string) {
  let dir = from
  while (true) {
    const candidate = path.join(dir, "node_modules", name, "package.json")
    if (existsSync(candidate)) return realpathSync(path.dirname(candidate))
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function declared(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const ids = value.map(declared).filter(Boolean)
    return ids.length ? ids.map((id) => (ids.length > 1 ? `(${id})` : id)).join(" OR ") : undefined
  }
  if (value && typeof value === "object" && "type" in value) return String((value as { type: unknown }).type)
}

function licenceFiles(dir: string) {
  return readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name) && statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n").trim() }))
}

/** devDependencies that build or test the desktop app and are not part of it. */
const BUILD_ONLY =
  /^(@types\/|@typescript\/|typescript$|vite$|electron-vite$|electron-builder$|electron$|@sentry\/vite-plugin$|@actions\/|@valibot\/to-json-schema$|zod-openapi$)/

export const desktop = path.resolve(opencode, "../desktop")
const app = path.resolve(opencode, "../app")
const ui = path.resolve(opencode, "../ui")

/** What the desktop app ships: its own code and renderer, and the CLI it runs as a Node sidecar. */
export function shippedDesktop() {
  return shipped([desktop, opencode], [desktop, app, ui])
}

/**
 * Electron's own licences. electron-builder packages Electron's LICENSE and the Chromium licence
 * file (LICENSES.chromium.html) with every desktop build, next to the executable.
 */
export function electronNotice() {
  const version = readJson(path.join(desktop, "package.json")).devDependencies.electron
  return {
    title: `Electron ${version} and Chromium (the desktop app's runtime)`,
    text: [
      "Electron is MIT-licensed. Its LICENSE file and the licences of Chromium and the other software",
      "Electron includes (LICENSES.chromium.html) are shipped with the app, next to its executable",
      "(on macOS, inside Lunos.app/Contents/Frameworks/Electron Framework.framework/Resources).",
    ].join("\n"),
  }
}

const isWorkspace = (dir: string) =>
  dir.startsWith(root + path.sep) && !dir.includes(`${path.sep}node_modules${path.sep}`)

/** Every third-party package the CLI can ship, sorted by name and version. */
export function shipped(starts = [opencode], bundled: string[] = []) {
  const seen = new Map<string, Pkg>()
  const visited = new Set<string>()
  const queue = [...starts]
  while (queue.length) {
    const dir = queue.shift()!
    if (visited.has(dir)) continue
    visited.add(dir)
    const pkg = readJson(path.join(dir, "package.json"))
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies }
    // A workspace whose devDependencies are bundled into what ships (the desktop app's renderer is
    // built by Vite from them), minus the tools that only build it.
    if (bundled.includes(dir))
      for (const name of Object.keys(pkg.devDependencies ?? {}))
        if (!BUILD_ONLY.test(name)) deps[name] ??= pkg.devDependencies[name]
    // A peer dependency is only shipped when something installed it; resolve it if present.
    for (const name of Object.keys(pkg.peerDependencies ?? {})) deps[name] ??= "peer"
    for (const name of Object.keys(deps)) {
      const found = resolvePackage(name, dir)
      if (!found) continue // an optional or peer dependency for another platform, not installed here
      queue.push(found)
    }
    if (isWorkspace(dir)) continue // Lunos's own packages: covered by the root LICENSE
    const key = `${pkg.name}@${pkg.version}`
    if (!seen.has(key))
      seen.set(key, {
        name: pkg.name,
        version: pkg.version,
        license: declared(pkg.license ?? pkg.licenses),
        dir,
        files: licenceFiles(dir),
      })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

// --- licence gate ---------------------------------------------------------------------------------

/** Copyleft or source-available licences a shipped package may not use without a reviewed reason. */
const DENIED = /(^|[^A-Z])(A?GPL|LGPL|SSPL|EUPL|OSL|CC-BY-NC|BUSL|Elastic)/i

/**
 * Packages allowed despite their licence, each with the reason it was accepted. Keyed by name; the
 * gate fails again if the package's licence changes from the one recorded here.
 */
export const ALLOWED: Record<string, { license: string; reason: string }> = {
  // No licence declared in package.json, but MIT where the package comes from (checked 2026-10-03).
  "seq-queue": { license: "", reason: "the package's own LICENSE file is MIT (Netease, Inc.); via mysql2" },
  "@openauthjs/openauth": {
    license: "",
    reason: "MIT: github.com/toolbeam/openauth LICENSE (Copyright (c) 2024 SST); the npm package ships no licence file",
  },
  "poe-oauth": {
    license: "",
    reason:
      "MIT: github.com/poe-platform/poe-code packages/poe-oauth/LICENSE (Copyright (c) 2026 Poe Platform); via opencode-poe-auth",
  },
}

/** An SPDX expression passes if any `OR` alternative contains no denied licence. */
export function allowed(expression: string | undefined) {
  if (!expression) return false
  const alternatives = expression
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/i)
    .map((item) => item.trim())
  return alternatives.some((alternative) => !DENIED.test(alternative))
}

export function problems(packages: Pkg[]) {
  const out: string[] = []
  for (const pkg of packages) {
    if (allowed(pkg.license)) continue
    const entry = ALLOWED[pkg.name]
    if (entry && entry.license === (pkg.license ?? "")) continue
    out.push(`${pkg.name}@${pkg.version}: ${pkg.license ?? "no licence declared"}`)
  }
  return out
}

// --- notices --------------------------------------------------------------------------------------

const SPDX_DIR = path.join(opencode, "script/notices/spdx")

/**
 * The standard text of a declared licence, for a package that ships no licence file: the SPDX
 * License List text (script/notices/spdx, v3.27.0). For "A OR B", the first alternative with a text.
 */
export function standardText(license: string | undefined) {
  if (!license) return undefined
  const ids = license
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/i)
    .map((id) => id.trim())
  for (const id of ids) {
    const file = readdirSync(SPDX_DIR).find((name) => name.toLowerCase() === `${id.toLowerCase()}.txt`)
    if (file) return { id: file.replace(/\.txt$/, ""), text: readFileSync(path.join(SPDX_DIR, file), "utf8").trim() }
  }
}

export function render(packages: Pkg[], extra: { title: string; text: string }[] = []) {
  const header = [
    "THIRD-PARTY NOTICES",
    "",
    "Lunos is distributed by ITService EOOD under the MIT licence (see LICENSE).",
    "It includes the third-party software listed below, each under its own licence.",
    "Generated from the packages the CLI ships (packages/opencode/script/notices.ts); not edited by hand.",
    "",
  ]
  // Identical licence texts are printed once, listing every package they apply to.
  const groups = new Map<string, { packages: string[]; text: string }>()
  const add = (label: string, text: string) => {
    const group = groups.get(text) ?? { packages: [], text }
    group.packages.push(label)
    groups.set(text, group)
  }
  const unknown: string[] = []
  for (const pkg of packages) {
    const label = `${pkg.name}@${pkg.version} (${pkg.license ?? "no licence declared"})`
    if (pkg.files.length) {
      add(
        label,
        pkg.files.map((file) => (pkg.files.length > 1 ? `--- ${file.name} ---\n${file.text}` : file.text)).join("\n\n"),
      )
      continue
    }
    // No licence file: the standard text, marked as such. No copyright line is added, because the
    // package states none.
    const standard = standardText(pkg.license ?? ALLOWED[pkg.name]?.reason.match(/^MIT\b/)?.[0])
    if (standard)
      add(
        `${label}: ships no licence file; standard ${standard.id} text`,
        `[Standard ${standard.id} text from the SPDX License List]\n\n${standard.text}`,
      )
    else unknown.push(`${label}: ships no licence file, and no standard text is known for its licence`)
  }
  const rule = "=".repeat(80)
  const sections = [
    ...extra.map((item) => [rule, item.title, rule, "", item.text.trim()].join("\n")),
    ...[...groups.values()].map((group) => [rule, ...group.packages, rule, "", group.text].join("\n")),
  ]
  if (unknown.length) sections.push([rule, "Packages with no licence text", rule, "", ...unknown].join("\n"))
  return [...header, ...sections].join("\n") + "\n"
}

/** Bun's own licence, which also lists what Bun statically links. Pinned to the Bun the release builds with. */
export function bunNotice() {
  const version = readJson(path.join(root, "package.json")).packageManager.replace(/^bun@/, "")
  const file = path.join(opencode, "script/notices/bun-LICENSE.md")
  const text = readFileSync(file, "utf8")
  const pinned = text.match(/^<!-- bun v([\d.]+) -->/)?.[1]
  if (pinned !== version)
    throw new Error(`notices: ${file} is for Bun ${pinned}, the build uses ${version}; refresh it`)
  return {
    title: `Bun ${version} (the runtime compiled into the lunos binary)`,
    text: text.replace(/^<!--.*-->\n/, ""),
  }
}

if (import.meta.main) {
  // --desktop: the desktop app's notices (packages/desktop's prebuild), otherwise the CLI's.
  const isDesktop = process.argv.includes("--desktop")
  const packages = isDesktop ? shippedDesktop() : shipped()
  if (process.argv.includes("--check")) {
    const found = problems(packages)
    console.log(`licences: ${packages.length} shipped packages checked`)
    if (found.length) {
      console.error(
        `licences: ${found.length} not allowed (add to ALLOWED in script/notices.ts with a reason, or drop the dependency):`,
      )
      for (const line of found) console.error(`  - ${line}`)
      process.exit(1)
    }
  } else {
    const index = process.argv.indexOf("--output")
    const out = index === -1 ? path.join(opencode, "THIRD_PARTY_NOTICES") : path.resolve(process.argv[index + 1])
    await Bun.write(out, render(packages, isDesktop ? [electronNotice()] : [bunNotice()]))
    console.log(`notices: ${packages.length} packages -> ${out}`)
  }
}
