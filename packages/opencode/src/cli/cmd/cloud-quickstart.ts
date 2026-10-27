import { EOL } from "os"
import { spawn } from "node:child_process"
import { Effect } from "effect"
import { openUrl } from "@opencode-ai/core/open"
import { Offline } from "@opencode-ai/core/offline"
import { Config } from "@/config/config"
import { ConfigPolicy } from "@/config/policy"
import { CloudAccountApi } from "@/cloud/account-api"
import { CloudAuth } from "@/cloud/auth"
import { CloudDefaults } from "@/cloud/defaults"
import { CloudGitToken } from "@/cloud/git-token"
import { CloudQuickstart } from "@/cloud/quickstart"
import { CloudStore } from "@/cloud/store"
import { CloudSyncApi } from "@/cloud/sync-api"
import { CloudWorkers } from "@/cloud/workers"
import { selfCommand } from "../restart"
import { DEFAULT_CLIENT_ID, lineSignIn } from "./cloud"
import { effectCmd, fail } from "../effect-cmd"
import { cloudSecretNames } from "./run"
import { UI } from "../ui"

// XCOD-317: `lunos cloud quickstart`, from sign-up to a finished cloud run in one command. It signs
// in if needed, checks the plan (and offers the 14-day Pro trial), finds the repository's remote and
// offers to store a git token for its host, proposes a safe first task (or takes the user's), runs it
// with `lunos run --cloud` (the same command, streamed here), and prints where the results branch is.
// The TUI's "Try Lunos Cloud" runs this command. Each refusal says the next step in plain words.

const out = (line = "") => process.stdout.write(line + EOL)
const dim = (text: string) => UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL
const done = (text: string) => out(`${UI.Style.TEXT_SUCCESS_BOLD}✓${UI.Style.TEXT_NORMAL} ${text}`)
const step = (text: string) => out(`${UI.Style.TEXT_HIGHLIGHT_BOLD}›${UI.Style.TEXT_NORMAL} ${text}`)

/** Asks one line; undefined when cancelled (Ctrl+D, or no terminal). */
async function ask(question: string) {
  const { createInterface } = await import("readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl
    .question(question)
    .catch(() => undefined)
    .finally(() => rl.close())
}

/** A token typed at a hidden prompt (never echoed, never an argument). */
async function askSecret(question: string) {
  const prompts = await import("@clack/prompts")
  const value = await prompts.password({ message: question, validate: (x) => (x && x.trim() ? undefined : "Required") })
  return prompts.isCancel(value) ? undefined : String(value).trim()
}

/** `lunos run --cloud` on this terminal; stderr is passed through and kept, for the results line. */
async function runCloud(root: string, task: string, extra: string[]) {
  const self = selfCommand(["run", "--cloud", "--dir", root, ...extra, task])
  // Ctrl+C is for the run (it ends its worker); quickstart only waits.
  const ignore = () => {}
  process.on("SIGINT", ignore)
  try {
    return await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(self.argv[0]!, self.argv.slice(1), {
        cwd: root,
        env: self.env,
        stdio: ["inherit", "inherit", "pipe"],
        windowsVerbatimArguments: self.verbatim,
      })
      let stderr = ""
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
        process.stderr.write(chunk)
      })
      child.on("error", (error) => resolve({ code: 1, stderr: `${stderr}${error.message}` }))
      child.on("exit", (code) => resolve({ code: code ?? 1, stderr }))
    })
  } finally {
    process.off("SIGINT", ignore)
  }
}

