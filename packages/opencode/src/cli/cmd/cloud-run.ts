import { EOL } from "os"
import { CloudWorkers } from "@/cloud/workers"
import { UI } from "../ui"

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
  if (found.uncommitted.length)
    say(
      `${found.uncommitted.length} uncommitted change(s) stay here; the worker starts from ${found.repo.commit.slice(0, 10)}`,
    )
  const named = secrets(options.secrets ?? [])
  say(`starting a ${options.size ?? "standard"} worker`)
  const started = await CloudWorkers.create({ config, repo: found.repo, size: options.size, secrets: named })
  const { worker } = started
  say(`${worker.id} running in ${worker.region}; results go to ${worker.branch}`)
  const end = async (outcome: string) => {
    const done = await CloudWorkers.finish(config, started.base, worker.id, outcome)
    say(
      done.pushed
        ? `${outcome}: results on ${done.branch}. Fetch them with: git fetch origin ${done.branch}`
        : `${outcome}: nothing changed, so there's no results branch`,
    )
    say(`${done.activeSeconds}s of active worker time`)
  }
  let stopping: Promise<unknown> | undefined
  const interrupted = () => {
    say(`interrupted; ending ${worker.id}`)
    stopping = end("interrupted")
      .catch((error) => say(`couldn't end ${worker.id}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => process.exit(130))
  }
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)
  const before = process.exitCode
  process.exitCode = undefined
  try {
    await client(CloudWorkers.connection(worker))
  } finally {
    if (stopping) await stopping
    process.off("SIGINT", interrupted)
    process.off("SIGTERM", interrupted)
    const failed = process.exitCode !== undefined && process.exitCode !== 0
    process.exitCode = failed ? process.exitCode : before
    await end(failed ? "failed" : "finished")
  }
}
