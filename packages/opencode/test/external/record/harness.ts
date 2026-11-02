// XCOD-270: replays a recorded scenario against the Lunos adapters, in place of the live tool. Each
// recorded process is played by replay.ts, started by the adapter as its `executable`; the steps
// run with the options the recorder used (manifest.json) and approvals are answered the same way.
// `contract` is how the per-scenario contract tests use it: against the real recordings for the
// pinned releases, skipped with a pointer to the recorder until those are committed.
import { test } from "bun:test"
import { existsSync, readFileSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ExternalClaude } from "../../../src/external/claude"
import { ExternalCodex } from "../../../src/external/codex"
import type { ExternalDetect } from "../../../src/external/detect"
import { decision, VERSIONS, type Decide } from "./scenarios"

export const ROOT = path.join(import.meta.dir, "..", "..", "fixtures", "external")
const REPLAY = path.join(import.meta.dir, "replay.ts")

export interface ManifestStep {
  file: string
  kind: "models" | "turn"
  prompt?: string
  model?: string
  resume?: boolean
  bridge?: boolean
  decide?: Decide
  /** Files under the throwaway HOME the step added, changed or removed (paths only). */
  home: { added: string[]; changed: string[]; removed: string[] }
}

export interface Manifest {
  tool: ExternalDetect.Tool
  version: string
  fake: boolean
  scenarios: Record<string, { steps: ManifestStep[] }>
}

export interface ReplayEntry {
  argv?: string[]
  received?: any
  expected?: any
  match?: boolean
  missing?: unknown
  extra?: string
}

export interface StepResult {
  step: ManifestStep
  /** What the recorded tool sent, in order. */
  tool: any[]
  /** What the adapter sent back during replay. */
  host: any[]
  argv: string[]
  /** Replay problems: host lines that didn't match the recording, never came, or weren't recorded. */
  problems: ReplayEntry[]
  events: ExternalClaude.Event[]
  asked: ExternalClaude.PermissionRequest[]
  models?: ExternalClaude.Model[]
  result?: Awaited<ExternalClaude.Running["done"]>
}

export function manifest(dir: string): Manifest | undefined {
  const file = path.join(dir, "manifest.json")
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
}

export function lines(file: string): any[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export async function replay(dir: string, scenario: string): Promise<StepResult[]> {
  const found = manifest(dir)
  const steps = found?.scenarios[scenario]?.steps
  if (!found || !steps) throw new Error(`no recording of ${scenario} in ${dir}`)
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-replay-"))
  const results: StepResult[] = []
  try {
    for (const [index, step] of steps.entries()) {
      const fixture = path.join(dir, step.file)
      const log = path.join(work, `${index}.log`)
      process.env.REPLAY_FIXTURE = fixture
      process.env.REPLAY_LOG = log
      const events: ExternalClaude.Event[] = []
      const asked: ExternalClaude.PermissionRequest[] = []
      const ask = async (request: ExternalClaude.PermissionRequest) => {
        asked.push(request)
        return decision(step.decide ?? "allow")
      }
      const resume = step.resume ? results.at(-1)?.result : undefined
      const common = {
        cwd: work,
        executable: REPLAY,
        prompt: step.prompt ?? "",
        ask,
        onEvent: (event: ExternalClaude.Event) => events.push(event),
        ...(step.model ? { model: step.model } : {}),
        ...(resume?.type === "result" ? { resume: resume.sessionID } : {}),
      }
      let models: ExternalClaude.Model[] | undefined
      let result: StepResult["result"]
      try {
        if (step.kind === "models")
          models = await (found.tool === "claude" ? ExternalClaude : ExternalCodex).models({
            executable: REPLAY,
            cwd: work,
            timeoutMs: 10_000,
          })
        else if (found.tool === "claude")
          result = await ExternalClaude.start({
            ...common,
            ...(step.bridge ? { mcpConfig: path.join(work, "mcp.json") } : {}),
          }).done
        else
          result = await ExternalCodex.start({
            ...common,
            ...(step.bridge ? { config: { "mcp_servers.lunos": { command: "bun", args: ["stand-in.ts"] } } } : {}),
          }).done
      } finally {
        delete process.env.REPLAY_FIXTURE
        delete process.env.REPLAY_LOG
      }
      // The replay may still be writing its last lines after the adapter has its answer.
      await Bun.sleep(100)
      const logged: ReplayEntry[] = existsSync(log) ? lines(log) : []
      const recorded = lines(fixture)
      results.push({
        step,
        tool: recorded.filter((entry) => entry.from === "tool").map((entry) => entry.message ?? entry.text),
        host: logged.filter((entry) => "received" in entry).map((entry) => entry.received),
        argv: logged.find((entry) => entry.argv)?.argv ?? [],
        problems: logged.filter((entry) => entry.match === false || "missing" in entry || "extra" in entry),
        events,
        asked,
        models,
        result,
      })
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
  return results
}

/** Codex requests the adapter refused as unknown (`Lunos doesn't handle …`), by method. */
export function unhandled(step: StepResult) {
  const refused = new Set(step.host.filter((m) => /doesn't handle/.test(m?.error?.message ?? "")).map((m) => m.id))
  return step.tool.filter((m) => m?.method && refused.has(m.id)).map((m) => m.method as string)
}

/**
 * A contract test for one recorded scenario of the pinned release of `tool`. Skipped, saying how to
 * record it, until test/fixtures/external/<tool>-<version>/ has it.
 */
export function contract(
  tool: ExternalDetect.Tool,
  scenario: string,
  check: (steps: StepResult[]) => void | Promise<void>,
) {
  const version = VERSIONS[tool]
  const dir = path.join(ROOT, `${tool}-${version}`)
  const name = `${tool} ${version} ${scenario}: the adapter against the recorded tool`
  if (!manifest(dir)?.scenarios[scenario])
    return test.skip(`${name} (no recording yet in test/fixtures/external/${tool}-${version}/; record it with script/record-external-fixtures.ts, see docs/external-fixtures.md)`, () => {})
  test(
    name,
    async () => {
      const steps = await replay(dir, scenario)
      for (const step of steps) if (step.problems.length) throw new Error(JSON.stringify(step.problems).slice(0, 2000))
      await check(steps)
    },
    60_000,
  )
}
