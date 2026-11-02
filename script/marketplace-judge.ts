#!/usr/bin/env bun

// XCOD-198 AC6: the marketplace maintainer agent's judgement step. For each entry the fact check
// (script/marketplace-check.ts) didn't simply keep, Lunos itself reads the facts and recommends what
// to do, on a configurable model (default: OpenAI's gpt-5.3-codex, a US provider; Petar,
// 2026-10-04). The model never supplies a
// fact: it only sees the check's findings, and its answer must match a fixed shape or it's dropped.
// Nothing here edits marketplace.json or marks an entry verified; a named person decides.
//
//   bun script/marketplace-judge.ts [--report marketplace-reviews/<date>.json] [--model openai/gpt-5.3-codex]
//
// Needs the model provider's key (e.g. OPENAI_API_KEY). Without it, it says so and exits 0, so
// pull requests from forks, which get no secrets, still pass.

import fs from "fs/promises"
import os from "os"
import path from "path"
import { $ } from "bun"
import type { Report } from "./marketplace-check"

const root = path.resolve(import.meta.dir, "..")

export const RECOMMENDATIONS = ["keep", "keep-with-warning", "delist", "propose-verified"] as const
export type Judgement = {
  name: string
  recommendation: (typeof RECOMMENDATIONS)[number]
  reasons: string[]
  user_note?: string
}

/** The provider's key variable for a model id like "mistral/mistral-small-latest". */
export function keyEnv(model: string) {
  return `${model.split("/")[0].toUpperCase().replace(/-/g, "_")}_API_KEY`
}

export function prompt(report: Report) {
  return [
    "You review one entry of the Lunos plugin marketplace against these criteria: OSI licence; public,",
    "maintained source (not archived, activity in the last 12 months); no undisclosed telemetry; no",
    "undeclared network access; install scripts and permissions proportionate to what the entry does;",
    "pinned version and integrity.",
    "",
    "Use ONLY the facts below. Do not look anything up and do not assume facts that aren't listed.",
    "",
    `Entry: ${report.name} (${report.kind}), currently "${report.status}"`,
    `Facts: ${JSON.stringify(report.facts)}`,
    `Findings: ${JSON.stringify(report.findings)}`,
    "",
    "Answer with one JSON object and nothing else:",
    `{"name": "${report.name}", "recommendation": one of ${RECOMMENDATIONS.map((item) => `"${item}"`).join(", ")},`,
    ' "reasons": [short strings, each citing a finding], "user_note": optional one sentence to show users}',
    'Recommend "propose-verified" only if no finding is a warning or failure.',
  ].join("\n")
}

