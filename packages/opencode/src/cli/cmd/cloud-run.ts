import { EOL } from "os"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { CloudWorkers } from "@/cloud/workers"
import { UI } from "../ui"
import { RunEnding } from "./run/ending"

// XCOD-186: `lunos run --cloud`. The run goes to a Lunos Cloud worker, which clones the repository
// at the current (pushed) commit; this machine attaches to the worker's server the way
// `lunos run --sandbox` attaches to a container's, and the results come back as lunos/cloud/<id>.

const say = (line: string) => process.stderr.write(UI.Style.TEXT_DIM + `cloud: ${line}` + UI.Style.TEXT_NORMAL + EOL)

type Config = Parameters<typeof CloudWorkers.create>[0]["config"]

/** `--cloud-secret NAME` takes the value from this machine's environment, and only that one. */
export function secrets(names: readonly string[], env: Record<string, string | undefined> = process.env) {
  const missing = names.filter((name) => env[name] === undefined)
  if (missing.length) throw new CloudWorkers.RefusedError(`--cloud-secret: ${missing.join(", ")} isn't set here`)
  return Object.fromEntries(names.map((name) => [name, env[name]!]))
}

export async function runCloud(
  directory: string,
  config: Config,
  options: { size?: "standard" | "large"; secrets?: readonly string[] },
  client: (conn: ReturnType<typeof CloudWorkers.connection>) => Promise<void>,
) {
  const found = await CloudWorkers.repo(directory, config)
  if (found.strippedCredentials) say("the remote URL has a user name or token in it; it isn't sent")
  if (found.uncommitted.length)
    say(
      `${found.uncommitted.length} uncommitted change(s) stay here; the worker starts from ${found.repo.commit.slice(0, 10)}`,
    )
  const named = secrets(options.secrets ?? [])
  const base = CloudWorkers.endpoint(config)
  // The id is known before the request, so Ctrl+C while the worker starts can still end it.
  const id = CloudWorkers.newID()
  const end = async (outcome: string) => {
    const done = await CloudWorkers.finish(config, base, id, outcome)
    say(
      done.pushed
        ? `${outcome}: results on ${done.branch}. Fetch them with: git fetch origin ${done.branch}`
        : `${outcome}: nothing changed, so there's no results branch`,
    )
    say(`${done.activeSeconds}s of active worker time`)
  }
  let stopping: Promise<unknown> | undefined
  const interrupted = () => {
    RunEnding.interrupted = true
    say(`interrupted; ending ${id}`)
    stopping = end("interrupted")
      .catch((error) => say(`couldn't end ${id}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => process.exit(130))
  }
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)
  say(`starting a ${options.size ?? "standard"} worker`)
  const started = await CloudWorkers.create({ config, repo: found.repo, size: options.size, secrets: named }, id).catch(
    (error) => {
      process.off("SIGINT", interrupted)
      process.off("SIGTERM", interrupted)
      throw error
    },
  )
  const { worker } = started
  say(`${worker.id} running in ${worker.region}; results go to ${worker.branch}`)
  const before = process.exitCode
  process.exitCode = undefined
  let threw = false
  try {
    await client(CloudWorkers.connection(worker))
  } catch (error) {
    threw = true
    throw error
  } finally {
    if (stopping) await stopping
    process.off("SIGINT", interrupted)
    process.off("SIGTERM", interrupted)
    const failed = threw || (process.exitCode !== undefined && process.exitCode !== 0)
    process.exitCode = failed ? (process.exitCode ?? 1) : before
    await end(failed ? "failed" : "finished")
  }
}

/**
 * XCOD-236: `--model provider/model` on a cloud run must be a model the worker can run. Locally an
 * unavailable model is replaced by the next best one with a warning (XCOD-214); on a worker that
 * would quietly run a different model, usually because the provider's key wasn't sent. Asks the
 * worker's server, before any prompt, which providers and models it has loaded.
 */
export async function requireModel(
  conn: ReturnType<typeof CloudWorkers.connection>,
  model: string,
  fetcher?: typeof fetch,
) {
  const [providerID, ...rest] = model.split("/")
  const modelID = rest.join("/")
  const sdk = createOpencodeClient({
    baseUrl: conn.url,
    headers: conn.headers,
    directory: conn.directory,
    ...(fetcher ? { fetch: fetcher } : {}),
  })
  const loaded = await sdk.config.providers().catch(() => undefined)
  if (!loaded?.data)
    throw new CloudWorkers.ServiceError(0, "worker", `Couldn't ask the worker which models it has, to check ${model}.`)
  const provider = loaded.data.providers.find((item) => item.id === providerID)
  if (provider && modelID in provider.models) return
  if (provider)
    throw new CloudWorkers.RefusedError(
      `Model "${model}" can't run on the worker: it has no model "${modelID}" for ${providerID}. See \`lunos models ${providerID}\`.`,
    )
  // The provider's key variables, from the worker's catalogue, so the hint names what to send.
  const all = await sdk.provider
    .list()
    .then((result) => result.data?.all ?? [])
    .catch(() => [])
  const env = all.find((item) => item.id === providerID)?.env ?? []
  throw new CloudWorkers.RefusedError(
    `Model "${model}" can't run on the worker: provider ${providerID} isn't set up there. Its key stays on this machine unless you send it for this run: ${env.length ? `--cloud-secret ${env.join(",")}` : "--cloud-secret NAME, NAME being the variable that holds it"}.`,
  )
}