export const CloudQuickstartCommand = effectCmd({
  command: "quickstart [task..]",
  describe: "your first Lunos Cloud run: sign in, plan, git token, a safe first task, and its results branch",
  builder: (yargs) =>
    yargs
      .positional("task", {
        type: "string",
        array: true,
        describe: "the task to run (default: a safe first task that adds one file)",
      })
      .option("dir", { type: "string", describe: "the repository (default: the current directory)" })
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "run the proposed first task without asking (it only adds a file)",
      })
      .option("browser", {
        type: "boolean",
        default: true,
        describe: "open sign-in and checkout pages (--no-browser just prints the links)",
      })
      .option("model", { type: "string", describe: "as lunos run --model: the model the run uses (provider/model)" })
      .option("cloud-secret", {
        // As run's: not `array: true`, which would swallow the task after it.
        type: "string",
        coerce: cloudSecretNames,
        describe: "as lunos run --cloud-secret: send this environment variable to the worker (e.g. a provider key)",
      }),
  directory: (args) => args.dir ?? process.cwd(),
  handler: Effect.fn("Cli.cloud.quickstart")(function* (args) {
    if (Offline.enabled()) return yield* fail(Offline.message("Lunos Cloud quickstart"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const dir = args.dir ?? process.cwd()
    const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY
    const given = (args.task ?? []).join(" ").trim()
    const result = yield* Effect.tryPromise({
      try: () =>
        quickstart({
          config,
          dir,
          interactive,
          task: given || undefined,
          yes: args.yes,
          browser: args.browser,
          run: [
            ...(args.model ? ["--model", args.model] : []),
            ...(args["cloud-secret"] ?? []).flatMap((name) => ["--cloud-secret", name]),
          ],
        }),
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
    if (result !== 0) process.exitCode = result
  }),
})

/** The next step, printed as the command's failure. */
class Stop extends Error {}

async function quickstart(input: {
  config: Parameters<typeof CloudWorkers.create>[0]["config"] & {
    cloud?: { issuer?: string; client_id?: string }
    sync?: unknown
    $locked?: readonly string[]
  }
  dir: string
  interactive: boolean
  task?: string
  yes: boolean
  browser: boolean
  /** Passed on to `lunos run --cloud`. */
  run: string[]
}) {
  const { config } = input
  out(UI.Style.TEXT_HIGHLIGHT_BOLD + "Lunos Cloud quickstart" + UI.Style.TEXT_NORMAL)

  // Where the run goes, and where the account is: the same control plane, or the checks mean nothing.
  const workers = CloudWorkers.endpoint(config)
  const base = await CloudSyncApi.endpoint()
  if (workers !== base)
    throw new Stop(
      `This repository's config sends cloud runs to ${workers}, but your Lunos account is checked at ${base}. Set cloud.endpoint in your user config (lunos settings set cloud.endpoint ${workers}), not in the project's.`,
    )
  // The repository first: a wrong folder or an unpushed commit is said before any sign-in or checkout.
  const found = await CloudWorkers.repo(input.dir, config)

  // 1. Signed in, as an account Lunos Cloud may be asked about.
  if (!(await CloudStore.load())) {
    if (!input.interactive) throw new Stop("Not signed in. Run lunos login, then lunos cloud quickstart again.")
    step("Sign in to Lunos (a free account; no card needed).")
    await lineSignIn({
      issuer: config.cloud?.issuer ?? CloudDefaults.DEFAULT_ISSUER,
      clientID: config.cloud?.client_id ?? DEFAULT_CLIENT_ID,
      browser: input.browser,
      syncLocked: config.sync === false && ConfigPolicy.isLocked(config.$locked, "sync"),
    })
  }
  const session = await CloudAuth.session("Lunos Cloud quickstart")
  const why = await CloudAccountApi.allowed(session.issuer)
  if (why) throw new Stop(`Lunos Cloud quickstart can't check your account: ${why}.`)
  // Asked again before each call: the checkout can take longer than an access token lasts.
  const token = async () => (await CloudAuth.session("Lunos Cloud quickstart")).tokens.access_token
  const opts = { endpoint: base }
  // An unverified address, a suspended account: refused here, in plain words (CloudAccountApi.explain).
  let account = await CloudQuickstart.account(await token(), opts)
  done(`Signed in${account.email ? ` as ${account.email}` : ""}, e-mail address verified.`)

  // 2. A plan, or the trial.
  if (CloudQuickstart.needsPlan(account)) {
    const words = account.member
      ? "Cloud runs need a plan: start the 14-day Pro trial for yourself, or ask an owner of your organisation to choose the Team plan."
      : "Cloud runs need a plan: start the 14-day Pro trial (cancel any time before it ends; local Lunos stays free)."
    if (!input.interactive) throw new Stop(`${words} Run lunos cloud quickstart in a terminal to start it.`)
    step(words)
    const answer = await ask("Start the trial now? [Y/n] ")
    if (answer === undefined || /^n(o)?$/i.test(answer.trim()))
      throw new Stop("No plan yet, so no cloud run. Run lunos cloud quickstart again when you want the trial.")
    const url = await CloudQuickstart.trial(await token(), opts)
    out(`Finish the checkout at ${url}`)
    if (input.browser) await openUrl(url).catch(() => undefined)
    out(dim("Waiting for the trial to start… (ctrl+c to stop; run lunos cloud quickstart again later)"))
    const deadline = Date.now() + 15 * 60_000
    while (CloudQuickstart.needsPlan(account)) {
      if (Date.now() > deadline)
        throw new Stop("The trial hasn't started yet. Once the checkout is done, run lunos cloud quickstart again.")
      await Bun.sleep(5000)
      account = await CloudQuickstart.account(await token(), opts)
    }
  }
  done(
    account.billing
      ? `Plan: ${account.plan}${account.planSource && account.planSource !== "personal" ? ` (${account.planSource}'s)` : ""}.`
      : "No plan needed on this Lunos Cloud.",
  )

  // 3. A git token for the repository's host.
  const host = CloudQuickstart.remoteHost(found.repo.url)
  if (!CloudQuickstart.localHost(host) && !account.gitHosts.includes(host!)) {
    if (!input.interactive) throw new Stop(CloudQuickstart.noGitToken(host!))
    step(
      `Lunos Cloud clones ${found.repo.url} and pushes the results with your own git token for ${host}; none is stored yet.`,
    )
    out(
      dim(
        host === "github.com"
          ? "A fine-grained token with Contents and Pull requests (read and write) on this repository is enough."
          : "A token that can read and push to this repository.",
      ),
    )
    const secret = await askSecret(
      `Git token for ${host} (input hidden; stored encrypted on Lunos Cloud, never shown again)`,
    )
    if (!secret) throw new Stop(CloudQuickstart.noGitToken(host!))
    await CloudGitToken.set({ host: host!, token: secret }, { endpoint: base })
  }
  done(
    CloudQuickstart.localHost(host)
      ? `Repository: ${found.repo.url} (no token needed).`
      : `Git token for ${host} stored.`,
  )

  // 4. The first task: the user's, or a safe one.
  let task = input.task
  if (!task) {
    step(`A safe first task (it only adds one file, LUNOS_CLOUD_HELLO.md):${EOL}  ${CloudQuickstart.SAFE_TASK}`)
    if (!input.yes) {
      if (!input.interactive) throw new Stop('Give a task (lunos cloud quickstart "…"), or --yes to run the one above.')
      const answer = await ask("Press enter to run it, or type your own task: ")
      if (answer === undefined) throw new Stop("Nothing was run.")
      task = answer.trim() || undefined
    }
    task ??= CloudQuickstart.SAFE_TASK
  }
  step(`Running it on Lunos Cloud from ${found.repo.commit.slice(0, 10)} (${found.repo.branch ?? "detached"}).`)
  const run = await runCloud(found.root, task, input.run)

  // 5. The results branch.
  const branch = CloudQuickstart.resultsBranch(run.stderr)
  if (branch) {
    const url = CloudQuickstart.branchUrl(found.repo.url, branch)
    done(`Results on ${branch}${url ? `: ${url}` : ""}`)
    out(dim(`Fetch them with: git fetch origin ${branch} && git diff HEAD..FETCH_HEAD`))
  } else if (run.code === 0) {
    out("The run changed nothing, so there's no results branch. Give it a task that changes a file to see one.")
  }
  if (run.code === 0) out(dim('Next: lunos run --cloud "<your task>" runs any task the same way.'))
  return run.code
}
