import { describe, expect, test } from "bun:test"
import {
  allowed,
  ALLOWED,
  bunNotice,
  electronNotice,
  lgplNotice,
  problems,
  render,
  shipped,
  shippedDesktop,
  standardText,
  type Pkg,
} from "../../script/notices"
import { NOT_BUILT, notices } from "../../src/cli/cmd/licenses"

const pkg = (name: string, license: string | undefined, text?: string): Pkg => ({
  name,
  version: "1.0.0",
  license,
  dir: "/x",
  files: text ? [{ name: "LICENSE", text }] : [],
})

describe("licence gate (XCOD-177)", () => {
  test("permissive licences pass; copyleft, source-available and missing ones fail", () => {
    for (const id of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "0BSD", "MIT OR Apache-2.0", "(MIT AND Zlib)"])
      expect(allowed(id), id).toBe(true)
    for (const id of [
      undefined,
      "GPL-3.0-only",
      "AGPL-3.0",
      "LGPL-2.1-or-later",
      "SSPL-1.0",
      "MIT AND GPL-2.0",
      "BUSL-1.1",
    ])
      expect(allowed(id), String(id)).toBe(false)
  })

  test("an OR with a permissive alternative passes", () => {
    expect(allowed("GPL-2.0 OR MIT")).toBe(true)
    expect(allowed("(LGPL-3.0 OR Apache-2.0)")).toBe(true)
  })

  test("an allowlisted package passes only with the licence recorded for it", () => {
    const name = Object.keys(ALLOWED)[0]
    expect(problems([pkg(name, ALLOWED[name].license || undefined)])).toEqual([])
    expect(problems([pkg(name, "GPL-3.0")])).toEqual([`${name}@1.0.0: GPL-3.0`])
  })

  test("every allowlist entry gives a reason", () => {
    for (const [name, entry] of Object.entries(ALLOWED)) expect(entry.reason.length, name).toBeGreaterThan(20)
  })

  test("what the CLI ships today passes the gate", () => {
    const packages = shipped()
    expect(packages.length).toBeGreaterThan(500)
    expect(problems(packages)).toEqual([])
    // Monorepo packages the CLI doesn't depend on, and dev tools, aren't counted as shipped.
    expect(packages.some((item) => item.name === "astro")).toBe(false)
    expect(packages.some((item) => item.name.startsWith("@opencode-ai/"))).toBe(false)
  }, 60_000)
})

describe("notices", () => {
  test("identical licence texts are printed once, listing each package", () => {
    const text = render([pkg("a", "MIT", "MIT text"), pkg("b", "MIT", "MIT text"), pkg("c", "ISC", "ISC text")])
    expect(text.match(/MIT text/g)?.length).toBe(1)
    expect(text).toContain("a@1.0.0 (MIT)\nb@1.0.0 (MIT)")
    expect(text).toContain("ISC text")
  })

  test("a package with no licence file gets the standard text, marked, and no invented copyright", () => {
    const text = render([pkg("bare", "Apache-2.0")])
    expect(text).toContain("bare@1.0.0 (Apache-2.0): ships no licence file; standard Apache-2.0 text")
    expect(text).toContain("[Standard Apache-2.0 text from the SPDX License List]")
    expect(text).toContain("Apache License")
    expect(standardText("MIT OR Apache-2.0")?.id).toBe("MIT")
    expect(standardText("Nonexistent-1.0")).toBeUndefined()
  })

  test("the Bun runtime's licence, with what it statically links, is pinned to the build's Bun", () => {
    const notice = bunNotice()
    expect(notice.title).toContain("the runtime compiled into the lunos binary")
    expect(notice.text).toContain("JavaScriptCore")
  })

  test("the LGPL section pins the exact WebKit and tinycc sources and carries both licence texts", () => {
    const notice = lgplNotice()
    expect(notice.text).toMatch(/github\.com\/oven-sh\/WebKit\/tree\/[0-9a-f]{40}/)
    expect(notice.text).toMatch(/github\.com\/oven-sh\/tinycc\/tree\/[0-9a-f]{40}/)
    expect(notice.text).toContain("GNU LIBRARY GENERAL PUBLIC LICENSE")
    expect(notice.text).toContain("Version 2.1, February 1999")
    expect(notice.text.match(/END OF TERMS AND CONDITIONS/g)).toHaveLength(2)
    expect(notice.text).toContain("https://github.com/AxsionDev/Lunos")
  })

  test("the real notices carry the MIT permission sentence and the Bun section", () => {
    const text = render(shipped(), [bunNotice()])
    expect(text).toContain("Permission is hereby granted, free of charge")
    expect(text).toContain("Bun itself is MIT-licensed")
  }, 60_000)
})

describe("desktop app notices", () => {
  test("cover the renderer's bundled packages and the CLI, without the app's build tools, and pass the gate", () => {
    const packages = shippedDesktop()
    const names = new Set(packages.map((item) => item.name))
    for (const name of ["solid-js", "electron-updater", "effect"]) expect(names.has(name), name).toBe(true)
    // The desktop app's own build tools aren't counted. (Others can still come in as some package's
    // peer dependency; the notices are a superset of what ships, never a subset.)
    for (const name of ["electron-builder", "electron-vite"]) expect(names.has(name), name).toBe(false)
    expect(packages.length).toBeGreaterThan(shipped().length)
    expect(problems(packages)).toEqual([])
    expect(electronNotice().text).toContain("LICENSES.chromium.html")
  }, 60_000)
})

describe("lunos licenses", () => {
  test("from source, says the notices are generated at build time", () => {
    expect(notices()).toBeUndefined()
    expect(NOT_BUILT).toContain("script/notices.ts")
  })
})