/** The first JSON object in the model's answer, if it has the required shape for `name`. */
export function parse(answer: string, name: string): Judgement | undefined {
  const start = answer.indexOf("{")
  const end = answer.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  let value: any
  try {
    value = JSON.parse(answer.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (value?.name !== name) return undefined
  if (!RECOMMENDATIONS.includes(value.recommendation)) return undefined
  if (!Array.isArray(value.reasons) || !value.reasons.every((item: unknown) => typeof item === "string"))
    return undefined
  if (value.user_note !== undefined && typeof value.user_note !== "string") return undefined
  return { name, recommendation: value.recommendation, reasons: value.reasons, user_note: value.user_note }
}

/** A recommendation the facts don't allow is overridden: never "propose-verified" with open findings. */
export function guard(judgement: Judgement, report: Report): Judgement {
  const open = report.findings.some((item) => item.severity !== "info")
  if (judgement.recommendation === "propose-verified" && open)
    return {
      ...judgement,
      recommendation: "keep-with-warning",
      reasons: [...judgement.reasons, "(guard) propose-verified withdrawn: the fact check has open findings"],
    }
  return judgement
}

/**
 * The SDK and API address for each provider the judge can use. Offline mode doesn't download the
 * model catalogue, so on a fresh machine (CI) the provider is unknown unless declared in full.
 */
export const PROVIDERS: Record<string, { npm: string; api: string }> = {
  openai: { npm: "@ai-sdk/openai", api: "https://api.openai.com/v1" },
  mistral: { npm: "@ai-sdk/mistral", api: "https://api.mistral.ai/v1" },
}

/** The Lunos config that declares `model` without the downloaded catalogue. */
export function judgeConfig(model: string) {
  const [provider, id] = model.split("/", 2)
  const known = PROVIDERS[provider]
  if (!known)
    throw new Error(`marketplace-judge: no SDK and API address for provider "${provider}"; add it to PROVIDERS`)
  return { provider: { [provider]: { ...known, models: { [id]: { name: id, tool_call: true } } } } }
}

/**
 * Runs Lunos once, non-interactively, with no tools that reach the network, in a fresh data and
 * cache directory: a provider login saved on the machine doesn't replace the key, and a cached
 * catalogue doesn't hide a declaration that CI would need.
 */
async function ask(model: string, text: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-judge-"))
  const result =
    await $`bun run ${path.join(root, "packages/opencode/src/index.ts")} run --model ${model} ${text} </dev/null`
      .env({
        ...process.env,
        LUNOS_OFFLINE: "1",
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(judgeConfig(model)),
      })
      .cwd(root)
      .quiet()
      .nothrow()
  await fs.rm(home, { recursive: true, force: true })
  // Colour codes stripped, so the error line can be read.
  const output = (result.stdout.toString() + result.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, "")
  // Lunos prints a failed model call as "Error: …" (e.g. "Error: Rate limit exceeded").
  return { answer: output, error: output.match(/^Error: (.+)$/m)?.[1] }
}

export function markdown(
  date: string,
  model: string,
  judgements: Judgement[],
  dropped: { name: string; why: string }[],
) {
  return (
    [
      `# Marketplace judgement, ${date}`,
      "",
      `Lunos on \`${model}\` read the fact check's findings for each entry it didn't simply keep, and recommends below. It saw only those facts. A named person decides; nothing changes until they do.`,
      "",
      "| Entry | Recommendation | Reasons | Note for users |",
      "| --- | --- | --- | --- |",
      ...judgements.map(
        (item) =>
          `| \`${item.name}\` | **${item.recommendation}** | ${item.reasons.join("<br>")} | ${item.user_note ?? ""} |`,
      ),
      ...(dropped.length
        ? ["", "No usable answer:", "", ...dropped.map((item) => `- \`${item.name}\`: ${item.why}`)]
        : []),
    ].join("\n") + "\n"
  )
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const model = option("--model", "openai/gpt-5.3-codex")
  if (!process.env[keyEnv(model)]) {
    console.log(`marketplace-judge: ${keyEnv(model)} is not set; skipping the judgement step (facts only).`)
    process.exit(0)
  }
  const dir = path.join(root, "marketplace-reviews")
  const latest = (await Array.fromAsync(new Bun.Glob("*.json").scan(dir)))
    .filter((file) => !file.includes("judgement"))
    .sort()
    .pop()
  const file = path.resolve(root, option("--report", latest ? path.join(dir, latest) : ""))
  const { date, reports } = (await Bun.file(file).json()) as { date: string; reports: Report[] }
  const judgements: Judgement[] = []
  const dropped: { name: string; why: string }[] = []
  for (const report of reports.filter((item) => item.verdict !== "keep")) {
    const { answer, error } = await ask(model, prompt(report))
    const judgement = parse(answer, report.name)
    if (judgement) judgements.push(guard(judgement, report))
    else dropped.push({ name: report.name, why: error ?? "answer not in the expected shape" })
  }
  await Bun.write(
    path.join(dir, `${date}.judgement.json`),
    JSON.stringify({ model, date, judgements, dropped }, null, 2) + "\n",
  )
  const md = markdown(date, model, judgements, dropped)
  await Bun.write(path.join(dir, `${date}.judgement.md`), md)
  console.log(md)
}
