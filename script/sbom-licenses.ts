#!/usr/bin/env bun
// XCOD-108 (the XCOD-64 gap): syft reads bun.lock for the component list but bun.lock carries no
// licences, so the release SBOM had none. After `bun install`, every package's own package.json is
// in bun's store (node_modules/.bun/<name>@<version>[+hash]/node_modules/<name>/package.json);
// this adds each component's declared licence from there, as a CycloneDX license entry.
//
//   bun script/sbom-licenses.ts <sbom.cdx.json>        (rewrites the file in place)
//
// A component whose package.json is missing or declares no licence is left without one and
// counted, never guessed.

import { readdirSync } from "fs"
import path from "path"

type License = { license: { id?: string; name?: string } } | { expression: string }
type Component = { name?: string; group?: string; version?: string; purl?: string; licenses?: License[] }

// SPDX expressions ("MIT OR Apache-2.0") go in `expression`; single ids in `license.id`; anything
// else (legacy "SEE LICENSE IN …", objects) in `license.name`.
export function toCycloneDx(declared: unknown): License[] | undefined {
  const one = (value: unknown): string | undefined =>
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "type" in value
        ? String((value as { type: unknown }).type)
        : undefined
  const list = Array.isArray(declared) ? declared.map(one).filter(Boolean) : [one(declared)].filter(Boolean)
  if (!list.length) return undefined
  if (list.length > 1) return [{ expression: list.map((item) => `(${item})`).join(" OR ") }]
  const value = list[0]!
  if (/\s(OR|AND|WITH)\s/.test(value) || value.startsWith("(")) return [{ expression: value }]
  if (/^[A-Za-z0-9.+-]+$/.test(value)) return [{ license: { id: value } }]
  return [{ license: { name: value } }]
}

/** name@version -> package.json path, from bun's store directory names. */
export function storeIndex(root: string) {
  const store = path.join(root, "node_modules", ".bun")
  const index = new Map<string, string>()
  for (const dir of readdirSync(store)) {
    const at = dir.lastIndexOf("@")
    if (at <= 0) continue
    const name = dir.slice(0, at).replace("+", "/")
    const version = dir.slice(at + 1).split("+")[0]
    index.set(`${name}@${version}`, path.join(store, dir, "node_modules", name, "package.json"))
  }
  return index
}

export function key(component: Component) {
  if (component.purl?.startsWith("pkg:npm/")) {
    const body = decodeURIComponent(component.purl.slice("pkg:npm/".length)).split("?")[0]
    return body
  }
  const name = component.group ? `${component.group}/${component.name}` : component.name
  return `${name}@${component.version}`
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file) throw new Error("usage: sbom-licenses.ts <sbom.cdx.json>")
  const sbom = await Bun.file(file).json()
  const index = storeIndex(process.cwd())
  const registry = (process.env.npm_config_registry ?? "https://registry.npmjs.org").replace(/\/$/, "")
  let fromStore = 0
  let fromRegistry = 0
  const missing: string[] = []
  const pending = ((sbom.components ?? []) as Component[]).filter((component) => !component.licenses?.length)
  // Packages for other platforms (optional dependencies) aren't installed on the runner; for those
  // the licence comes from the registry's metadata for the exact version.
  const fromNpm = async (id: string) => {
    const at = id.lastIndexOf("@")
    const url = `${registry}/${id.slice(0, at).replace("/", "%2F")}/${encodeURIComponent(id.slice(at + 1))}`
    const response = await fetch(url).catch(() => undefined)
    return response?.ok ? await response.json().catch(() => undefined) : undefined
  }
  for (let i = 0; i < pending.length; i += 16) {
    await Promise.all(
      pending.slice(i, i + 16).map(async (component) => {
        const id = key(component)
        const manifest = index.get(id)
        let pkg = manifest
          ? await Bun.file(manifest)
              .json()
              .catch(() => undefined)
          : undefined
        let licenses = toCycloneDx(pkg?.license ?? pkg?.licenses)
        if (licenses) fromStore++
        else if (!manifest) {
          pkg = await fromNpm(id)
          licenses = toCycloneDx(pkg?.license ?? pkg?.licenses)
          if (licenses) fromRegistry++
        }
        if (licenses) component.licenses = licenses
        else missing.push(id)
      }),
    )
  }
  await Bun.write(file, JSON.stringify(sbom))
  console.log(
    `licences added: ${fromStore} from installed packages, ${fromRegistry} from the registry; ` +
      `${missing.length} components declare none${missing.length ? `: ${missing.join(", ")}` : ""}`,
  )
}
