export * as ConfigSandbox from "./sandbox"

import { Schema } from "effect"

/**
 * Sandboxed runs (XCOD-144): run the Lunos server, and everything it spawns, in a Docker container.
 * Declared in both the v1 and v2 config schemas, so the live config path keeps it (the XCOD-68 /
 * XCOD-93 lesson). The isolation flags themselves are not configurable: config may choose the
 * image, resources and lifecycle, never capabilities. XCOD-158: your global and managed config (never
 * a repository's) may bind-mount the project (`workspace: "mount"`) and add read-only mounts.
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
    description:
      "Run `lunos` and `lunos run` in a sandbox, as if --sandbox were passed (--no-sandbox overrides it for one run). Any config layer turning it on wins. Other commands, such as serve, web and acp, still run on the host. Off by default",
  }),
  required: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      'Nothing runs on this machine except in a sandbox: `lunos` and `lunos run` always start one, --no-sandbox is refused, `lunos serve`, `web`, `acp`, `github` and `pr` refuse to start, and any agent tool call outside a sandbox is refused. Meant for managed config, locked with "$locked": ["sandbox.required"]. Off by default',
  }),
  image: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Container image with Lunos as its entry point. Default ghcr.io/axsiondev/lunos:<the CLI's version>. The image is pinned by digest when the sandbox is created",
  }),
  workspace: Schema.Literals(["copy", "mount"]).pipe(Schema.optional).annotate({
    description:
      'How the project gets into the sandbox. "copy" (default): cloned into a container volume at the current commit, with uncommitted changes applied; the host working tree is never mounted. "mount": your working tree itself, bind-mounted read-write, so the agent\'s changes are in it as they happen (no branch or patch); .git and Lunos\'s own config stay read-only. Reduced isolation, and a warning is shown. Read from your global and managed config only, never a repository\'s',
  }),
  devcontainer: Schema.Literals(["off", "image", "build"]).pipe(Schema.optional).annotate({
    description:
      'Use the project\'s .devcontainer/devcontainer.json for the sandbox\'s toolchain, unless the project\'s own config sets sandbox.image. A sandbox.image in your global or managed config is the Lunos image the devcontainer gets Lunos from. "image" (default): its `image`, with Lunos added (nothing of the image runs on this machine). "build": also its `build` (Dockerfile), which runs the repository\'s build steps on this machine, with the network open; only your global or managed config can choose it. "off": ignore it. A repository\'s config can only turn it off',
  }),
  mounts: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        source: Schema.String.annotate({ description: "Absolute path on this machine" }),
        target: Schema.String.pipe(Schema.optional).annotate({
          description: "Absolute path in the sandbox. Default: the same as source",
        }),
      }),
    ),
  )
    .pipe(Schema.optional)
    .annotate({
      description:
        "Extra directories mounted read-only into the sandbox, e.g. a package cache. Read from your global and managed config only, never a repository's. Your home directory itself, /, SSH keys and container runtime sockets are refused",
    }),
  on_finish: Schema.Literals(["destroy", "retain", "destroy_on_success"]).pipe(Schema.optional).annotate({
    description:
      'What happens once the results are back on the host: "destroy" (default) removes the container and its volume, "retain" stops it so `lunos sandbox attach` can reopen it, "destroy_on_success" keeps it only when the task failed. --keep and --rm override it for one run. A failed handoff always retains',
  }),
  retain_for: Schema.String.check(Schema.isPattern(/^\d+[mhd]$/))
    .pipe(Schema.optional)
    .annotate({
      description:
        'How long a retained sandbox is kept, e.g. "72h", "30m" or "7d". Once it has expired, `lunos sandbox prune` removes it, and so does the next sandboxed run or `lunos sandbox` command. Unset: kept until destroyed',
    }),
  network: Schema.Literals(["policy", "none", "open"]).pipe(Schema.optional).annotate({
    description:
      'What the sandbox can reach. "policy" (default): only the model endpoints the residency policy allows, remote MCP servers, the npm registry and sandbox.allow, enforced by an egress proxy outside the container. "none": nothing. "open": anything this machine can reach (a warning is shown). A repository\'s config can only make it stricter',
  }),
  allow: Schema.mutable(Schema.Array(Schema.String)).pipe(Schema.optional).annotate({
    description:
      'Extra hosts the sandbox may reach under network "policy", as "host" (port 443) or "host:port". Read from your global and managed config only, never a repository\'s',
  }),
  results: Schema.Literals(["branch", "patch", "none"]).pipe(Schema.optional).annotate({
    description:
      'How the agent\'s changes come back: "branch" (default) as branch lunos/sandbox/<id>, "patch" as .opencode/sandbox/<id>/changes.patch (only the agent\'s changes, for `git apply`), "none" not at all. The transcript and summary always come back',
  }),
  runtime: Schema.Literals(["docker", "podman"]).pipe(Schema.optional).annotate({
    description: "The container runtime. Unset: Docker if it's available, else Podman",
  }),
  resources: Resources.pipe(Schema.optional).annotate({
    description: "CPU, memory, process and /tmp limits for the sandbox container",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
