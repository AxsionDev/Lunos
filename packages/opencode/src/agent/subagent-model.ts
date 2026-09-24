export * as SubagentModel from "./subagent-model"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Residency } from "@opencode-ai/core/residency"

/**
 * Which model a subagent runs on, and which rule chose it (XCOD-82). First match wins:
 *
 * 1. `per-call`: the main agent's `model` argument, only when `subagent.dynamic.enabled` and the
 *    model is on `subagent.dynamic.allow`. Anything else is refused, never silently replaced.
 * 2. `per-type`: `agent.<subagent_type>.model`.
 * 3. `global`: `subagent.model`.
 * 4. `inherit`: the main agent's current model. This is the default and matches upstream.
 *
 * Values: `"inherit"` means the main agent's model, `"small"` means `small_model` (or inherit if
 * that isn't set), and `"provider/model"` means that exact model.
 */

export type Rule = "per-call" | "per-type" | "global" | "inherit"

export interface Model {
  providerID: string
  modelID: string
}

export interface Input {
  readonly subagentType: string
  /** The main agent's current model and reasoning variant. */
  readonly parent: Model & { variant?: string }
  readonly perCall?: string
  /** Raw `agent.<type>.model` / `agent.<type>.variant` from config. */
  readonly typeModel?: string
  readonly typeVariant?: string
  readonly config: {
    readonly small_model?: string
    readonly subagent?: {
      readonly model?: string
      readonly variant?: string
      readonly dynamic?: { readonly enabled?: boolean; readonly allow?: readonly string[] }
    }
  }
}

export interface Resolved {
  readonly model: Model
  readonly variant: string | undefined
  readonly rule: Rule
  /** Human-readable name of the rule, e.g. `agent.qa.model` or `subagent.model`. */
  readonly source: string
}

export class RefusedError extends Error {
  override name = "SubagentModelRefused"
}

function parse(spec: string): Model {
  const [providerID, ...rest] = spec.split("/")
  return { providerID, modelID: rest.join("/") }
}

function resolveValue(value: string, input: Input): { model: Model; inherited: boolean } {
  const parent = { providerID: input.parent.providerID, modelID: input.parent.modelID }
  if (value === "inherit") return { model: parent, inherited: true }
  if (value === "small") {
    if (input.config.small_model) return { model: parse(input.config.small_model), inherited: false }
    return { model: parent, inherited: true }
  }
  return { model: parse(value), inherited: false }
}

/** Models the main agent may pick per call. Empty unless dynamic selection is enabled. */
export function allowed(config: Input["config"], residency?: Residency.Resolved): string[] {
  const dynamic = config.subagent?.dynamic
  if (!dynamic?.enabled) return []
  const list = [...new Set(dynamic.allow ?? [])]
  if (!residency) return list
  return list.filter((spec) => Residency.evaluate(parse(spec).providerID, residency.policy).allowed)
}

export function resolve(input: Input): Resolved {
  const configuredVariant = (explicit?: string) => {
    const value = explicit ?? input.config.subagent?.variant
    return value === undefined || value === "inherit" ? undefined : value
  }
  const finish = (value: string, rule: Rule, source: string, explicitVariant?: string): Resolved => {
    const { model, inherited } = resolveValue(value, input)
    const variant = configuredVariant(explicitVariant)
    // An inherited model keeps the main agent's reasoning effort unless a variant is configured.
    // An overridden model uses the configured variant, or the model's default.
    return { model, variant: variant ?? (inherited ? input.parent.variant : undefined), rule, source }
  }

  if (input.perCall !== undefined) {
    const allow = input.config.subagent?.dynamic?.allow ?? []
    if (!input.config.subagent?.dynamic?.enabled)
      throw new RefusedError(`Choosing a model per task is disabled. Set "subagent.dynamic.enabled" to allow it.`)
    if (!allow.includes(input.perCall))
      throw new RefusedError(
        `Model "${input.perCall}" is not on subagent.dynamic.allow. Choose one of: ${allow.join(", ") || "(none)"}.`,
      )
    return finish(input.perCall, "per-call", "task model", input.typeVariant)
  }
  if (input.typeModel !== undefined)
    return finish(input.typeModel, "per-type", `agent.${input.subagentType}.model`, input.typeVariant)
  if (input.config.subagent?.model !== undefined)
    return finish(input.config.subagent.model, "global", "subagent.model", input.typeVariant)
  return finish("inherit", "inherit", "inherit", input.typeVariant)
}

/**
 * Check the resolved model against the residency policy before the subagent session starts.
 * A denial is written to the residency audit log like any other denied call, and the error
 * names the rule that chose the model.
 */
export function checkResidency(resolved: Resolved, residency: Residency.Resolved | undefined) {
  if (!residency) return
  try {
    Residency.enforce({
      providerID: resolved.model.providerID,
      baseURL: "",
      resolved: residency,
      defaultAuditPath: path.join(Global.Path.log, "residency-egress.log"),
      fetch: undefined,
    })
  } catch (error) {
    if (!(error instanceof Residency.DeniedError)) throw error
    throw new RefusedError(
      `${resolved.source} → ${resolved.model.providerID}/${resolved.model.modelID} denied by residency policy. ${error.decision.reason}`,
    )
  }
}
