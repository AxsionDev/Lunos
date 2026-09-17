import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import matter from "gray-matter"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"

type AgentMode = "all" | "primary" | "subagent"

// Permission keys (not raw tool names). Multiple tools can map to a single
// permission — e.g. write/edit/apply_patch all gate on `edit` — so we configure
// agents at the permission level to match how the runtime actually enforces it.
export const AVAILABLE_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
]

// Permissions that let an agent change the world rather than observe it. `task`
// counts because a subagent spawned with its own `edit`/`bash` grant is a
// trivial way around a restriction placed on the parent.
export const HIGH_RISK_PERMISSIONS = ["bash", "edit", "task"]

// Opt-in, not opt-out: an agent starts with the observe-only permissions and the
// user has to actively grant anything that can mutate state.
export const DEFAULT_ALLOWED_PERMISSIONS = AVAILABLE_PERMISSIONS.filter(
  (permission) => !HIGH_RISK_PERMISSIONS.includes(permission),
)

// Language that reads as "this agent only looks, it doesn't build". Used to warn
// when a description like this is paired with mutating permissions — the
// generated system prompt has no bearing on what the runtime actually allows.
const RESTRICTED_INTENT_PATTERNS = [
  /\bresearch(?:es|ing)?\b/i,
  /\binvestigat(?:e|es|ing|ion)\b/i,
  /\bexplain(?:s|ing)?\b/i,
  /\baudit(?:s|ing|or)?\b/i,
  /\bread[-\s]only\b/i,
  /\bno code changes\b/i,
  /\bwithout (?:making |writing )?(?:any )?(?:code )?changes\b/i,
  /\bdoes not (?:write|edit|modify)\b/i,
]

/**
 * Resolve the permission set from a `--permissions` value.
 *
 * Both an omitted flag and an empty value fall back to the conservative
 * defaults — previously either one silently granted every permission.
 */
export function resolveSelectedPermissions(perms: string | undefined): string[] {
  if (!perms) return DEFAULT_ALLOWED_PERMISSIONS
  const parsed = perms
    .split(",")
    .map((permission) => permission.trim())
    .filter((permission) => permission.length > 0)
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_ALLOWED_PERMISSIONS
}

/** Build the frontmatter deny-map: everything not explicitly selected is denied. */
export function buildPermissionConfig(selected: string[]): Record<string, "deny"> {
  const permissions: Record<string, "deny"> = {}
  for (const permission of AVAILABLE_PERMISSIONS) {
    if (!selected.includes(permission)) {
      permissions[permission] = "deny"
    }
  }
  return permissions
}

/**
 * Return the mutating permissions granted to an agent whose description reads as
 * observe-only, so the caller can warn before writing the file. Empty when the
 * intent and the permissions agree.
 */
export function detectIntentMismatch(input: { text: string; selected: string[] }): string[] {
  if (!RESTRICTED_INTENT_PATTERNS.some((pattern) => pattern.test(input.text))) return []
  return HIGH_RISK_PERMISSIONS.filter((permission) => input.selected.includes(permission))
}

