// XCOD-338: remote control with the real wiring, nothing injected but the relay: CloudRemote.enable
// for a real session whose real Permission service waits on an approval. The approval comes from the
// (fake) relay, goes through this process's own /permission route, the ask resolves, and the audit
// log says permission.decision with via: "remote".
import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AuditLog } from "@/audit/log"
import { CloudRemote } from "@/cloud/remote"
import { CloudSyncApi } from "@/cloud/sync-api"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { Permission } from "@/permission"
import { Server } from "@/server/server"
import { SessionID } from "@/session/schema"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

let data: string
let audit: string
const original = Global.Path.data
const originalAudit = AuditLog.current()
let relay: ReturnType<typeof Bun.serve>
let commands: unknown[] = []
const events: Array<{ type: string; data: any }> = []

beforeEach(async () => {
  data = await fs.mkdtemp(path.join(os.tmpdir(), "remote-wiring-"))
  ;(Global.Path as any).data = data
  audit = path.join(data, "audit.log")
  AuditLog.activate({ enabled: true, file: audit, redact: [] })
  relay = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/remote/links" && req.method === "POST") {
        const body = (await req.json()) as any
        return Response.json(
          {
            id: "rl_w",
            host: "b".repeat(64),
            session: body.session,
            device: body.device,
            createdAt: Date.now(),
            expiresAt: Date.now() + 3_600_000,
          },
          { status: 201 },
        )
      }
      if (url.pathname.endsWith("/events")) {
        events.push(...((await req.json()) as any).events)
        return Response.json({ seq: events.length })
      }
      if (url.pathname.endsWith("/commands")) {
        for (let i = 0; i < 10 && !commands.length; i++) await Bun.sleep(30)
        const out = commands
        commands = []
        return Response.json({ commands: out })
      }
      return Response.json({ ended: true })
    },
  })
  await CloudSyncApi.save({
    endpoint: relay.url.origin,
    sub: "ada",
    noticeShown: true,
    device: { id: "dev_mac", name: "mac", platform: "darwin", syncEnabled: true, createdAt: 1 },
  })
})
afterEach(async () => {
  for (const id of CloudRemote.list()) await CloudRemote.disable(id)
  relay.stop(true)
  await AuditLog.flush()
  AuditLog.activate(originalAudit ?? { enabled: false, file: AuditLog.DEFAULT_FILE(), redact: [] })
  ;(Global.Path as any).data = original
  await disposeAllInstances()
  await resetDatabase()
  await fs.rm(data, { recursive: true, force: true })
})

test("AC1 with the real wiring: a remote approval resolves the session's real ask, audited via remote", async () => {
  // The instance activates the audit log from its config when it loads.
  await using tmp = await tmpdir({
    git: true,
    config: { formatter: false, lsp: false, audit: { enabled: true, path: audit } },
  })
  const app = Server.Default().app
  const created = await app.fetch(
    new Request(`http://lunos.internal/session?directory=${encodeURIComponent(tmp.path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  )
  expect(created.status).toBe(200)
  const session = (await created.json()) as { id: string }

  // The session's tool asks; the ask waits in this instance's Permission service.
  const asked = AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: tmp.path },
        Permission.Service.use((p) =>
          p.ask({
            id: PermissionV1.ID.make("per_wire1"),
            sessionID: SessionID.make(session.id),
            permission: "bash",
            patterns: ["bun test"],
            metadata: {},
            always: [],
            ruleset: [],
          }),
        ),
      ),
    ),
  )

  const status = await CloudRemote.enable({
    sessionID: session.id,
    directory: tmp.path,
    config: {},
    opts: { endpoint: relay.url.origin, token: async () => "t" },
  })
  expect(status.on).toBe(true)
  // The pending approval reached the relay through the real /permission route.
  for (let i = 0; i < 100 && !events.some((e) => e.type === "permission.asked"); i++) await Bun.sleep(30)
  expect(events.find((e) => e.type === "permission.asked")?.data).toMatchObject({ id: "per_wire1", permission: "bash" })

  commands.push({ id: "cmd_1", at: Date.now(), type: "permission", requestID: "per_wire1", reply: "once" })
  await Promise.race([asked, Bun.sleep(5_000).then(() => Promise.reject(new Error("the ask was never answered")))])

  // remote.command is written once the command has run, just after the ask resolved.
  const read = async () => {
    await AuditLog.flush()
    return (await fs.readFile(audit, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }
  for (let i = 0; i < 100 && !(await read()).some((l) => l.event === "remote.command"); i++) await Bun.sleep(30)
  const lines = await read()
  expect(lines).toContainEqual(
    expect.objectContaining({
      event: "permission.decision",
      session: session.id,
      decision: "allowed once",
      via: "remote",
    }),
  )
  expect(lines).toContainEqual(
    expect.objectContaining({ event: "remote.command", kind: "permission", via: "remote", ok: true }),
  )
}, 30_000)
