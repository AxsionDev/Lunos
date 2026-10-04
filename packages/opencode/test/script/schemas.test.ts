import { describe, expect, test } from "bun:test"
import path from "path"
import { $ } from "bun"

// XCOD-174: schemas/ is what lunos.tech publishes at the $schema URLs Lunos writes. It must match
// the source (ConfigV1.Info, TuiConfig.Info and the theme schemas), and each schema names its URL.
const root = path.resolve(import.meta.dir, "../../../..")

describe("published schemas", () => {
  test("schemas/ is up to date with the source", async () => {
    const result = await $`bun script/schemas.ts --check`.cwd(root).quiet().nothrow()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  })

  test("each schema's $id is its lunos.tech URL", async () => {
    for (const name of ["config.json", "tui.json", "theme.json", "desktop-theme.json"]) {
      const schema = await Bun.file(path.join(root, "schemas", name)).json()
      expect(schema.$id).toBe(`https://lunos.tech/${name}`)
    }
  })

  test("the config schema covers the Lunos-only keys", async () => {
    const schema = await Bun.file(path.join(root, "schemas/config.json")).json()
    const keys = Object.keys(schema.$defs.Config.properties)
    for (const key of ["sandbox", "residency", "memory", "audit", "hooks"]) expect(keys).toContain(key)
  })
})