const AgentCreateCommand = effectCmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("description", {
        type: "string",
        describe: "what the agent should do",
      })
      .option("role", {
        type: "string",
        describe: "agent role (worker classification, unrelated to the Mode switcher)",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("permissions", {
        type: "string",
        alias: ["tools"],
        describe: `comma-separated list of permissions to allow (default: "${DEFAULT_ALLOWED_PERMISSIONS.join(
          ", ",
        )}"). Available: "${AVAILABLE_PERMISSIONS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      }),
  handler: Effect.fn("Cli.agent.create")(function* (args) {
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const agentSvc = yield* Agent.Service
    const runLocalEffect = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
    yield* Effect.promise(async () => {
      const cliPath = args.path
      const cliDescription = args.description
      const cliRole = args.role as AgentMode | undefined
      const perms = args.permissions

      // `--permissions` is deliberately not required here: omitting it is a valid
      // scripted invocation that lands on the conservative defaults, rather than
      // dropping into an interactive picker that would hang a non-TTY.
      const isFullyNonInteractive = Boolean(cliPath && cliDescription && cliRole)

      if (!isFullyNonInteractive) {
        UI.empty()
        prompts.intro("Create agent")
      }

      const project = ctx.project

      // Determine scope/path
      let targetPath: string
      if (cliPath) {
        targetPath = path.join(cliPath, "agents")
      } else {
        let scope: "global" | "project" = "global"
        if (project.vcs === "git") {
          const scopeResult = await prompts.select({
            message: "Location",
            options: [
              {
                label: "Current project",
                value: "project" as const,
                hint: ctx.worktree,
              },
              {
                label: "Global",
                value: "global" as const,
                hint: Global.Path.config,
              },
            ],
          })
          if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
          scope = scopeResult
        }
        targetPath = path.join(scope === "global" ? Global.Path.config : path.join(ctx.worktree, ".opencode"), "agents")
      }

      // Get description
      let description: string
      if (cliDescription) {
        description = cliDescription
      } else {
        const query = await prompts.text({
          message: "Description",
          placeholder: "What should this agent do?",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(query)) throw new UI.CancelledError()
        description = query
      }

      // Generate agent
      const spinner = prompts.spinner()
      spinner.start("Generating agent configuration...")
      const model = args.model ? Provider.parseModel(args.model) : undefined
      const generated = await runLocalEffect(agentSvc.generate({ description, model })).catch((error) => {
        spinner.stop(`LLM failed to generate agent: ${error.message}`, 1)
        if (isFullyNonInteractive) process.exit(1)
        throw new UI.CancelledError()
      })
      spinner.stop(`Agent ${generated.identifier} generated`)

      // Select permissions to allow
      let selected: string[]
      if (perms !== undefined || isFullyNonInteractive) {
        selected = resolveSelectedPermissions(perms)
      } else {
        const result = await prompts.multiselect({
          message: "Select permissions to allow (Space to toggle)",
          options: AVAILABLE_PERMISSIONS.map((permission) => ({
            label: permission,
            value: permission,
            hint: HIGH_RISK_PERMISSIONS.includes(permission) ? "lets the agent change things" : undefined,
          })),
          initialValues: DEFAULT_ALLOWED_PERMISSIONS,
        })
        if (prompts.isCancel(result)) throw new UI.CancelledError()
        selected = result
      }

      // Get role
      let mode: AgentMode
      if (cliRole) {
        mode = cliRole
      } else {
        const modeResult = await prompts.select({
          message: "Agent role",
          options: [
            {
              label: "All",
              value: "all" as const,
              hint: "Can function in both primary and subagent roles",
            },
            {
              label: "Primary",
              value: "primary" as const,
              hint: "Acts as a primary/main agent",
            },
            {
              label: "Subagent",
              value: "subagent" as const,
              hint: "Can be used as a subagent by other agents",
            },
          ],
          initialValue: "all" as const,
        })
        if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
        mode = modeResult
      }

      // Build permissions config — deny anything not explicitly selected.
      const permissions = buildPermissionConfig(selected)

      // The generated system prompt is prose; only this permission block is
      // enforced. Warn when the two disagree instead of letting an agent that
      // describes itself as read-only quietly keep write access.
      // Only the user's own words and the when-to-use line — the generated
      // system prompt is verbose enough ("explain your reasoning") to match on
      // almost any agent, and a warning that always fires gets ignored.
      const mismatched = detectIntentMismatch({
        text: `${description} ${generated.whenToUse}`,
        selected,
      })
      if (mismatched.length > 0) {
        const warning = `This agent describes itself as research/read-only, but still has ${mismatched.join(
          ", ",
        )}. Its system prompt cannot restrict it — only permissions can.`
        if (isFullyNonInteractive) {
          console.error(`Warning: ${warning}`)
        } else {
          prompts.log.warn(warning)
        }
      }

      // Build frontmatter
      const frontmatter: {
        description: string
        mode: AgentMode
        permission?: Record<string, "deny">
      } = {
        description: generated.whenToUse,
        mode,
      }
      if (Object.keys(permissions).length > 0) {
        frontmatter.permission = permissions
      }

      // Write file
      const content = matter.stringify(generated.systemPrompt, frontmatter)
      const filePath = path.join(targetPath, `${generated.identifier}.md`)

      await fs.mkdir(targetPath, { recursive: true })

      if (await Filesystem.exists(filePath)) {
        if (isFullyNonInteractive) {
          console.error(`Error: Agent file already exists: ${filePath}`)
          process.exit(1)
        }
        prompts.log.error(`Agent file already exists: ${filePath}`)
        throw new UI.CancelledError()
      }

      await Filesystem.write(filePath, content)

      if (isFullyNonInteractive) {
        console.log(filePath)
      } else {
        prompts.log.success(`Agent created: ${filePath}`)
        prompts.outro("Done")
      }
    })
  }),
})

const AgentListCommand = effectCmd({
  command: "list",
  describe: "list all available agents",
  handler: Effect.fn("Cli.agent.list")(function* () {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const agent of sortedAgents) {
      process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
      process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
    }
  }),
})

export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).demandCommand(),
  async handler() {},
})
