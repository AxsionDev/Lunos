import { EOL } from "os"
import fs from "fs/promises"
import * as prompts from "@clack/prompts"
import { parse as parseJsonc } from "jsonc-parser"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import { InstanceRef } from "@/effect/instance-ref"
import { Offline } from "@opencode-ai/core/offline"
import { Config } from "@/config/config"
import { ConfigPolicy } from "@/config/policy"
import { ConfigSettings } from "@/config/settings"
import { CloudAuth } from "@/cloud/auth"
import { CloudStore } from "@/cloud/store"
import { CloudSync } from "@/cloud/sync"
import { CloudSyncApi } from "@/cloud/sync-api"
import { CloudSyncQueue } from "@/cloud/sync-queue"

// XCOD-185: `lunos sync on | off | status | link`. The device's switch lives on the control plane
// (the app can flip it too); `link` chooses, per directory, which Lunos space project its sessions
// go to, or turns sync off for it, in the project's own `.opencode/opencode.json`.

const LOGIN = "Run lunos login first."
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const signedIn = Effect.gen(function* () {
  const stored = yield* Effect.promise(() => CloudStore.load())
  if (!stored) return yield* fail(LOGIN)
  return stored
})

/** An organisation's sign-in sends its token only to a control plane configured explicitly. */
const permitted = (stored: CloudStore.Session) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => CloudSyncApi.permitted(stored.issuer))))
      return yield* fail(CloudSyncApi.NEEDS_ENDPOINT)
  })

const config = () =>
  Config.Service.use((cfg) => cfg.get()) as Effect.Effect<CloudSync.SyncConfig, never, Config.Service>
const lockedOff = (cfg: CloudSync.SyncConfig) => cfg.sync === false && ConfigPolicy.isLocked(cfg.$locked, "sync")

const OFFLINE = "Lunos is offline (LUNOS_OFFLINE=1)."

