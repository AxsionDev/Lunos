import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { updaterProgress } from "./updater-action"

/**
 * XCOD-247: the desktop update's progress under the settings button. The bar shows the download
 * percentage when the updater reports it and is indeterminate otherwise; the text is in an aria-live
 * region so screen readers hear each step.
 */
export function UpdaterProgress(props: { progress: ReturnType<typeof updaterProgress> }) {
  const language = useLanguage()
  return (
    <div role="status" aria-live="polite" class="flex flex-col gap-1 min-w-40" data-component="updater-progress">
      <Show when={props.progress}>
        {(progress) => (
          <>
            <progress
              class="w-full h-1"
              max={100}
              value={progress().percent}
              aria-label={language.t(progress().label)}
            />
            <span class="text-12-regular text-text-weak">
              {language.t(progress().label)}
              {progress().version ? ` ${progress().version}` : ""}
              {progress().percent !== undefined ? ` ${progress().percent}%` : ""}
            </span>
          </>
        )}
      </Show>
    </div>
  )
}
