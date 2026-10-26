import { describe, expect, test } from "bun:test"
import path from "path"
import { $ } from "bun"

// XCOD-174: no default code path may contact upstream's US-hosted services. This fails if the
// upstream domain appears in tracked source outside the allowlist below, so a weekly upstream merge
// (XCOD-118) that brings a new call or link back is caught here. Each entry says why it may stay.
const root = path.resolve(import.meta.dir, "../../..")
// Built from parts so this file doesn't match its own pattern.
const DOMAIN = ["opencode", "ai"].join(".")
const PATTERN = new RegExp(`\\b${DOMAIN.replace(".", "\\.")}\\b`)

/** Path prefixes allowed to mention the domain, with the reason. */
export const ALLOWED: Record<string, string> = {
  // Upstream packages Lunos doesn't build or ship.
  "packages/console/": "upstream's hosted console and Zen gateway; not built or shipped by Lunos",
  "packages/stats/": "upstream's stats site; not built or shipped by Lunos",
  "packages/enterprise/": "upstream's enterprise share site; not built or shipped by Lunos",
  "github/index.ts": "upstream's older standalone action script; github/action.yml doesn't run it",
  // Docs: sources stay as upstream wrote them; the built site is checked instead.
  "packages/web/src/":
    "upstream docs sources and site components; lunos/rebrand.ts rewrites the English pages at build time and lunos/check-built.ts fails a built page that still links upstream",
  // Upstream translations of the removed OpenCode Zen sign-up pitch; the keys are no longer used.
  "packages/app/src/i18n/": "unused upstream translations of the OpenCode Zen pitch removed from the connect dialog",
  "packages/tui/src/component/dialog-retry-action.tsx":
    "the Go-plan styling is dead: session/retry.ts no longer produces Go links",
  // Only reached with an OpenCode key the user adds themselves.
  "packages/core/src/plugin/provider/opencode.ts":
    "the opencode provider's config server, used only with an OpenCode key the user adds; it isn't listed otherwise",
  // Test fixtures that need an external-looking URL.
  "packages/desktop/src/main/external-url.test.ts": "test fixture",
  "packages/session-ui/src/components/markdown-inline-code-kind.test.ts": "test fixture",
  "packages/ui/src/context/marked-parser.test.ts": "test fixture",
}

const SCANNED = /^(packages\/[^/]+\/(?:[^/]+\/)?src\/|github\/)/

async function offenders() {
  const files = (await $`git ls-files -z`.cwd(root).text()).split("\0").filter((file) => SCANNED.test(file))
  const hits: string[] = []
  for (const file of files) {
    if (Object.keys(ALLOWED).some((prefix) => file.startsWith(prefix))) continue
    const text = await Bun.file(path.join(root, file))
      .text()
      .catch(() => "")
    if (PATTERN.test(text)) hits.push(file)
  }
  return hits
}

describe("upstream services", () => {
  test(`no source outside the allowlist mentions ${DOMAIN}`, async () => {
    const hits = await offenders()
    expect(hits, `remove the ${DOMAIN} call or link, or add the file to ALLOWED with the reason`).toEqual([])
  })

  test("every allowlist entry still matches a tracked file", async () => {
    const files = (await $`git ls-files -z`.cwd(root).text()).split("\0")
    for (const prefix of Object.keys(ALLOWED)) {
      expect(
        files.some((file) => file.startsWith(prefix)),
        `${prefix} no longer exists; drop it from ALLOWED`,
      ).toBe(true)
    }
  })
})
