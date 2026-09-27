export * as MemoryModel from "./model"

import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Residency } from "@opencode-ai/core/residency"
import type { ConfigMemory } from "@opencode-ai/core/config/memory"

/**
 * The model memory extracts facts with (XCOD-94), following the XCOD-82 conventions: "inherit" is
 * the main agent's model, "small" is `small_model` (or inherit if that isn't set), and
 * "provider/model" is that model. The default is "small".
 */

export interface Model {
  providerID: string
  modelID: string
}

export class RefusedError extends Error {
  override name = "MemoryModelRefused"
}

function parse(spec: string): Model {
  const [providerID, ...rest] = spec.split("/")
  return { providerID, modelID: rest.join("/") }
}

export function resolve(input: {
  memory: ConfigMemory.Info | undefined
  small_model: string | undefined
  parent: Model
}): { model: Model; source: string } {
  const value = input.memory?.model ?? "small"
  const source = input.memory?.model === undefined ? "memory.model (default: small)" : "memory.model"
  if (value === "inherit") return { model: input.parent, source }
  if (value === "small") return { model: input.small_model ? parse(input.small_model) : input.parent, source }
  if (!value.includes("/"))
    throw new RefusedError(`memory.model must be "inherit", "small" or "provider/model"; got "${value}"`)
  return { model: parse(value), source }
}

/** Only "local" embeddings exist so far. Anything else is refused rather than silently ignored. */
export function checkEmbedding(memory: ConfigMemory.Info | undefined) {
  const value = memory?.embedding ?? "local"
  if (value !== "local")
    throw new RefusedError(
      `memory.embedding "${value}" is not supported yet. Only "local" embeddings are available, which compute on this machine`,
    )
}

/**
 * Check the memory model against the residency policy before the sidecar starts. A denial is
 * written to the audit log like any other denied call, and the error names the setting that chose
 * the model.
 */
export function checkResidency(resolved: { model: Model; source: string }, residency: Residency.Resolved | undefined) {
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
