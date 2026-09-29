export * as ConfigSandbox from "./sandbox"

import { Schema } from "effect"

/**
 * Sandboxed runs (XCOD-144): run the Lunos server, and everything it spawns, in a Docker container.
 * Declared in both the v1 and v2 config schemas, so the live config path keeps it (the XCOD-68 /
 * XCOD-93 lesson). The isolation flags themselves are not configurable: config may choose the
 * image, resources and lifecycle, never capabilities or mounts.
 */
export const Resources = Schema.Struct({
  cpus: Schema.Number.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: "CPUs the sandbox may use (docker --cpus). Default 2",
  }),
  memory: Schema.String.pipe(Schema.optional).annotate({
    description: 'Memory limit (docker --memory), e.g. "4g". Default "4g"',
  }),
  pids: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: "Most processes the sandbox may run at once (docker --pids-limit). Default 512",
  }),
  tmp: Schema.String.pipe(Schema.optional).annotate({
    description: 'Size of the in-memory /tmp (the only writable path besides the workspace), e.g. "1g". Default "1g"',
  }),
})

export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Run every session in a sandbox, as if --sandbox were passed. Off by default",
  }),
  image: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Container image with Lunos as its entry point. Default ghcr.io/axsiondev/lunos:<the CLI's version>. The image is pinned by digest when the sandbox is created",
  }),
  workspace: Schema.Literal("copy").pipe(Schema.optional).annotate({
    description:
      'How the project gets into the sandbox. "copy" (the only mode so far): cloned into a container volume at the current commit, with uncommitted changes applied; the host working tree is never mounted',
  }),
  on_finish: Schema.Literals(["destroy", "retain"]).pipe(Schema.optional).annotate({
    description:
      'What happens once the results are back on the host: "destroy" (default) removes the container and its volume, "retain" stops it so `lunos sandbox attach` can reopen it. A failed handoff always retains',
  }),
  resources: Resources.pipe(Schema.optional).annotate({
    description: "CPU, memory, process and /tmp limits for the sandbox container",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
