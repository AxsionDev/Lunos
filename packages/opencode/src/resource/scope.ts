export * as ResourceScope from "./scope"

import crypto from "node:crypto"
import type { InstanceContext } from "@/project/instance-context"

export interface Scope {
  /** Keys personal resources and the index on this computer. */
  id: string
  /** The folder shared resources' paths are relative to, and must stay inside. */
  directory: string
}

/**
 * The project a session's resources belong to (XCOD-300). For now that is the repository, which
 * is a project with no setup.
 *
 * XCOD-298: swap this for `ProjectGroup.resolve(directory)` once named projects land, so every
 * repository in a group shares its resources (`{ id: group.id, directory: <the folder whose
 * config holds them> }`).
 */
export function resourceScope(ctx: Pick<InstanceContext, "directory" | "worktree" | "project">): Scope {
  // A plain folder is the shared "global" project with worktree "/": key it by its own folder.
  if (ctx.worktree === "/" || ctx.project.id === "global")
    return {
      id: `dir-${crypto.createHash("sha256").update(ctx.directory).digest("hex").slice(0, 16)}`,
      directory: ctx.directory,
    }
  return { id: ctx.project.id, directory: ctx.worktree }
}
