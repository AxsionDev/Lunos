export * as AgentJobs from "./jobs"

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

/**
 * XCOD-211: Lunos's registry of scheduled agents. The operating system's job (launchd, systemd,
 * Task Scheduler) only runs `lunos agent run --job <id>`; everything else (the agent, the prompt,
 * the directory, the limits) is here, written by Lunos and read back by Lunos.
 */

export interface Limits {
  /** Wall time, in seconds. */
  time: number
  /** Model spend, in the provider's currency (USD for the built-in prices). */
  cost: number
  /** Agent steps, the agent's and its subagents' together. */
  steps: number
}

export interface Job {
  id: string
  agent: string
  prompt: string
  cwd: string
  cron: string
  limits: Limits
  sandbox: boolean
  notify?: string
  created: string
  /** What was installed, so `remove` undoes exactly that. */
  installed: { platform: NodeJS.Platform; files: string[] }
}

export const root = () => path.join(Global.Path.data, "agents")
const registry = () => path.join(root(), "jobs.json")
export const runs = () => path.join(root(), "runs")
export const logs = () => path.join(root(), "logs")

export async function list(): Promise<Job[]> {
  const text = await fs.readFile(registry(), "utf8").catch(() => "[]")
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function save(jobs: Job[]) {
  await fs.mkdir(root(), { recursive: true })
  const next = `${registry()}.${process.pid}.tmp`
  await fs.writeFile(next, JSON.stringify(jobs, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(next, registry())
}

export const newId = () => crypto.randomBytes(4).toString("hex")

export async function add(job: Job) {
  await save([...(await list()).filter((item) => item.id !== job.id), job])
}

export async function remove(id: string) {
  await save((await list()).filter((item) => item.id !== id))
}

export async function get(id: string) {
  return (await list()).find((job) => job.id === id)
}

/**
 * One run of a job at a time. A lock left by a process that no longer exists is taken over.
 * Returns the release function, or undefined when another run holds the lock.
 */
export async function lock(id: string) {
  const dir = path.join(root(), "locks")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${id}.lock`)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, String(process.pid), { flag: "wx" })
      return () => fs.rm(file, { force: true })
    } catch {
      const holder = Number(await fs.readFile(file, "utf8").catch(() => "0"))
      if (holder && alive(holder)) return undefined
      await fs.rm(file, { force: true })
    }
  }
  return undefined
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
