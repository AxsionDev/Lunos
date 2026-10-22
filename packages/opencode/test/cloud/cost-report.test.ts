import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Offline } from "@opencode-ai/core/offline"
import { CloudCostReport } from "../../src/cloud/cost-report"
import { ConfigOrgPolicy } from "../../src/config/org-policy"

// XCOD-298: per-step cost reports to the organisation's console. Off by default, never without an
// organisation, never offline, and only the amount, model and project id. A fake console on a local
// port records every request; the token is injected.

const POLICY = { $locked: ["share"], share: "disabled" }
type Seen = { method: string; path: string; body?: string }
let server: ReturnType<typeof Bun.serve>
let seen: Seen[] = []
let dir: string
let previous: string
const offlineBefore = process.env[Offline.ENV]

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-cost-report-"))
  previous = Global.Path.data
  ;(Global.Path as { data: string }).data = dir
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({ method: req.method, path: url.pathname, body: req.method === "POST" ? await req.text() : undefined })
      if (req.method === "POST") return new Response(null, { status: 204 })
      const sha = ConfigOrgPolicy.sha256(POLICY)
      return Response.json({ org: "acme", version: 1, sha256: sha, policy: POLICY }, { headers: { etag: `"${sha}"` } })
    },
  })
})
afterAll(async () => {
  server.stop(true)
  ;(Global.Path as { data: string }).data = previous
  await fs.rm(dir, { recursive: true, force: true })
})
afterEach(() => {
  seen = []
  ConfigOrgPolicy.reset()
  CloudCostReport.reset()
  if (offlineBefore === undefined) delete process.env[Offline.ENV]
  else process.env[Offline.ENV] = offlineBefore
})

const url = () => `http://127.0.0.1:${server.port}/v1/orgs/acme/policy`
const token = async () => "fake-token"
const reports = () => seen.filter((item) => item.method === "POST" && item.path.endsWith("/usage/turns"))
const turn = { cost: 0.12, model: "anthropic/claude", project: "pgrp_abc" }

describe("cloud.cost_report", () => {
  test("off by default; on from user config or managed config; managed wins", () => {
    expect(CloudCostReport.enabled({ managed: {}, locked: [], global: {} })).toBe(false)
    expect(CloudCostReport.enabled({ managed: {}, locked: [], global: { cloud: { cost_report: true } } })).toBe(true)
    expect(
      CloudCostReport.enabled({
        managed: { cloud: { cost_report: false } },
        locked: ["cloud.cost_report"],
        global: { cloud: { cost_report: true } },
      }),
    ).toBe(false)
  })

  test("sends only the amount, model, project id, time and install id", async () => {
    await ConfigOrgPolicy.resolve([{ cloud: { policy: url() } }], { token })
    CloudCostReport.configure({ managed: { cloud: { policy: url(), cost_report: true } }, locked: [], global: {} })
    CloudCostReport.send(turn, { token })
    await CloudCostReport.flush(5000)
    expect(reports()).toHaveLength(1)
    const body = JSON.parse(reports()[0]!.body!)
    expect(Object.keys(body).sort()).toEqual([
      "amount_usd",
      "install_id",
      "model",
      "project_id",
      "time",
      "unknown_cost",
    ])
    expect(body).toMatchObject({
      amount_usd: 0.12,
      model: "anthropic/claude",
      project_id: "pgrp_abc",
      unknown_cost: false,
    })
    for (const secret of [os.hostname(), os.userInfo().username, os.homedir(), process.cwd()])
      expect(reports()[0]!.body!).not.toContain(secret)
  })

  test("nothing is sent by default, for a personal account (no organisation), or offline", async () => {
    // Default: off.
    await ConfigOrgPolicy.resolve([{ cloud: { policy: url() } }], { token })
    CloudCostReport.configure({ managed: { cloud: { policy: url() } }, locked: [], global: {} })
    CloudCostReport.send(turn, { token })
    // Offline.
    CloudCostReport.configure({ managed: { cloud: { policy: url(), cost_report: true } }, locked: [], global: {} })
    process.env[Offline.ENV] = "1"
    CloudCostReport.send(turn, { token })
    delete process.env[Offline.ENV]
    await CloudCostReport.flush(2000)
    // A personal account: no organisation policy at this start.
    ConfigOrgPolicy.reset()
    await ConfigOrgPolicy.resolve([{}], { token })
    CloudCostReport.configure({ managed: {}, locked: [], global: { cloud: { cost_report: true } } })
    CloudCostReport.send(turn, { token })
    await CloudCostReport.flush(2000)
    expect(reports()).toHaveLength(0)
  })
})
