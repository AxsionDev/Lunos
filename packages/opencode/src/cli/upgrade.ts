import { Config } from "@/config/config"
import { ConfigPolicy } from "@/config/policy"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import semver from "semver"

const DAY = 24 * 60 * 60 * 1000
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
 * The latest published Lunos version, hitting the registry at most once a day. Every start of
 * the TUI and every CLI command would otherwise make a network call just to learn nothing new.
 */
export async function cachedLatest(now = Date.now()): Promise<string | undefined> {
  const cache = await readCache()
  if (cache.latest && now - cache.checkedAt < DAY) return cache.latest
  const latest = await Installation.latest().catch(() => undefined)
  await writeCache({ ...cache, checkedAt: now, latest: latest ?? cache.latest })
  return latest ?? cache.latest
}

/**
 * One stderr line, at most once a day, for plain CLI commands. Never stdout (piped output stays
 * clean) and never a prompt (these commands can run unattended).
 */
/**
 * `OPENCODE_DISABLE_AUTOUPDATE` / `LUNOS_DISABLE_AUTOUPDATE` switch update checks off, unless an
 * organisation policy locks `autoupdate` (XCOD-102): then only the managed value counts.
 */
async function envDisables(config: { $locked?: ReadonlyArray<string> } | undefined) {
  if (!Flag.OPENCODE_DISABLE_AUTOUPDATE) return false
  if (!ConfigPolicy.isLocked(config?.$locked, "autoupdate")) return true
  await Effect.runPromise(ConfigPolicy.refused("autoupdate", "OPENCODE_DISABLE_AUTOUPDATE")).catch(() => undefined)
  return false
}

export async function notice(now = Date.now()) {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())).catch(() => undefined)
  if (await envDisables(config)) return
  if (config?.autoupdate === false) return
  const latest = await cachedLatest(now)
  if (!latest || !semver.valid(InstallationVersion) || !semver.gt(latest, InstallationVersion)) return
  const cache = await readCache()
  if (cache.notifiedAt && now - cache.notifiedAt < DAY) return
  process.stderr.write(`A new Lunos version is available: ${InstallationVersion} → ${latest}. Run "lunos upgrade".\n`)
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
  const method = await Installation.method()
  const latest = await cachedLatest()
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
