import { randomBytes } from "node:crypto"
import { Effect, Schema } from "effect"
import type { WorkspaceAdapter, WorkspaceAdapterContext } from "../types"

// XCOD-186: a workspace on a Lunos Cloud worker. The worker clones the repository at the current
// commit and runs a Lunos server; the workspace's target is that server. Removing the workspace ends
// the worker, which pushes the results to lunos/cloud/<id>. The control plane is commercial and
// external; this adapter only speaks its public API (CloudContract). No secrets are sent: the `env`
// the control plane passes here holds the user's stored provider keys, and they stay on this machine.

const CloudExtra = Schema.Struct({ worker: Schema.String, endpoint: Schema.optional(Schema.String) })
const decodeExtra = Schema.decodeUnknownSync(CloudExtra)

async function load() {
  const [{ CloudWorkers }, { Config }, { InstanceRef }, { AppRuntime }] = await Promise.all([
    import("@/cloud/workers"),
    import("@/config/config"),
    import("@/effect/instance-ref"),
    import("@/effect/app-runtime"),
  ])
  return { CloudWorkers, Config, InstanceRef, AppRuntime }
}

async function setup(context: WorkspaceAdapterContext | undefined) {
  if (!context?.instance) throw new Error("Lunos Cloud adapter requires an instance context")
  const { CloudWorkers, Config, InstanceRef, AppRuntime } = await load()
  const config = await AppRuntime.runPromise(
    Config.Service.use((cfg) => cfg.get()).pipe(Effect.provideService(InstanceRef, context.instance)),
  )
  return { CloudWorkers, config, directory: context.instance.directory }
}

export const CloudAdapter: WorkspaceAdapter = {
  name: "Lunos Cloud worker",
  description: "Run the workspace on a Lunos Cloud worker; results come back as branch lunos/cloud/<id>",
  configure(info) {
    // The id is chosen here, because configure's result is what the control plane stores.
    const id = randomBytes(6).toString("hex")
    return { ...info, name: id, branch: `lunos/cloud/${id}`, extra: { worker: id } }
  },
  async create(info, _env, _from, context) {
    const { CloudWorkers, config, directory } = await setup(context)
    const found = await CloudWorkers.repo(directory, config)
    await CloudWorkers.create({ config, repo: found.repo }, decodeExtra(info.extra).worker)
  },
  // No list(): it runs on every workspace sync, and must not make a network call each time.
  async remove(info, context) {
    const { CloudWorkers, config } = await setup(context)
    await CloudWorkers.finish(
      config,
      CloudWorkers.endpoint(config),
      decodeExtra(info.extra).worker,
      "workspace removed",
    )
  },
  async target(info, context) {
    const { CloudWorkers, config } = await setup(context)
    const worker = await CloudWorkers.get(CloudWorkers.endpoint(config), decodeExtra(info.extra).worker)
    const conn = CloudWorkers.connection(worker)
    return { type: "remote", url: conn.url, headers: conn.headers }
  },
}
