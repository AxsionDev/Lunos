import { SandboxConfig } from "./config"
import { SandboxDocker } from "./docker"
import { SandboxExec } from "./exec"
import { SandboxGit } from "./git"
import { SandboxMount } from "./mount"
import { SandboxError, SandboxFailure } from "./error"

// XCOD-279: the checks a sandbox needs to start, run before anything is saved or started. Turning
// the sandbox on in /settings runs the quick form (no download), and is refused when one fails;
// `lunos sandbox doctor` runs the full form, which pulls the image and starts a throwaway container.

export type Check = {
  name: string
  status: "pass" | "fail" | "skip"
  detail: string
  fix?: string
  error?: SandboxError
}

/** How long the registry gets to answer whether the image can be pulled (quick form). */
export const MANIFEST_TIMEOUT = 30_000
/** How long the throwaway container gets to start and exit. */
export const SMOKE_TIMEOUT = 60_000

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail })
const skip = (name: string, detail: string): Check => ({ name, status: "skip", detail })
const fail = (name: string, error: SandboxError): Check => ({
  name,
  status: "fail",
  detail: error.reason,
  fix: error.fix,
  error,
})

const RUNTIME_ROWS = [
  ["installed", "container runtime installed"],
  ["running", "container engine running"],
  ["linux", "Linux containers"],
] as const

async function runtimeChecks(config: SandboxConfig.Resolved): Promise<{ checks: Check[]; ok: boolean }> {
  const { runtime, tried } = await SandboxDocker.detect(config.runtime)
  if (runtime)
    return {
      ok: true,
      checks: [
        pass(RUNTIME_ROWS[0][1], `${runtime.name} (${runtime.version})`),
        pass(RUNTIME_ROWS[1][1], "it answers"),
        pass(RUNTIME_ROWS[2][1], "yes"),
      ],
    }
  // The runtime that got furthest decides the rows: a stopped Docker says more than a missing Podman.
  const stages = RUNTIME_ROWS.map((row) => row[0] as string)
  const best = [...tried].sort((a, b) => stages.indexOf(b.stage) - stages.indexOf(a.stage))[0]
  const at = stages.indexOf(best.stage)
  return {
    ok: false,
    checks: RUNTIME_ROWS.map(([, name], index) =>
      index < at ? pass(name, best.name) : index === at ? fail(name, best.error) : skip(name, "needs the step above"),
    ),
  }
}

/** Whether `ref` is already here. */
const present = async (ref: string) =>
  (await SandboxExec.run([SandboxDocker.bin(), "image", "inspect", ref, "--format", "{{.Id}}"])).code === 0

async function imageCheck(ref: string, full: boolean): Promise<Check> {
  const name = `image ${ref}`
  if (await present(ref)) return pass(name, "here")
  if (full) {
    try {
      await SandboxDocker.image(ref)
      return pass(name, "pulled")
    } catch (error) {
      return fail(name, SandboxFailure.wrap("image", error))
    }
  }
  // Quick form: ask the registry without downloading. A runtime without `manifest inspect` (or a
  // registry that won't say) isn't a failure: the image is then pulled at the first start.
  const command = [SandboxDocker.bin(), "manifest", "inspect", ref]
  const result = await SandboxExec.run(command, { timeout: MANIFEST_TIMEOUT })
  if (result.code === 0) return pass(name, "not here yet; it can be pulled")
  const output = result.stderr.trim() || result.stdout.trim()
  const known = SandboxFailure.diagnose(output)
  const refusing =
    /denied|unauthorized|authentication required|forbidden|manifest unknown|not found|no such host|dial tcp/i
  if (!known || !refusing.test(output)) return pass(name, "not here yet; pulled at the first start (not checked)")
  return fail(name, SandboxFailure.wrap("image", SandboxExec.failure(command, result)))
}

async function smoke(ref: string): Promise<Check> {
  const name = "test container"
  const command = [
    SandboxDocker.bin(),
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    SandboxDocker.UID,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--entrypoint",
    "/bin/sh",
    ref,
    "-c",
    "true",
  ]
  const result = await SandboxExec.run(command, { timeout: SMOKE_TIMEOUT }).catch((error: unknown) =>
    SandboxFailure.wrap("start", error),
  )
  if (result instanceof SandboxError) return fail(name, result)
  if (result.code === 0) return pass(name, "a locked-down container started and exited")
  return fail(name, SandboxFailure.wrap("start", SandboxExec.failure(command, result)))
}

