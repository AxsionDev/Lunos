import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useKV } from "../context/kv"

/** XCOD-212: shown on models the residency policy would refuse. */
const BLOCKED = "blocked by policy"

/** XCOD-213: picker filters, cycled with ctrl+l and remembered across restarts. */
export const MODEL_FILTERS = ["all", "recommended", "large", "small"] as const
export type ModelFilter = (typeof MODEL_FILTERS)[number]
const FILTER_LABEL: Record<ModelFilter, string> = {
  all: "All",
  recommended: "Recommended",
  large: "Large",
  small: "Small",
}
const SIZE_LABEL = { large: "Large", medium: "Medium", small: "Small" } as const

export function matchesFilter(model: { size?: string; recommended?: string }, filter: ModelFilter) {
  if (filter === "recommended") return model.recommended !== undefined
  if (filter === "large" || filter === "small") return model.size === filter
  return true
}

/** A choice listed before the models, e.g. "Inherit from main agent" (XCOD-214). */
export type DialogModelChoice = { title: string; description?: string; onSelect: () => void }

/**
 * `onPick` (XCOD-128, /settings) receives the choice instead of it becoming the session's model.
 * `choices`, `title` and `current` (XCOD-214) let /settings pick a subagent's model with it.
 */
export function DialogModel(props: {
  providerID?: string
  onPick?: (providerID: string, modelID: string) => void
  choices?: DialogModelChoice[]
  title?: string
  current?: { providerID: string; modelID: string }
}) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const kv = useKV()
  const activeFilter = (): ModelFilter => {
    const value = kv.get("model_filter", "all")
    return MODEL_FILTERS.includes(value) ? value : "all"
  }
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model || !matchesFilter(model, activeFilter())) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: [provider.name, model.size && SIZE_LABEL[model.size], model.blocked && BLOCKED]
              .filter(Boolean)
              .join(" · "),
            blocked: model.blocked !== undefined,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const blockedLast = <T extends { blocked: boolean }>(items: T[]) => sortBy(items, (item) => item.blocked)
    const favoriteOptions = blockedLast(toOptions(favorites, "Favorites"))
    const recentOptions = blockedLast(
      toOptions(
        recents.filter(
          (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
        ),
        "Recent",
      ),
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        // Residency is decided per provider, so providers with blocked models go last.
        (provider) => Object.values(provider.models).some((model) => model.blocked),
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          filter(([_, info]) => matchesFilter(info, activeFilter())),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            releaseDate: info.release_date,
            description:
              [
                favorites.some((item) => item.providerID === provider.id && item.modelID === model)
                  ? "(Favorite)"
                  : undefined,
                info.size ? `(${SIZE_LABEL[info.size]})` : undefined,
                info.blocked ? `(${BLOCKED})` : undefined,
              ]
                .filter(Boolean)
                .join(" ") || undefined,
            blocked: info.blocked !== undefined,
            // XCOD-213: why it's recommended, on its own line under the Recommended filter.
            details: activeFilter() === "recommended" && info.recommended ? [info.recommended] : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          filter((option) => {
            if (!showSections) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) => sortModelOptions(options, props.providerID !== undefined),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    const choiceOptions = (props.choices ?? [])
      .filter((choice) => !needle || fuzzysort.single(needle, choice.title))
      .map((choice, index) => ({
        value: { providerID: "", modelID: `choice:${index}` },
        title: choice.title,
        description: choice.description,
        category: needle ? undefined : "Choices",
        onSelect: choice.onSelect,
      }))

    if (needle) {
      return [
        ...choiceOptions,
        ...sortModelOptions(
          fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
          false,
        ),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...choiceOptions, ...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    const suffix = activeFilter() === "all" ? "" : ` · ${FILTER_LABEL[activeFilter()]}`
    if (props.title) return props.title + suffix
    if (!value) return "Select model" + suffix
    return value.name + suffix
  })

  function onSelect(providerID: string, modelID: string) {
    // Before `onPick`, so /settings' main, small and subagent model pickers refuse it too.
    const blocked = sync.data.provider.find((item) => item.id === providerID)?.models[modelID]?.blocked
    if (blocked) {
      toast.show({
        variant: "warning",
        title: `${providerID}/${modelID} is ${BLOCKED}`,
        message: `Data-residency policy: ${blocked.reason}`,
        duration: 8000,
      })
      return
    }
    if (props.onPick) return props.onPick(providerID, modelID)
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Add provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.filter",
          title: `Filter: ${FILTER_LABEL[activeFilter()]}`,
          withoutSelection: true,
          onTrigger() {
            const next = MODEL_FILTERS[(MODEL_FILTERS.indexOf(activeFilter()) + 1) % MODEL_FILTERS.length]
            kv.set("model_filter", next)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={props.current ?? local.model.current()}
    />
  )
}

export function sortModelOptions<
  T extends { footer?: string; releaseDate: string | number; title: string; blocked?: boolean },
>(options: T[], newestFirst: boolean) {
  if (newestFirst)
    return sortBy(
      options,
      (option) => option.blocked === true,
      [(option) => option.releaseDate, "desc"],
      (option) => option.title,
    )
  return sortBy(
    options,
    (option) => option.blocked === true,
    (option) => option.footer !== "Free",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}
