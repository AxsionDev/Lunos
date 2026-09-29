#!/usr/bin/env bun

// XCOD-119: Lunos evaluation. Harbor runs the tasks in containers; this starts the metering
// proxy, generates one Harbor job per model and trial, and writes the report.
//
//   bun src/cli.ts estimate --config eval.config.json --tasks 250
//   bun src/cli.ts run --config eval.config.json --tasks 250 [--yes] [--out runs/<date>]
//   bun src/cli.ts run ... --agent oracle   (Harbor's reference-solution agent: checks the whole
//                                            pipeline without calling a model)
//
// `run` shows the estimate and stops unless --yes is given. API keys are read from the host
// environment by the proxy only; task containers never see them.

import fs from "fs/promises"
import path from "path"
import { $ } from "bun"
import { Ledger } from "./budget"
import { validate, type EvalConfig } from "./config"
import { describe, estimate } from "./estimate"
import { harborJob } from "./job"
import { worstCase } from "./prices"
import { startProxy, type Route } from "./proxy"
import { build, markdown, type TaskResult } from "./report"

const repo = path.resolve(import.meta.dir, "../../..")

function flag(args: string[], name: string, fallback?: string) {
  const index = args.indexOf(`--${name}`)
  const value = index === -1 ? fallback : args[index + 1]
  if (value === undefined) throw new Error(`eval: missing --${name}`)
  return value
}

/** Tool calls and failed tool calls, from the `lunos run --format json` events Harbor captured. */
export function toolStats(events: string) {
  let calls = 0
  let errors = 0
  for (const line of events.split("\n")) {
    if (!line.startsWith("{")) continue
    try {
      const event = JSON.parse(line)
      if (event.type !== "tool_use") continue
      calls++
      if (event.part?.state?.status === "error") errors++
    } catch {}
  }
  return { calls, errors }
}

/** One TaskResult per Harbor trial directory under a job. */
export async function harborResults(jobDir: string, model: string, trial: number) {
  const results: TaskResult[] = []
  for await (const file of new Bun.Glob("**/result.json").scan(jobDir)) {
    const dir = path.join(jobDir, path.dirname(file))
    const result = await Bun.file(path.join(dir, "result.json"))
      .json()
      .catch(() => undefined)
    if (!result?.task_name) continue
    const reward = Object.values(result.verifier_result?.rewards ?? {})[0] as number | undefined
    const started = Date.parse(result.agent_execution?.started_at ?? result.started_at)
    const finished = Date.parse(result.agent_execution?.finished_at ?? result.finished_at)
    const events = await Bun.file(path.join(dir, "agent", "opencode.txt"))
      .text()
      .catch(() => "")
    const stats = toolStats(events)
    results.push({
      model,
      trial,
      task: result.task_name,
      passed: reward !== undefined && reward >= 1,
      seconds: Number.isFinite(finished - started) ? (finished - started) / 1000 : 0,
      toolCalls: stats.calls,
      toolErrors: stats.errors,
      error: result.exception_info?.exception_type,
    })
  }
  return results
}

async function load(args: string[]) {
  return validate((await Bun.file(flag(args, "config")).json()) as EvalConfig)
}

async function run(args: string[]) {
  const config = await load(args)
  const tasks = Number(flag(args, "tasks"))
  const expected = estimate(config, tasks)
  console.log(describe(expected, config))
  if (!expected.fits) process.exit(1)
  if (!args.includes("--yes")) {
    console.log("\nNothing has been spent. Re-run with --yes to start.")
    return
  }

  const agent = args.includes("--agent") ? flag(args, "agent") : undefined
  const missing = config.models.filter((model) => !process.env[model.keyEnv]).map((model) => model.keyEnv)
  if (missing.length && !agent) throw new Error(`eval: set ${[...new Set(missing)].join(", ")} on the host first`)

  const date = new Date().toISOString().slice(0, 10)
  const out = path.resolve(flag(args, "out", path.join(repo, "packages/eval/runs", date)))
  await fs.mkdir(out, { recursive: true })
  const ledger = new Ledger(config.budget, path.join(repo, "packages/eval/runs", `ledger-${config.budget.name}.jsonl`))
  if (ledger.spentTotal() > 0)
    console.log(`budget "${config.budget.name}": €${ledger.spentTotal().toFixed(2)} already spent in earlier runs`)
  const token = crypto.randomUUID()
  const routes: Route[] = config.models.map((model) => {
    const price = config.prices[model.model]
    if (price.kind !== "api") throw new Error(`${model.model}: self-hosted runs are started separately`)
    return {
      id: model.id,
      model: model.model,
      cls: model.cls,
      upstream: model.upstream,
      apiKey: process.env[model.keyEnv] ?? "",
      price,
    }
  })
  const proxy = startProxy({ routes, ledger, token, hostname: flag(args, "proxy-bind", "0.0.0.0") })
  // Containers reach the host's proxy by this name (Docker Desktop; on Linux add it with --add-host).
  const proxyURL = `http://${flag(args, "proxy-host", "host.docker.internal")}:${proxy.port}/${token}`

  const results: TaskResult[] = []
  try {
    for (const model of config.models) {
      const route = routes.find((item) => item.id === model.id)!
      for (let trial = 1; trial <= model.trials; trial++) {
        // Don't start a trial the class can't pay for: its tasks would only be refused one by one.
        if (!agent && !ledger.canAfford(model.cls, worstCase(route.price, 50_000))) {
          console.log(
            `\n== ${model.model}: budget class "${model.cls}" is exhausted; skipping trials ${trial}–${model.trials}`,
          )
          break
        }
        const job = harborJob({
          config,
          model,
          trial,
          proxyURL,
          jobsDir: path.join(out, "jobs"),
          concurrency: 4,
          agent,
        })
        const jobFile = path.join(out, `${job.job_name}.json`)
        await Bun.write(jobFile, JSON.stringify(job, null, 2))
        console.log(`\n== ${model.model}, trial ${trial}`)
        // From the repo root, so dataset paths in the config resolve the same wherever this runs.
        await $`uvx --from harbor harbor run -c ${jobFile}`
          .cwd(repo)
          .env({
            ...process.env,
            PYTHONPATH: path.join(import.meta.dir, "../harbor"),
            [model.keyEnv]: "via-lunos-eval-proxy",
          })
          .nothrow()
        results.push(...(await harborResults(path.join(out, "jobs", job.job_name), model.model, trial)))
        console.log(`spent so far: €${ledger.spentTotal().toFixed(2)} of €${config.budget.total}`)
      }
    }
  } finally {
    proxy.stop(true)
  }

  const report = build({ config, taskCount: tasks, results, ledger: ledger.entries })
  await Bun.write(path.join(out, "report.json"), JSON.stringify({ report, results }, null, 2))
  const md = path.resolve(flag(args, "report", path.join(repo, "specs/eval", `${date}.md`)))
  await fs.mkdir(path.dirname(md), { recursive: true })
  await Bun.write(md, markdown(report))
  console.log(`\nreport: ${md}${report.complete ? "" : " (INCOMPLETE)"}`)
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "estimate") {
    const config = await load(args)
    console.log(describe(estimate(config, Number(flag(args, "tasks"))), config))
  } else if (command === "run") await run(args)
  else {
    console.error("usage: cli.ts estimate|run --config <file> --tasks <n> [--yes]")
    process.exit(1)
  }
}
