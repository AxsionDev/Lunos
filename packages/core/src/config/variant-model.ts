export * as VariantModel from "./variant-model"

/**
 * XCOD-232: which model a configured reasoning variant (`subagent.variant`,
 * `agent.<name>.variant`) applies to, so the /settings picker and `lunos settings set` offer and
 * accept the same variant names. Mirrors how a run picks the model: an agent's own model, else (for
 * a subagent) `subagent.model`, else the main model; "small" is `small_model`.
 */

export type Config = {
  model?: string
  small_model?: string
  subagent?: { model?: string }
}

export type Input = {
  /** `subagent.variant` or `agent.<name>.variant`. */
  key: string
  config: Config
  /** The main model when `model` isn't set (the server's default, or the TUI's current model). */
  main?: string
  /** For `agent.<name>.variant`: that agent's model as configured, and whether it runs as a subagent. */
  agent?: { model?: string; subagent: boolean }
}

/** `"provider/model"`, or undefined when no model can be named (nothing configured or available). */
export function applicable(input: Input): string | undefined {
  const main = input.config.model ?? input.main
  const spec = (value: string | undefined) => {
    if (value === undefined || value === "inherit") return main
    if (value === "small") return input.config.small_model ?? main
    return value
  }
  if (input.key === "subagent.variant") return spec(input.config.subagent?.model)
  const own = input.agent?.model
  if (own !== undefined) return spec(own)
  return input.agent?.subagent ? spec(input.config.subagent?.model) : main
}

/** Whether `key` names a reasoning variant setting. */
export function isVariantKey(key: string) {
  return key === "subagent.variant" || /^agent\.[^.]+\.variant$/.test(key)
}

/**
 * Why `value` can't be the variant for `model`, listing the ones it has; undefined when it can.
 * "inherit" is always fine (the main agent's effort, or the model's default).
 */
export function problem(key: string, value: string, model: string, variants: readonly string[]) {
  if (value === "inherit" || variants.includes(value)) return
  if (variants.length === 0)
    return `${key}: ${model} has no reasoning variants, so "${value}" can't be used. Use "inherit", or unset it`
  return `${key}: "${value}" isn't a reasoning variant of ${model}. Valid: ${variants.join(", ")}, or "inherit"`
}
