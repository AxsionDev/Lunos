import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { SandboxDocker } from "./docker"
import { SandboxExec } from "./exec"

// XCOD-344: a project's build and tests need its toolchain in the sandbox image. Lunos's own image
// has git, Node.js, npm and Python; anything else (or a sandbox.image without them) needs a
// devcontainer or another image. This finds what the project needs and what the image lacks, so the
// sandbox can say so at start and in `lunos sandbox doctor`, instead of the agent's checks failing.

export type Need = { tool: string; because: string }

/** Marker files at the project root, and the commands they mean the agent will run. */
const MARKERS: { files: string[]; tools: string[] }[] = [
  { files: ["package.json"], tools: ["node", "npm"] },
  { files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], tools: ["python3"] },
  { files: ["go.mod"], tools: ["go"] },
  { files: ["Cargo.toml"], tools: ["cargo"] },
  { files: ["Gemfile"], tools: ["ruby"] },
  { files: ["pom.xml", "build.gradle", "build.gradle.kts"], tools: ["java"] },
  { files: ["composer.json"], tools: ["php"] },
]
const DOTNET = /\.(sln|csproj|fsproj)$/

/** The commands the project at `root` needs, with the file that says so. */
export function needed(root: string): Need[] {
  const needs: Need[] = []
  for (const marker of MARKERS) {
    const file = marker.files.find((name) => existsSync(path.join(root, name)))
    if (file) for (const tool of marker.tools) needs.push({ tool, because: file })
  }
  // bun.lock / bun.lockb: the project runs on Bun, not (only) Node.
  const bunLock = ["bun.lock", "bun.lockb"].find((name) => existsSync(path.join(root, name)))
  if (bunLock) needs.push({ tool: "bun", because: bunLock })
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {}
  const dotnet = entries.find((name) => DOTNET.test(name))
  if (dotnet) needs.push({ tool: "dotnet", because: dotnet })
  return needs
}

/** A shell line printing each tool that isn't on PATH, one per line. Tool names are from MARKERS only. */
export function probe(tools: readonly string[]) {
  return `for t in ${tools.join(" ")}; do command -v "$t" >/dev/null 2>&1 || echo "$t"; done; true`
}

/** The tools of `needs` the image can't run, or undefined when the image couldn't be checked. */
export async function missing(ref: string, needs: readonly Need[], timeout = 30_000) {
  const tools = [...new Set(needs.map((need) => need.tool))]
  if (tools.length === 0) return []
  const command = [
    SandboxDocker.bin(),
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    SandboxDocker.UID,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--entrypoint",
    "/bin/sh",
    ref,
    "-c",
    probe(tools),
  ]
  const result = await SandboxExec.run(command, { timeout }).catch(() => undefined)
  if (!result || result.code !== 0 || result.timedOut) return undefined
  const absent = new Set(result.stdout.split("\n").map((line) => line.trim()))
  return needs.filter((need) => absent.has(need.tool))
}

/** What to tell the user about the missing tools, or undefined when nothing's missing. */
export function message(absent: readonly Need[]) {
  if (absent.length === 0) return undefined
  const byFile = new Map<string, string[]>()
  for (const need of absent) byFile.set(need.because, [...(byFile.get(need.because) ?? []), need.tool])
  const list = [...byFile].map(([file, tools]) => `${tools.join(" and ")} (for ${file})`).join(", ")
  return (
    `No ${list} in the sandbox image, so the agent can't build or test this project there. ` +
    `Add a .devcontainer, or set sandbox.image to an image that has ${absent.length === 1 ? "it" : "them"}.`
  )
}

export * as SandboxToolchain from "./toolchain"
