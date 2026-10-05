import { Config } from "@/config/config"
import { ConfigPolicy } from "@/config/policy"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Offline } from "@opencode-ai/core/offline"
import { Installation } from "@/installation"
import { InstallationVersion, newVersionMessage } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import semver from "semver"

const DAY = 24 * 60 * 60 * 1000
/** The registry gets this long to answer before a start falls back to the last known version. */
export const CHECK_TIMEOUT = 3000
const cacheFile = () => path.join(Global.Path.state, "update-check.json")

type UpdateCache = { checkedAt: number; latest?: string; notifiedAt?: number }

async function readCache(): Promise<UpdateCache> {
  return Bun.file(cacheFile())
    .json()
    .catch(() => ({ checkedAt: 0 }))
}

async function writeCache(cache: UpdateCache) {
  await Bun.write(cacheFile(), JSON.stringify(cache)).catch(() => {})
}

/**
 * The latest published Lunos version, asked of the registry on every start (XCOD-147). The
 * registry gets `timeout` ms; if it fails or is slow, the last known version is used, silently.
 * Callers never wait on this for startup: the TUI runs it in its worker, and CLI commands start
 * it alongside the command.
 */
export async function checkLatest(
  now = Date.now(),
  timeout = CHECK_TIMEOUT,
  /** Stop waiting early, e.g. once a plain CLI command has finished its own work. */
  until?: Promise<unknown>,
): Promise<string | undefined> {
  // Caught before the race, so a request that loses to the timeout can't reject unhandled later.
  const fetched = Installation.latest().catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeout)
  })
  const latest = await Promise.race([fetched, timedOut, ...(until ? [until.then(() => undefined)] : [])]).finally(() =>
    clearTimeout(timer),
  )
  const cache = await readCache()
  if (!latest) return cache.latest
  await writeCache({ ...cache, checkedAt: now, latest })
  return latest
}

/**
 * `OPENCODE_DISABLE_AUTOUPDATE` / `LUNOS_DISABLE_AUTOUPDATE` switch update checks off, unless an
 * organisation policy locks `autoupdate` (XCOD-102): then only the managed value counts.
 */
async function envDisables(config: { $locked?: ReadonlyArray<string> } | undefined) {
  // Offline mode (XCOD-121) isn't a preference a policy can override: there is no network to check.
  if (Offline.enabled()) return true
  if (!Flag.OPENCODE_DISABLE_AUTOUPDATE) return false
  if (!ConfigPolicy.isLocked(config?.$locked, "autoupdate")) return true
  await Effect.runPromise(ConfigPolicy.refused("autoupdate", "OPENCODE_DISABLE_AUTOUPDATE")).catch(() => undefined)
  return false
}

/**
 * One stderr line for plain CLI commands, at most once a day (the check itself runs every time).
 * Never stdout, so piped output stays clean, and never a prompt, as these commands can run
 * unattended.
 */
export async function notice(
  input: {
    now?: number
    timeout?: number
    current?: string
    write?: (line: string) => void
    /** Resolves when the command is done; the check stops waiting then and uses the cache. */
    until?: Promise<unknown>
  } = {},
) {
  const { now = Date.now(), timeout = CHECK_TIMEOUT, current = InstallationVersion } = input
  const write = input.write ?? ((line: string) => process.stderr.write(line))
  // A dev build reports "local", which nothing is newer than: no request at all.
  if (!semver.valid(current)) return
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())).catch(() => undefined)
  if (await envDisables(config)) return
  if (config?.autoupdate === false) return
  const latest = await checkLatest(now, timeout, input.until)
  if (!latest || !semver.gt(latest, current)) return
  const cache = await readCache()
  if (cache.notifiedAt && now - cache.notifiedAt < DAY) return
  write(newVersionMessage(latest, true) + "\n")
  await writeCache({ ...cache, notifiedAt: now })
}

// Lunos never installs new code without a person choosing it: unless `autoupdate` is
// explicitly `true`, every release (patches included) is only announced. Upstream
// opencode installs patch releases silently when `autoupdate` is unset.
export function updateAction(
  autoupdate: boolean | "notify" | undefined,
  current: string,
  latest: string,
): "none" | "notify" | "install" {
  // A dev build reports "local", which isn't a version anything can be newer than.
  if (autoupdate === false || current === latest || !semver.valid(current) || !semver.valid(latest)) return "none"
  if (autoupdate === true && Installation.getReleaseType(current, latest) === "patch") return "install"
  return "notify"
}

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || (await envDisables(config))) return
  if (!semver.valid(InstallationVersion) && !Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) return
  const latest = await checkLatest()
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  const action = updateAction(config.autoupdate, InstallationVersion, latest)
  if (action === "none") return
  if (action === "notify") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  // Only an explicit `autoupdate: true` gets here, so only then is the install method looked up.
  const method = await Installation.method()
  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
