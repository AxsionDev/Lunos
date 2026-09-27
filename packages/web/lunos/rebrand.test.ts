import { describe, expect, test } from "bun:test"
import { dropSections, rebrand } from "./rebrand"

describe("rebrand", () => {
  test("renames the product in prose and the command in code", () => {
    expect(rebrand("OpenCode is great. Run `opencode run hi` in opencode.\n")).toBe(
      "Lunos is great. Run `lunos run hi` in Lunos.\n",
    )
    expect(rebrand("```bash\nopencode --port 4096\n```\n")).toBe("```bash\nlunos --port 4096\n```\n")
    expect(rebrand("Use Scaleway with Opencode:")).toBe("Use Scaleway with Lunos:")
  })

  test("keeps identifiers the binary still reads", () => {
    const kept = [
      "`opencode.json`",
      "opencode.jsonc",
      "`.opencode/plugins/`",
      "~/.config/opencode/opencode.json",
      "~/.local/share/opencode/auth.json",
      "`OPENCODE_CONFIG_DIR`",
      "GITLAB_TOKEN_OPENCODE",
      'import { tool } from "@opencode-ai/plugin"',
      '"$schema": "https://opencode.ai/config.json"',
      "createOpencodeClient",
      "x-opencode-session",
      "ai.opencode.managed",
      ".well-known/opencode",
    ]
    for (const text of kept) expect(rebrand(text)).toBe(text)
  })

  test("keeps third-party names", () => {
    for (const text of ["opencode-wakatime", "opencode.nvim", "https://github.com/HShami/opencode-helicone-session"])
      expect(rebrand(text)).toBe(text)
  })

  test("rewrites install commands to ones that work for Lunos", () => {
    expect(rebrand("```bash\ncurl -fsSL https://opencode.ai/install | bash\n```\n")).toContain(
      "curl -fsSL https://raw.githubusercontent.com/AxsionDev/Lunos/dev/install | bash",
    )
    expect(rebrand("```bash\nnpm install -g opencode-ai\n```\n")).toContain(
      "npm install -g lunos-ai@latest --allow-scripts=lunos-ai",
    )
    expect(rebrand("See [Releases](https://github.com/anomalyco/opencode/releases).")).toBe(
      "See [Releases](https://github.com/AxsionDev/Lunos/releases).",
    )
  })

  test("indented fences in list items are code", () => {
    expect(rebrand("- **Arch**\n\n  ```bash\n  sudo pacman -S opencode\n  ```\n")).toBe(
      "- **Arch**\n\n  ```bash\n  sudo pacman -S lunos\n  ```\n",
    )
  })

  test("never invents a Lunos domain from an upstream opencode.ai URL", () => {
    expect(rebrand("head to [opencode.ai/auth](https://opencode.ai/auth)")).toBe(
      "head to [opencode.ai/auth](https://opencode.ai/auth)",
    )
  })

  test("frontmatter titles are prose", () => {
    expect(rebrand("---\ntitle: OpenCode CLI\ndescription: Use opencode.\n---\n\nBody\n")).toBe(
      "---\ntitle: Lunos CLI\ndescription: Use Lunos.\n---\n\nBody\n",
    )
  })

  test("a config example keeps its keys and schema", () => {
    const json =
      '```json title="opencode.json"\n{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "anthropic/x"\n}\n```\n'
    expect(rebrand(json)).toBe(json)
  })
})

describe("dropSections", () => {
  const page = "# Page\n\nIntro\n\n## OpenCode Zen\n\nZen text\n\n### Sub\n\nmore\n\n## Directory\n\nKeep\n"

  test("removes a section and its subsections, up to the next same-level heading", () => {
    expect(dropSections(page, ["OpenCode Zen"])).toBe("# Page\n\nIntro\n\n## Directory\n\nKeep\n")
  })

  test("fails loudly when upstream renames the heading", () => {
    expect(() => dropSections(page, ["OpenCode Go"])).toThrow('heading "OpenCode Go" not found')
  })
})
