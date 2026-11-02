import { createMemo } from "solid-js"
import type { UpdaterState } from "@/updater"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function updaterAction(state: UpdaterState | undefined) {
  if (!state) return { label: "settings.updates.action.checkNow" as const }
  switch (state.status) {
    case "checking":
      return { label: "settings.updates.action.checking" as const }
    case "downloading":
      return { label: "settings.updates.action.downloading" as const }
    case "ready":
      return { label: "toast.update.action.installRestart" as const, run: "install" as const }
    case "installing":
      return { label: "settings.updates.action.installing" as const }
    case "disabled":
      return { label: "settings.updates.action.checkNow" as const }
    default:
      return { label: "settings.updates.action.checkNow" as const, run: "check" as const }
  }
}

/**
 * XCOD-247: what the settings page shows while an update runs: the step text (announced through an
 * aria-live region) and how far the download is, when the updater reports it. `percent` undefined
 * with `active` set means an indeterminate bar.
 */
export function updaterProgress(state: UpdaterState | undefined) {
  if (!state) return
  if (state.status === "checking") return { label: "settings.updates.action.checking" as const }
  if (state.status === "downloading")
    return {
      label: "settings.updates.action.downloading" as const,
      version: state.version,
      percent: state.percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(state.percent))),
    }
  if (state.status === "installing")
    return { label: "settings.updates.action.installing" as const, version: state.version }
}

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))
  const progress = createMemo(() => updaterProgress(platform.updater?.state()))

  return {
    action,
    progress,
    async run() {
      const run = action().run
      if (run === "install") return platform.updater?.install()
      if (run !== "check") return

      const state = await platform.updater?.check()
      if (state?.status === "up-to-date") {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.updates.toast.latest.title"),
          description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
        })
      }
      if (state?.status === "error") {
        showToast({ title: language.t("common.requestFailed"), description: state.message })
      }
    },
  }
}