/** True only when the control plane answered and lists the device: nothing is inferred from a cache. */
async function confirm(state: CloudSyncApi.State): Promise<CloudSyncApi.Device | undefined> {
  try {
    const session = await CloudAuth.session("Session sync")
    const res = await fetch(state.endpoint + "/v1/devices", {
      headers: { authorization: `Bearer ${session.tokens.access_token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as { devices?: CloudSyncApi.Device[] }
    return json.devices?.find((d) => d.id === state.device.id && !d.revokedAt)
  } catch {
    return undefined
  }
}

const failed = (e: unknown) =>
  e instanceof CloudAuth.SignedOutError
    ? fail(LOGIN)
    : e instanceof CloudSyncApi.NotPermittedError
      ? fail(CloudSyncApi.NEEDS_ENDPOINT)
      : fail(message(e))

// Only `lunos login` and `lunos sync on` register a device (XCOD-185): `on` is an explicit act, so it
// shows the first-sync notice. `off` without a device has nothing to stop.
const toggle = (on: boolean) =>
  Effect.fn(`Cli.sync.${on ? "on" : "off"}`)(function* () {
    const stored = yield* signedIn
    yield* permitted(stored)
    if (!on && !(yield* Effect.promise(() => CloudSyncApi.load())))
      return yield* writeStdoutEffect(`${CloudSyncApi.NOT_REGISTERED}${EOL}`)
    if (Offline.enabled()) return yield* fail(OFFLINE)
    const state = yield* Effect.tryPromise({
      try: async () => {
        if (on) await CloudSyncApi.register({ timeoutMs: 10_000 })
        return CloudSyncApi.setEnabled(on, { timeoutMs: 10_000 })
      },
      catch: (e) => e,
    }).pipe(Effect.catch(failed))
    const cfg = yield* config()
    if (on && lockedOff(cfg))
      return yield* writeStdoutEffect(`Your organisation's policy keeps session sync off (sync is locked).${EOL}`)
    yield* writeStdoutEffect(`Session sync is ${on ? "on" : "off"} for this device (${state.device.name}).${EOL}`)
    if (on)
      yield* Effect.promise(() => CloudSyncApi.notice(state, false, (line) => void process.stdout.write(line + EOL)))
  })

export const SyncOnCommand = effectCmd({
  command: "on",
  describe: "turn session sync on for this device",
  handler: toggle(true),
})

export const SyncOffCommand = effectCmd({
  command: "off",
  describe: "turn session sync off for this device",
  handler: toggle(false),
})

export const SyncStatusCommand = effectCmd({
  command: "status",
  describe: "show whether this device and directory sync sessions, and what is queued",
  handler: Effect.fn("Cli.sync.status")(function* () {
    const stored = yield* signedIn
    yield* permitted(stored)
    const ctx = yield* InstanceRef
    const cfg = yield* config()
    const offline = Offline.enabled()
    // Status never registers a device.
    const loaded = yield* Effect.promise(() => CloudSyncApi.load())
    if (!loaded) return yield* writeStdoutEffect(`${CloudSyncApi.NOT_REGISTERED}${EOL}`)
    let state = loaded
    const live = offline ? undefined : yield* Effect.promise(() => confirm(loaded))
    const cached = live ? "" : offline ? " (cached) (offline)" : " (cached)"
    if (live) state = { ...state, device: live }
    const directory =
      cfg.sync === false
        ? "off (sync: false)"
        : cfg.sync && cfg.sync.project
          ? `project ${cfg.sync.project}`
          : "personal space"
    const queued = (yield* Effect.promise(() => CloudSyncQueue.pending())).length
    const device = state.device
    const lines = [
      `signed in as:   ${stored.email ?? stored.sub}`,
      `endpoint:       ${state.endpoint}`,
      `device:         ${device.name} (${device.id})`,
      `device switch:  ${device.syncEnabled ? "on" : "off"}${cached}`,
      `org policy:     ${lockedOff(cfg) ? "locked off" : "allows sync"}`,
      `this directory: ${directory}${ctx?.directory ? ` [${ctx.directory}]` : ""}`,
    ]
    if (cfg.residency) {
      const r = CloudSync.residency(cfg, state.endpoint)
      lines.push(`residency:      ${r.allowed ? "allowed" : `denied${r.reason ? `: ${r.reason}` : ""}`}`)
    }
    lines.push(`queued chunks:  ${queued}`)
    if (state.paused === "quota") lines.push("paused: space full")
    lines.push(`last sync:      ${device.lastSyncAt ? new Date(device.lastSyncAt).toISOString() : "never"}`)
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
  }),
})

type Choice = { label: string; project?: string }

async function choices(): Promise<Choice[]> {
  const session = await CloudAuth.session("Session sync")
  const base = await CloudSyncApi.endpoint()
  const get = async <T>(p: string) => {
    const res = await fetch(base + p, {
      headers: { authorization: `Bearer ${session.tokens.access_token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Couldn't read ${p} from ${base} (HTTP ${res.status}).`)
    return (await res.json()) as T
  }
  const out: Choice[] = []
  const { spaces } = await get<{ spaces: Array<{ id: string; name: string }> }>("/v1/spaces")
  const lists = await Promise.all(
    spaces.map((space) =>
      get<{ projects: Array<{ id: string; name: string }> }>(`/v1/spaces/${encodeURIComponent(space.id)}/projects`),
    ),
  )
  spaces.forEach((space, i) => {
    for (const project of lists[i]!.projects)
      out.push({ label: `${space.name} / ${project.name}`, project: project.id })
  })
  return out
}

export const SyncLinkCommand = effectCmd({
  command: "link [projectId]",
  describe: "choose the Lunos space project this directory's sessions sync to",
  builder: (yargs) =>
    yargs
      .positional("projectId", { type: "string", describe: "project id; omit to choose from a list" })
      .option("off", { type: "boolean", default: false, describe: "don't sync sessions from this directory" })
      .option("personal", {
        type: "boolean",
        default: false,
        describe: "sync to your personal space, with no project",
      }),
  handler: Effect.fn("Cli.sync.link")(function* (args) {
    const stored = yield* signedIn
    if (args.personal && args.projectId) return yield* fail("Give a project id or --personal, not both.")
    // Choosing a project asks the control plane (with the token); --off and --personal are local writes.
    // `link` never registers a device.
    if (!args.off && !args.personal) yield* permitted(stored)
    // `--off` and `--personal` are local writes; choosing a project needs the server.
    if (Offline.enabled() && !args.off && !args.personal) return yield* fail(OFFLINE)
    const ctx = yield* InstanceRef
    const target = { directory: ctx?.directory ?? process.cwd(), worktree: ctx?.worktree }
    let value: false | { project?: string; exclude?: string[] }
    if (args.off) value = false
    else {
      let project: string | undefined
      const options = args.personal
        ? []
        : yield* Effect.tryPromise({ try: choices, catch: (e) => e }).pipe(
            Effect.catch((e) => (e instanceof CloudAuth.SignedOutError ? fail(LOGIN) : fail(message(e)))),
          )
      if (args.personal) project = undefined
      else if (args.projectId) {
        if (!options.some((o) => o.project === args.projectId))
          return yield* fail(`No project ${args.projectId} in your spaces.`)
        project = args.projectId
      } else {
        const picked = yield* Effect.promise(() =>
          prompts.select<string>({
            message: "Where should this directory's sessions sync?",
            options: [
              { value: "", label: "Personal space (no project)" },
              ...options.map((o) => ({ value: o.project!, label: o.label })),
            ],
          }),
        )
        if (prompts.isCancel(picked)) return yield* fail("Cancelled.")
        project = picked || undefined
      }
      // Keep the directory's other sync settings (exclude globs) as they are.
      const file = ConfigSettings.targetFile("config", "project", target)
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => ""))
      const existing = (parseJsonc(text, [], { allowTrailingComma: true }) as { sync?: unknown } | undefined)?.sync
      const kept = existing && typeof existing === "object" ? (existing as { exclude?: string[] }) : {}
      value = { ...(kept.exclude ? { exclude: kept.exclude } : {}), ...(project ? { project } : {}) }
    }
    const result = yield* Effect.tryPromise({
      try: () => ConfigSettings.set({ key: "sync", value, scope: "project", ctx: target, via: "lunos sync link" }),
      catch: (e) => e,
    }).pipe(Effect.catch((e) => fail(message(e))))
    yield* writeStdoutEffect(`sync = ${JSON.stringify(result.value)} (${result.file})${EOL}`)
  }),
})

export const SyncCommand = cmd({
  command: "sync",
  describe: "control session sync to your Lunos space",
  builder: (yargs) =>
    yargs
      .command(SyncOnCommand)
      .command(SyncOffCommand)
      .command(SyncStatusCommand)
      .command(SyncLinkCommand)
      .demandCommand(),
  async handler() {},
})
