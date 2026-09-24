import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

// Lunos never installs new code without a person choosing it: unless `autoupdate` is
// explicitly `true`, every release (patches included) is only announced. Upstream
// opencode installs patch releases silently when `autoupdate` is unset.
export function updateAction(
  autoupdate: boolean | "notify" | undefined,
  current: string,
  latest: string,
): "none" | "notify" | "install" {
  if (autoupdate === false || current === latest) return "none"
  if (autoupdate === true && Installation.getReleaseType(current, latest) === "patch") return "install"
  return "notify"
}

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
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
