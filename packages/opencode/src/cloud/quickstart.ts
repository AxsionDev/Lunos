export * as CloudQuickstart from "./quickstart"

import { CloudAccountApi } from "./account-api"

/**
 * XCOD-317: `lunos cloud quickstart`, the guided path from sign-up to a finished `lunos run --cloud`
 * (cli/cmd/cloud-quickstart.ts runs it; the TUI's "Try Lunos Cloud" runs that command). The steps
 * are the console's checklist (lunoshq console/src/onboarding.ts): verified e-mail, a plan or the
 * trial, a git token for the repository's host, a first run, its results branch.
 *
 * What it reads comes from Lunos Cloud (`GET /v1/account`: `plan`, `billing`, `gitCredentials`), and
 * every refusal on the way says the next step in plain words, chosen by the refusal's code
 * (CloudAccountApi.explain). Nothing new is reported anywhere: the funnel is measured on the
 * control plane, from the steps themselves.
 */

/** The first task proposed when the user doesn't give one: it only adds a file, so it can't break anything, and it always leaves a results branch. */
export const SAFE_TASK =
  "Create a file named LUNOS_CLOUD_HELLO.md at the root of this repository: a short summary (at most 15 lines) of what the repository contains and how to run or test it. Don't change any other file."

/** What quickstart needs from `GET /v1/account`. */
export type Status = {
  email?: string
  /** `free`, `pro`, `team`, `enterprise`. */
  plan?: string
  /** Billing is on at this control plane: without a plan, no cloud runs. Off (development, staging): any account runs. */
  billing: boolean
  /** Hosts with a stored git token. */
  gitHosts: string[]
  /** Whose plan it is: "personal", or an organisation's id. */
  planSource?: string
  member: boolean
}

export function status(body: Record<string, unknown>): Status {
  const list = (value: unknown) => (Array.isArray(value) ? value : [])
  return {
    email: typeof body.email === "string" ? body.email : undefined,
    plan: typeof body.plan === "string" ? body.plan : undefined,
    billing: body.billing !== null && body.billing !== undefined,
    gitHosts: list(body.gitCredentials)
      .filter((h): h is string => typeof h === "string")
      .map((h) => h.toLowerCase()),
    planSource:
      typeof (body.plan_source ?? body.planSource) === "string"
        ? String(body.plan_source ?? body.planSource)
        : undefined,
    member: list(body.organizations).length > 0,
  }
}

export async function account(token: string, opts: CloudAccountApi.Options = {}) {
  const body = (await CloudAccountApi.call(token, "GET", "/v1/account", undefined, "Your account", opts)) ?? {}
  return status(body as Record<string, unknown>)
}

/** No plan where one is needed: the next step's words (the trial, or the organisation's owner). */
export function needsPlan(s: Status) {
  return s.billing && (!s.plan || s.plan === "free")
}

/** Starts the 14-day Pro trial: where to finish it (Stripe Checkout). */
export async function trial(token: string, opts: CloudAccountApi.Options = {}) {
  const body = (await CloudAccountApi.call(
    token,
    "POST",
    "/v1/billing/checkout",
    { plan: "pro" },
    "Starting the trial",
    opts,
  )) as { url?: unknown } | undefined
  if (typeof body?.url !== "string") throw new Error("Lunos Cloud didn't return a checkout page.")
  return body.url
}

/**
 * The host a remote's clone and push go to, as the control plane keys git tokens by it: lower-case,
 * with a port if there is one. Undefined for a local path or file:// remote, which needs no token.
 */
export function remoteHost(url: string) {
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(url)
  if (scp) return scp[1]!.toLowerCase()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return
  const parsed = URL.parse(url)
  if (!parsed || parsed.protocol === "file:") return
  return parsed.host.toLowerCase() || undefined
}

/** A local or loopback remote (tests, a control plane on this machine): no token to store. */
export const localHost = (host: string | undefined) => !host || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)

/** The next step for a missing git token, in the same words as any other refusal on the path. */
export const noGitToken = (host: string) => CloudAccountApi.explain("no_git_token", { host })!

/** Where a forge shows the results branch, for the hosts whose URL scheme is known (as lunoshq src/onboarding.ts). */
export function branchUrl(remote: string, branch: string): string | undefined {
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(remote)
  const parsed = scp ? undefined : URL.parse(remote)
  if (!scp && parsed?.protocol !== "https:") return
  const host = (scp ? scp[1]! : parsed!.host).toLowerCase()
  const repo = (scp ? scp[2]! : parsed!.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")
  if (!repo || !/^[A-Za-z0-9._/-]+$/.test(repo)) return
  const path = branch.split("/").map(encodeURIComponent).join("/")
  if (host === "github.com") return `https://${host}/${repo}/tree/${path}`
  if (host === "gitlab.com") return `https://${host}/${repo}/-/tree/${path}`
  if (host === "codeberg.org") return `https://${host}/${repo}/src/branch/${path}`
}

/** The results branch `lunos run --cloud` reported (its "cloud: finished: results on …" line). */
export function resultsBranch(output: string) {
  return /results on (lunos\/cloud\/[a-z0-9]+)/.exec(output)?.[1]
}
