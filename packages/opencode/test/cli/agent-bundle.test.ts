import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { AgentBundle } from "@/agent/bundle"
import { cliIt } from "../lib/cli-process"

// XCOD-209: `lunos agent export` / `lunos agent import`, through the CLI itself.

const SECRET = "ghp_cli_secret_0123456789"
void AgentBundle // loads zip.js with web workers off, like the CLI

async function unpacked(file: string) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await fs.readFile(file))))
  const out: string[] = []
  for (const entry of await reader.getEntries())
    if (!entry.directory) out.push(new TextDecoder().decode(await entry.getData!(new Uint8ArrayWriter())))
  await reader.close()
  return out.join("\n")
}

describe("lunos agent export / import (subprocess)", () => {
  cliIt.live(
    "exports without secrets; import previews, refuses without a TTY, writes nothing on --dry-run, then imports",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const config = path.join(home, ".config", "opencode")
        const bundle = path.join(home, "reviewer.lunos-agent")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(config, "agents"), { recursive: true })
          await fs.writeFile(
            path.join(config, "agents", "reviewer.md"),
            "---\ndescription: Reviews code\nmode: subagent\npermission:\n  bash: allow\n  github_search: allow\n---\nReview the change.\n",
          )
          await fs.writeFile(
            path.join(config, "opencode.json"),
            JSON.stringify({
              mcp: { github: { type: "local", command: ["gh-mcp"], environment: { GITHUB_TOKEN: SECRET } } },
            }),
          )
        })

        const exported = yield* opencode.spawn(["agent", "export", "reviewer", "-o", bundle])
        opencode.expectExit(exported, 0, "export")
        // The agent's permissions name github_search, so the github server came along, by name only.
        expect(exported.stdout + exported.stderr).toContain("MCP servers: github")
        const contents = yield* Effect.promise(() => unpacked(bundle))
        expect(contents).toContain("GITHUB_TOKEN")
        expect(contents).not.toContain(SECRET)

        // No TTY and no --yes: refused, nothing written.
        const noTty = yield* opencode.spawn(["agent", "import", bundle, "--name", "copy"])
        expect(noTty.exitCode).not.toBe(0)
        expect(noTty.stdout + noTty.stderr).toContain("--yes")

        const dry = yield* opencode.spawn(["agent", "import", bundle, "--name", "copy", "--dry-run"])
        opencode.expectExit(dry, 0, "dry run")
        expect(dry.stdout + dry.stderr).toContain("bash changed from allow to ask")
        expect(dry.stdout + dry.stderr).toContain("MCP server github (already configured here, kept as is)")
        expect(dry.stdout + dry.stderr).toContain("Nothing in the agent runs at import time")
        const exists = (file: string) =>
          fs.stat(file).then(
            () => true,
            () => false,
          )
        expect(yield* Effect.promise(() => exists(path.join(config, "agents", "copy.md")))).toBe(false)

        // The bundle's own name clashes with the existing agent.
        const clash = yield* opencode.spawn(["agent", "import", bundle, "--yes"])
        expect(clash.exitCode).not.toBe(0)
        expect(clash.stdout + clash.stderr).toContain("--name")

        opencode.expectExit(yield* opencode.spawn(["agent", "import", bundle, "--name", "copy", "--yes"]), 0, "import")
        const written = yield* Effect.promise(() => fs.readFile(path.join(config, "agents", "copy.md"), "utf8"))
        expect(written).toContain("Review the change.")
        expect(written).toMatch(/bash:\s+'\*': ask/)
        const listed = yield* opencode.spawn(["agent", "list"])
        expect(listed.stdout).toContain("copy (subagent)")
      }),
    120_000,
  )

  cliIt.live(
    "a Claude Code subagent file imports with a report of unmapped fields",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const file = path.join(home, "helper.md")
        yield* Effect.promise(() =>
          fs.writeFile(
            file,
            "---\nname: helper\ndescription: Helps\ntools: Read, Grep\nmodel: sonnet\n---\nYou help.\n",
          ),
        )
        const result = yield* opencode.spawn(["agent", "import", file, "--yes"])
        opencode.expectExit(result, 0, "claude import")
        expect(result.stdout + result.stderr).toContain("Claude Code fields mapped: name, description, tools")
        expect(result.stdout + result.stderr).toContain('model ("sonnet": no Lunos equivalent, left unset)')
      }),
    60_000,
  )

  cliIt.live(
    "an organisation that locks agent_import: false refuses imports",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const managed = path.join(home, "managed")
        const file = path.join(home, "helper.md")
        yield* Effect.promise(async () => {
          await fs.mkdir(managed, { recursive: true })
          await fs.writeFile(
            path.join(managed, "managed.json"),
            JSON.stringify({ $locked: ["agent_import"], agent_import: false }),
          )
          await fs.writeFile(file, "---\nname: helper\ndescription: Helps\n---\nYou help.\n")
        })
        const result = yield* opencode.spawn(["agent", "import", file, "--yes"], {
          env: { OPENCODE_TEST_MANAGED_CONFIG_DIR: managed },
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("Importing agents is turned off")
      }),
    60_000,
  )
})
