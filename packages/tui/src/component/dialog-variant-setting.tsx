import { VariantModel } from "@opencode-ai/core/config/variant-model"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"

// XCOD-232: a reasoning variant setting (`subagent.variant`, `agent.<name>.variant`) is picked from
// the variants of the model it applies to, with the names the session's variant switcher uses.

export type VariantAgent = { model?: string; subagent: boolean }

/** The model a variant key applies to, and its variant names (none known: an empty list). */
export function useVariantModel() {
  const sync = useSync()
  const local = useLocal()
  return (key: string, agent?: VariantAgent) => {
    const current = local.model.current()
    const config = sync.data.config as VariantModel.Config
    const model = VariantModel.applicable({
      key,
      config,
      main: current ? `${current.providerID}/${current.modelID}` : undefined,
      agent,
    })
    if (!model) return undefined
    const slash = model.indexOf("/")
    const info = sync.data.provider.find((item) => item.id === model.slice(0, slash))?.models[model.slice(slash + 1)]
    return { model, variants: Object.keys(info?.variants ?? {}) }
  }
}

/** The warning a saved variant gets when the model it applies to doesn't have it; undefined when fine. */
export function variantWarning(value: unknown, applies: { model: string; variants: string[] } | undefined) {
  if (typeof value !== "string" || value === "inherit" || !applies) return
  if (applies.variants.includes(value)) return
  return `not available for ${applies.model}`
}

export function DialogVariantSetting(props: {
  title: string
  settingKey: string
  scope: string
  current?: string
  applies?: { model: string; variants: string[] }
  onPick: (value: string) => void
  onClear: () => void
}) {
  const toast = useToast()
  const variants = props.applies?.variants ?? []
  const model = props.applies?.model ?? "the model"
  const missing = variantWarning(props.current, props.applies)
  return (
    <DialogSelect<string>
      title={props.title}
      placeholder={missing ? `"${props.current}" is ${missing}` : `Reasoning effort on ${model}`}
      skipFilter
      current={props.current ?? "inherit"}
      options={[
        {
          title: "Inherit",
          value: "inherit",
          description: "(default)",
          category: model,
        },
        ...(variants.length
          ? variants.map((name) => ({ title: name, value: name, category: model }))
          : [{ title: "This model has no reasoning variants", value: "+none", category: model }]),
        {
          title: "Clear",
          value: "+clear",
          description: `remove ${props.settingKey} from ${props.scope} config`,
          category: "Actions",
        },
      ]}
      onSelect={(option) => {
        if (option.value === "+none")
          return toast.show({ variant: "info", message: `${model} has no reasoning variants: pick Inherit or Clear` })
        if (option.value === "+clear") return props.onClear()
        props.onPick(option.value)
      }}
    />
  )
}
