import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AuditLog } from "@/audit/log"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import {
  InstallationChannel,
  InstallationVersion,
  NPM_ALLOW_SCRIPTS,
  manualInstallCommand,
  type UpgradeStep,
} from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

// Lunos is published only as `lunos-ai` on npm. That registry is the single source of
// truth for update checks, and npm/pnpm/bun are the only channels that can upgrade.
// Never fall back to upstream opencode's packages, formulae or install script.
export const PACKAGE = "lunos-ai"
const UPGRADABLE: ReadonlySet<Method> = new Set(["npm", "pnpm", "bun"])

export function unpublishedMessage(method: Method) {
  const channel = method === "unknown" ? "this installation" : method
  return `Lunos isn't published on ${channel} yet; install with ${manualInstallCommand()}`
}

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `opencode/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

/**
 * What a failed upgrade can say without echoing the package manager's output, which may carry
 * registry tokens: its error code (`EBUSY`, `EACCES`, `ERR_PNPM_…`; capitals, digits and `_`
 * only) and the path of npm's debug log, which holds the full story on the user's own machine.
 */
export function failureDetail(output: string) {
  const code =
    output.match(/^npm (?:error|ERR!) code ([A-Z0-9_]+)\s*$/m)?.[1] ?? output.match(/\b(ERR_PNPM_[A-Z0-9_]+)\b/)?.[1]
  const log = output.match(/^npm (?:error|ERR!) A complete log of this run can be found in: (\S+\.log)\s*$/m)?.[1]
  return { code, log }
}

const NpmPackage = Schema.Struct({ version: Schema.String })

/**
 * XCOD-247: the lunos-ai version a global listing shows (`npm list -g`: `lunos-ai@1.2.3`, `pnpm list
 * -g`: `lunos-ai 1.2.3`, `bun pm ls -g`: `lunos-ai@1.2.3`), or undefined when it can't be told.
 */
export function listedVersion(listing: string) {
  return listing.match(new RegExp(`(?:^|[\\s/])${PACKAGE}[@ ]v?(\\d+\\.\\d+\\.\\d+[^\\s]*)`, "m"))?.[1]
}

const LIST_COMMAND: Partial<Record<Method, string[]>> = {
  npm: ["npm", "list", "-g", "--depth=0"],
  pnpm: ["pnpm", "list", "-g", "--depth=0"],
  bun: ["bun", "pm", "ls", "-g"],
}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (
    method: Method,
    target: string,
    onStep?: (step: UpgradeStep) => void,
  ) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; detached?: boolean }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
            detached: opts?.detached,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (!result) return `Upgrade failed for ${method}.`
      const detail = failureDetail(result.stdout + "\n" + result.stderr)
      const code = detail.code ? `, ${method} error ${detail.code}` : ""
      const log = detail.log ? `\n${method}'s log: ${detail.log}` : ""
      return `Upgrade failed for ${method} (exit code ${result.code}${code}).${log}`
    }

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        // The Lunos install script puts the binary in ~/.lunos/bin. Upstream's paths
        // (~/.opencode/bin, ~/.local/bin) are deliberately not treated as Lunos installs.
        if (process.execPath.includes(path.join(".lunos", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          if (output.includes(PACKAGE)) return check.name
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* () {
        // Every install method reads the same source, so the answer never depends on
        // what else happens to be installed on the machine.
        const response = yield* httpOk.execute(
          HttpClientRequest.get(`${yield* NpmConfig.registry(process.cwd())}/${PACKAGE}/${InstallationChannel}`).pipe(
            HttpClientRequest.acceptJson,
          ),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
        return data.version
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (
        m: Method,
        target: string,
        onStep?: (step: UpgradeStep) => void,
      ) {
        if (!UPGRADABLE.has(m)) return yield* new UpgradeFailedError({ stderr: unpublishedMessage(m) })
        const manager = m === "bun" ? ["bun", "install", "-g"] : [m, "install", "-g"]
        // Without the flag, npm 12 upgrades the package but skips the postinstall that fetches
        // the new binary, leaving a `lunos` that won't start.
        const flags = m === "npm" ? [NPM_ALLOW_SCRIPTS] : []
        onStep?.("installing")
        // XCOD-247: a package manager stopped halfway can leave no working `lunos` at all, so once it
        // starts it runs to the end: in its own process group (a terminal's Ctrl+C doesn't reach it)
        // and uninterruptible (a closed TUI request doesn't kill it).
        const upgradeResult = yield* Effect.uninterruptible(
          run([...manager, `${PACKAGE}@${target}`, ...flags], { detached: true }),
        )
        AuditLog.emit("upgrade", {
          method: m,
          version: target,
          from: InstallationVersion,
          allowed: !!upgradeResult && upgradeResult.code === 0,
        })
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        onStep?.("verifying")
        // Only a listing that clearly names another version fails; one that can't be read passes,
        // since the install itself already succeeded.
        const listing = yield* text(LIST_COMMAND[m]!)
        const installed = listedVersion(listing)
        if (installed && installed !== target) {
          return yield* new UpgradeFailedError({
            stderr: `${m} reports lunos-ai ${installed} after installing ${target}. To update manually, run: ${manualInstallCommand(target)}`,
          })
        }
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
