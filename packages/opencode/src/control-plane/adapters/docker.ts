import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import type { WorkspaceAdapter, WorkspaceAdapterContext } from "../types"

// XCOD-144: a workspace backed by a Lunos server in a Docker container (the sandbox). The project is
// copied into a container volume (copy mode), the server's target is remote, and removing the
// workspace destroys the container and volume. `lunos run --sandbox` / `lunos --sandbox` drive the
// same Sandbox module directly; this adapter exposes it to the workspace control plane.

const DockerExtra = Schema.Struct({ sandbox: Schema.String })
const decodeExtra = Schema.decodeUnknownSync(DockerExtra)

async function load() {
  const [{ Sandbox }, { SandboxConfig }] = await Promise.all([import("@/sandbox"), import("@/sandbox/config")])
  return { Sandbox, SandboxConfig }
}

function directoryOf(context: WorkspaceAdapterContext | undefined) {
  if (!context?.instance) throw new Error("Docker adapter requires an instance context")
  return context.instance.directory
}

export const DockerAdapter: WorkspaceAdapter = {
  name: "Docker sandbox",
  description: "Run the workspace in an isolated Docker container, with the project copied in",
  // The sandbox id is chosen here, because configure's result is what the control plane stores.
  configure(info) {
    const id = randomBytes(4).toString("hex")
    return { ...info, name: id, branch: `lunos/sandbox/${id}`, extra: { sandbox: id } }
  },
  async create(info, env, _from, context) {
    const { Sandbox, SandboxConfig } = await load()
    const directory = directoryOf(context)
    const secrets = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
    // XCOD-158: as `lunos run --sandbox` does. Expired sandboxes go first, and the providers you've
    // stored with `lunos auth` (in OPENCODE_AUTH_CONTENT) go on the egress allow list, or under the
    // default network policy the session would lose its model once warped in.
    await Sandbox.prune().catch(() => [])
    const stored = secrets.OPENCODE_AUTH_CONTENT ? Object.keys(JSON.parse(secrets.OPENCODE_AUTH_CONTENT)) : []
    const sandbox = await Sandbox.create({
      id: decodeExtra(info.extra).sandbox,
      directory,
      config: SandboxConfig.load(directory),
      providers: stored,
    })
    await Sandbox.start(sandbox, { secrets })
  },
  // Called on every workspace syncList, for every project, so it must not shell out to Docker
  // (which can be absent, or slow to answer): it reads the host-side sandbox metadata only.
  async list(context) {
    const { Sandbox } = await load()
    const project = context?.instance?.project.id
    if (!project) return []
    // XCOD-158: a sandbox whose results have been handed back has ended. If on_finish kept it, it's
    // stopped, so it can't serve a warp; `lunos sandbox attach` reopens it.
    return (await Sandbox.known())
      .filter((meta) => meta.root === context?.instance?.worktree && !meta.handedOff)
      .map((meta) => ({
        type: "docker",
        name: meta.id,
        branch: meta.branch,
        directory: meta.directory,
        extra: { sandbox: meta.id },
        projectID: project,
      }))
  },
  // Nothing is destroyed until the results are back on the host: hand them back first (as
  // sandbox.results says, plus the transcript), then apply sandbox.on_finish, as `lunos run --sandbox`
  // does. If the handoff fails, the sandbox is kept, stopped, and the error thrown.
  async remove(info) {
    const { Sandbox } = await load()
    const id = decodeExtra(info.extra).sandbox
    const meta = await Sandbox.meta(id).catch(() => undefined)
    if (!meta || !(await Sandbox.SandboxDocker.exists(id))) return Sandbox.destroy(id)
    const conn = await Sandbox.start(meta)
    const result = await Sandbox.handoff(meta, conn, { outcome: "workspace removed" }).catch(async (error) => {
      await Sandbox.retain(meta, "handoff failed")
      throw error
    })
    await Sandbox.finish(meta, { failed: result.failed, commit: result.commit, files: result.files.length })
  },
  async target(info) {
    const { Sandbox } = await load()
    const meta = await Sandbox.meta(decodeExtra(info.extra).sandbox)
    const port = await Sandbox.SandboxDocker.hostPort(meta.id)
    const conn = Sandbox.connection(meta, port)
    return { type: "remote", url: conn.url, headers: conn.headers }
  },
}