const GIT_FIX =
  "Install Git (https://git-scm.com/downloads; on Windows, Git for Windows), open a new terminal, and try again. " +
  "The sandbox uses it to copy your files in and hand the results back."

async function gitCheck(): Promise<Check> {
  const name = "git installed"
  const command = ["git", "--version"]
  const result = await SandboxExec.run(command).catch((error: unknown) => SandboxFailure.wrap("detect", error))
  if (!(result instanceof SandboxError) && result.code === 0) return pass(name, result.stdout.trim())
  const error = result instanceof SandboxError ? result : SandboxExec.failure(command, result)
  return fail(
    name,
    new SandboxError({ step: "detect", reason: error.reason, command: error.command, code: error.code, fix: GIT_FIX }),
  )
}

/** What the sandbox would start from here, without writing anything. */
async function workspaceCheck(directory: string) {
  const found = await SandboxGit.locate(directory)
  if (found.source === "git")
    return { root: found.root, detail: `git repository (${found.root} at ${found.base.slice(0, 12)})` }
  const survey = await SandboxGit.surveyFolder(found.root)
  return { root: found.root, detail: `plain folder (${SandboxGit.describeSurvey(survey)})` }
}

/**
 * Every check, in order; later ones are skipped once one they depend on fails. `full` pulls the
 * image when it isn't here, so the test container always runs.
 */
export async function run(input: {
  directory: string
  full: boolean
  config?: SandboxConfig.Resolved
}): Promise<Check[]> {
  const config = input.config ?? SandboxConfig.load(input.directory)
  const runtime = await runtimeChecks(config)
  const checks = [...runtime.checks]

  // XCOD-282: git copies the workspace in and the results back, a repository or not.
  const git = await gitCheck()
  checks.push(git)
  const gitOk = git.status === "pass"

  const workspace = gitOk
    ? await workspaceCheck(input.directory).catch((error: unknown) => SandboxFailure.wrap("detect", error))
    : undefined
  if (!workspace) checks.push(skip("workspace", "needs git"))
  else if (workspace instanceof SandboxError) checks.push(fail("workspace", workspace))
  else checks.push(pass("workspace", workspace.detail))

  const located = workspace && !(workspace instanceof SandboxError) ? workspace : undefined
  if (config.workspace !== "mount") checks.push(pass("workspace mode", "copy"))
  else if (!located) checks.push(skip("workspace mode", "needs the workspace check to pass"))
  else if (!runtime.ok) checks.push(skip("workspace mode", "needs a working container runtime"))
  else {
    const mount = await Promise.all([SandboxMount.workspace(located.root), SandboxDocker.mountIdentity()]).catch(
      (error: unknown) => SandboxFailure.wrap("create", error),
    )
    checks.push(mount instanceof SandboxError ? fail("workspace mode", mount) : pass("workspace mode", "mount"))
  }

  const images = [...new Set([config.egressImage, config.image])]
  if (!runtime.ok) {
    for (const ref of images) checks.push(skip(`image ${ref}`, "needs a working container runtime"))
    checks.push(skip("test container", "needs a working container runtime"))
    return checks
  }
  for (const ref of images) checks.push(await imageCheck(ref, input.full))
  if (await present(config.egressImage)) checks.push(await smoke(config.egressImage))
  else checks.push(skip("test container", "the image isn't here yet"))
  return checks
}

/**
 * Why the sandbox can't be turned on here, or undefined. Short enough for a toast: the fix first
 * when there is one, else the failed check's reason; `doctor` shows the command and its output.
 */
export async function refusal(directory: string, config?: SandboxConfig.Resolved) {
  const failed = (await run({ directory, full: false, config })).find((check) => check.status === "fail")
  if (!failed) return undefined
  return `${failed.fix ?? `${failed.name}: ${failed.detail}`}\n\`lunos sandbox doctor\` shows every check and the details.`
}

export * as SandboxPreflight from "./preflight"
