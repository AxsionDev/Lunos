import { For } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useLanguage } from "@/context/language"

/**
 * XCOD-213: the model picker's filter, remembered per user. "Recommended" is Lunos's curated
 * list (or the organisation's `recommended`), not a benchmark; sizes follow docs/models.md.
 */
export const MODEL_FILTERS = ["all", "recommended", "large", "small"] as const
export type ModelFilter = (typeof MODEL_FILTERS)[number]

type Filterable = { size?: string; recommended?: string }

export function matchesModelFilter(model: Filterable, filter: ModelFilter) {
  if (filter === "recommended") return model.recommended !== undefined
  if (filter === "large" || filter === "small") return model.size === filter
  return true
}

export function useModelFilter() {
  const [store, setStore] = persisted(
    Persist.global("model-filter", ["model-filter.v1"]),
    createStore({ filter: "all" as ModelFilter }),
  )
  return {
    get: (): ModelFilter => (MODEL_FILTERS.includes(store.filter) ? store.filter : "all"),
    set: (filter: ModelFilter) => setStore("filter", filter),
  }
}

export function useModelFilterLabels() {
  const language = useLanguage()
  return (filter: ModelFilter | "medium") => language.t(`model.filter.${filter}`)
}

export function ModelFilterChips(props: { value: ModelFilter; onChange: (filter: ModelFilter) => void }) {
  const label = useModelFilterLabels()
  return (
    <div class="flex items-center gap-1 px-2 pb-1" role="radiogroup" aria-label={label("all")}>
      <For each={MODEL_FILTERS}>
        {(filter) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === filter}
            data-model-filter={filter}
            class="h-6 rounded-sm px-2 text-12-regular text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover aria-checked:bg-v2-overlay-simple-overlay-hover aria-checked:text-v2-text-text-base"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => props.onChange(filter)}
          >
            {label(filter)}
          </button>
        )}
      </For>
    </div>
  )
}
