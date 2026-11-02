import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { Effect } from "effect"
import type { Argv } from "yargs"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { AgentEdit } from "@/agent/edit"
import { AgentFile } from "@/agent/file"

// XCOD-210: `lunos agent edit`. With flags it changes those fields; without, it opens the agent's
// file in $VISUAL/$EDITOR. Either way the result is checked against what exists here (models,
// tools, skills, MCP servers) and nothing is written if anything is wrong.

const ACTIONS = ["allow", "ask", "deny"] as const

/** `bash=ask,webfetch=deny` (or `github` for `--mcp`) as a map of rules. */
function rules(value: string | undefined, flag: string): Record<string, AgentEdit.Action> | undefined {
  if (!value) return undefined
  const out: Record<string, AgentEdit.Action> = {}
  for (const item of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [key, action = "allow"] = item.split("=")
    if (!(ACTIONS as readonly string[]).includes(action))
      throw new Error(`--${flag} ${item}: the action must be allow, ask or deny`)
    out[key] = action as AgentEdit.Action
  }
  return out
}

async function editInEditor(file: string) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) return undefined
  // Edit a copy, so a save that doesn't validate never touches the agent's file.
  const copy = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-agent-")), path.basename(file))
  await fs.copyFile(file, copy)
  try {
    await new Promise<void>((resolve, reject) => {
      const parts = editor.split(" ")
      const child = spawn(parts[0]!, [...parts.slice(1), copy], {
        stdio: "inherit",
        shell: process.platform === "win32",
      })
      child.on("error", reject)
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${editor} exited with code ${code}`))))
    })
    return await fs.readFile(copy, "utf8")
  } finally {
    await fs.rm(path.dirname(copy), { recursive: true, force: true })
  }
}

export const AgentEditCommand = effectCmd({
  command: "edit <name>",
  describe: "change an agent: its prompt, model, permissions, skills, MCP servers and limits",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", { type: "string", demandOption: true, describe: "agent to edit" })
      .option("description", { type: "string", describe: "when to use the agent" })
      .option("prompt-file", { type: "string", describe: "file whose text becomes the agent's prompt" })
      .option("model", { type: "string", describe: 'provider/model, or "" to use the default model' })
      .option("mode", {
        type: "string",
        choices: ["primary", "subagent", "all"] as const,
        describe: "where the agent can be used",
      })
      .option("steps", { type: "number", describe: "step limit (0 removes it)" })
      .option("hidden", { type: "boolean", describe: "hide a subagent from the @ menu" })
      .option("permission", { type: "string", describe: "permission rules, e.g. bash=ask,webfetch=deny" })
      .option("skill", { type: "string", describe: "skills it may load, e.g. code-review or code-review=deny" })
      .option("mcp", { type: "string", describe: "MCP servers whose tools it may use, e.g. github or github=ask" }),
  handler: Effect.fn("Cli.agent.edit")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { AgentEditHere } = yield* Effect.promise(() => import("@/agent/edit-here"))
    const name = String(args.name)

    const config = yield* Config.Service.use((cfg) => cfg.get())
    const file = yield* AgentEditHere.file(name)
    if (!file) {
      if (config.agent?.[name])
        return yield* fail(`${name} is defined in a JSON config file, not an agent file; edit it there`)
      return yield* fail(`No agent file for "${name}". Built-in agents can't be edited; see \`lunos agent create\`.`)
    }

    const flagged = [
      "description",
      "prompt-file",
      "model",
      "mode",
      "steps",
      "hidden",
      "permission",
      "skill",
      "mcp",
    ].some((flag) => args[flag as keyof typeof args] !== undefined)

    // Builds the new definition (from the flags, or from the edited file), without writing it.
    const next = yield* Effect.promise(
      async (): Promise<{ doc: AgentFile.Doc } | { text: string } | { error: string }> => {
        if (flagged) {
          const current = await AgentFile.read(file)
          return {
            doc: AgentEdit.change(current, {
              description: args.description,
              prompt: args["prompt-file"]
                ? (await fs.readFile(path.resolve(args["prompt-file"]), "utf8")).trim()
                : undefined,
              model: args.model === undefined ? undefined : args.model === "" ? null : args.model,
              mode: args.mode as AgentEdit.Changes["mode"],
              steps: args.steps === undefined ? undefined : args.steps === 0 ? null : args.steps,
              hidden: args.hidden,
              permission: rules(args.permission, "permission"),
              skills: rules(args.skill, "skill"),
              mcp: rules(args.mcp, "mcp"),
            }),
          }
        }
        if (!process.stdin.isTTY)
          return { error: "Pass the fields to change (see --help), or run in a terminal to edit the file" }
        const text = await editInEditor(file)
        if (text === undefined)
          return { error: "Set $EDITOR (or $VISUAL) to edit the file, or pass the fields to change" }
        return { text }
      },
    ).pipe(Effect.catchDefect((error) => fail(error instanceof Error ? error.message : String(error))))
    if ("error" in next) return yield* fail(next.error)

    const saved =
      "doc" in next ? yield* AgentEditHere.save(file, next.doc) : yield* AgentEditHere.saveText(file, next.text)
    if (!saved.ok) return yield* fail(`Not saved:\n${saved.problems.map((problem) => `  - ${problem}`).join("\n")}`)
    UI.println(`Saved ${name}: ${saved.file}`)
  }),
})
