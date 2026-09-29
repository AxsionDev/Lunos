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
    const sandbox = await Sandbox.create({
      id: decodeExtra(info.extra).sandbox,
      directory,
      config: SandboxConfig.load(directory),
      secrets,
    })
    await Sandbox.start(sandbox)
  },
  async list(context) {
    const { Sandbox } = await load()
    const project = context?.instance?.project.id
    if (!project) return []
    return (await Sandbox.list())
      .filter((row) => row.meta && row.meta.root === context?.instance?.worktree)
      .map((row) => ({
        type: "docker",
        name: row.id,
        branch: row.meta?.branch ?? null,
        directory: row.meta?.directory ?? null,
        extra: { sandbox: row.id },
        projectID: project,
      }))
  },
  // Nothing is destroyed until the results are back on the host: hand them back first (branch plus
  // transcript), and if that fails, throw and keep the container.
  async remove(info) {
    const { Sandbox } = await load()
    const id = decodeExtra(info.extra).sandbox
    const meta = await Sandbox.meta(id).catch(() => undefined)
    if (meta && (await Sandbox.SandboxDocker.exists(id))) {
      const conn = await Sandbox.start(meta)
      await Sandbox.handoff(meta, conn, { outcome: "workspace removed" })
    }
    await Sandbox.destroy(id)
  },
  async target(info) {
    const { Sandbox } = await load()
    const meta = await Sandbox.meta(decodeExtra(info.extra).sandbox)
    const port = await Sandbox.SandboxDocker.hostPort(meta.id)
    const conn = Sandbox.connection(meta, port)
    return { type: "remote", url: conn.url, headers: conn.headers }
  },
}
