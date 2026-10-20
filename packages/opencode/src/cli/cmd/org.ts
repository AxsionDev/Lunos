import { EOL } from "os"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { CloudAccountApi } from "@/cloud/account-api"
import { CloudAuth } from "@/cloud/auth"
import { CloudOrgMembers } from "@/cloud/org-members"
import { CloudStore } from "@/cloud/store"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// XCOD-274: `lunos org`: your organisations on Lunos Cloud, their members, owners and invitations,
// and the invitations waiting for you. Lunos Cloud decides every permission, on every call: an Owner-
// only action a Member tries is refused there ("Only an organisation owner can do this. Ask: …"),
// and this command shows that answer as it is. It never hides or allows anything by itself.

const out = (line = "") => process.stdout.write(line + EOL)
const dim = (text: string) => UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const ROLES = ["owner", "admin", "member"] as const
const title = (role: string | undefined) => (role ? role[0]!.toUpperCase() + role.slice(1) : "—")
const day = (ms: number | undefined) => (ms === undefined ? "" : new Date(ms).toISOString().slice(0, 10))

type Common = { org?: string; json: boolean; yes: boolean }

const common = <T>(yargs: Argv<T>) =>
  yargs
    .option("org", { type: "string", describe: "the organisation's id (default: your only organisation)" })
    .option("json", { type: "boolean", default: false, describe: "print JSON" })
    .option("yes", { type: "boolean", default: false, describe: "don't ask for confirmation (for scripts)" })

/** A failure to show: Lunos Cloud's refusal (its status, code and words) or a local one. */
class Failure extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

/** The signed-in session's token, for Lunos Cloud only. */
async function token(what: string) {
  const stored = await CloudStore.load()
  if (!stored) throw new Failure("Not signed in. Run lunos login.")
  const refused = await CloudAccountApi.allowed(stored.issuer)
  if (refused) throw new Failure(`Lunos Cloud can't be asked: ${refused}.`)
  const session = await CloudAuth.session(what)
  return { token: session.tokens.access_token, sub: session.sub, email: session.email }
}

/** `--org`, or the only organisation the account is in. */
async function orgOf(args: Common, token: string) {
  if (args.org) return args.org
  const orgs = (await CloudAccountApi.account(token)).organizations
  if (orgs.length === 1) return orgs[0]!.org
  if (!orgs.length)
    throw new Failure("You aren't in an organisation on Lunos Cloud. See your invitations with lunos org invitations.")
  throw new Failure(
    `You're in ${orgs.length} organisations (${orgs.map((o) => o.org).join(", ")}). Choose one with --org.`,
  )
}

/** Asks before a change that's hard to undo; `--yes` answers for scripts, and without a terminal it's required. */
async function confirm(args: Common, question: string) {
  if (args.yes) return
  if (!process.stdin.isTTY) throw new Failure(`${question} Pass --yes to confirm without a terminal.`)
  const { createInterface } = await import("readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `).finally(() => rl.close())
  if (!/^y(es)?$/i.test(answer.trim())) throw new Failure("Cancelled. Nothing changed.")
}

/** A member by sub, by e-mail address (looked up among the members), or `me`. */
async function memberOf(who: { token: string; sub: string; email?: string }, org: string, target: string) {
  if (target === "me" || target === who.sub || (who.email && target.toLowerCase() === who.email.toLowerCase()))
    return { sub: who.sub, label: who.email ?? who.sub, me: true }
  if (!target.includes("@")) return { sub: target, label: target, me: false }
  const found = (await CloudOrgMembers.members(who.token, org)).members.find(
    (item) => item.email?.toLowerCase() === target.toLowerCase(),
  )
  if (!found) throw new Failure(`${target} isn't a member of ${org}.`, 404, "not_found")
  return { sub: found.sub, label: target, me: false }
}

/**
 * Runs a subcommand: its result as JSON with `--json`, else its lines. A refusal is printed as Lunos
 * Cloud said it (as `{ "error": { status, code, message } }` with `--json`), and the exit code is 1.
 */
const run = <A extends Common>(name: string, body: (args: A) => Promise<{ json: unknown; lines: string[] }>) =>
  Effect.fn(`Cli.org.${name}`)(function* (args: A) {
    const result = yield* Effect.tryPromise({ try: () => body(args), catch: (error) => error })
      .pipe(Effect.map((value) => ({ value, error: undefined })))
      .pipe(Effect.catch((error) => Effect.succeed({ value: undefined, error })))
    if (result.value) {
      if (args.json) out(JSON.stringify(result.value.json, null, 2))
      else for (const line of result.value.lines) out(line)
      return
    }
    const error = result.error
    const status = error instanceof CloudAccountApi.RefusedError || error instanceof Failure ? error.status : undefined
    const code = error instanceof CloudAccountApi.RefusedError || error instanceof Failure ? error.code : undefined
    const text = error instanceof CloudAuth.SignedOutError ? "Not signed in. Run lunos login." : message(error)
    if (!args.json) return yield* fail(text)
    out(JSON.stringify({ error: { ...(status ? { status } : {}), ...(code ? { code } : {}), message: text } }, null, 2))
    return yield* fail("")
  })

export const OrgListCommand = effectCmd({
  command: "list",
  describe: "your organisations and your role in each",
  instance: false,
  builder: (yargs) => common(yargs),
  handler: run("list", async () => {
    const who = await token("Your organisations")
    const account = await CloudAccountApi.account(who.token)
    return {
      json: { organizations: account.organizations },
      lines: account.organizations.length
        ? account.organizations.map(
            (item) =>
              `${title(item.role)} · ${item.name} ${dim(`(${item.org})`)}${item.suspended ? " (suspended)" : ""}`,
          )
        : ["You aren't in an organisation. See your invitations with lunos org invitations."],
    }
  }),
})

export const OrgMembersCommand = effectCmd({
  command: "members",
  describe: "list the organisation's members and pending invitations (owners and admins)",
  instance: false,
  builder: (yargs) => common(yargs),
  handler: run("members", async (args) => {
    const who = await token("The organisation's members")
    const org = await orgOf(args, who.token)
    const result = await CloudOrgMembers.members(who.token, org)
    return {
      json: { org, ...result },
      lines: [
        ...result.members.map((item) => `${title(item.role).padEnd(7)} ${item.email ?? item.sub} ${dim(item.sub)}`),
        ...(result.invitations.length
          ? [
              "",
              "Invitations:",
              ...result.invitations.map(
                (item) =>
                  `${title(item.role).padEnd(7)} ${item.email} ${dim(item.expired ? "expired" : `until ${day(item.expiresAt)}`)}`,
              ),
            ]
          : []),
      ],
    }
  }),
})

export const OrgOwnersCommand = effectCmd({
  command: "owners [action] [member]",
  describe: "list the owners (whom to ask), or add or remove an owner (owners only)",
  instance: false,
  builder: (yargs) =>
    common(yargs)
      .positional("action", { type: "string", choices: ["add", "remove"], describe: "make an owner, or take it away" })
      .positional("member", { type: "string", describe: "the member's e-mail address or id" }),
  handler: run("owners", async (args: Common & { action?: string; member?: string }) => {
    const who = await token("The organisation's owners")
    const org = await orgOf(args, who.token)
    if (!args.action) {
      const owners = await CloudOrgMembers.owners(who.token, org)
      return { json: { org, owners }, lines: owners.map((item) => item.email ?? item.sub) }
    }
    if (!args.member) throw new Failure(`Name the member: lunos org owners ${args.action} <e-mail address>.`)
    const target = await memberOf(who, org, args.member)
    if (args.action === "remove") await confirm(args, `Take ownership of ${org} away from ${target.label}?`)
    const role = args.action === "add" ? "owner" : "member"
    await CloudOrgMembers.setRole(who.token, org, target.sub, role)
    return {
      json: { org, sub: target.sub, role },
      lines: [
        args.action === "add"
          ? `${target.label} is now an owner of ${org}.`
          : `${target.label} is now a member of ${org}.`,
      ],
    }
  }),
})

export const OrgInviteCommand = effectCmd({
  command: "invite <email>",
  describe: "invite someone by e-mail (owners and admins; the invitation lasts 7 days)",
  instance: false,
  builder: (yargs) =>
    common(yargs)
      .positional("email", { type: "string", demandOption: true, describe: "their e-mail address" })
      .option("role", { type: "string", choices: ROLES, default: "member", describe: "the role they join with" }),
  handler: run("invite", async (args: Common & { email: string; role: string }) => {
    const who = await token("Inviting someone")
    const org = await orgOf(args, who.token)
    const invited = await CloudOrgMembers.invite(who.token, org, args.email, args.role as CloudAccountApi.Role)
    return {
      json: { org, ...invited },
      lines: [
        `Invited ${invited.email} to ${org} as ${invited.role}${invited.expiresAt ? `, until ${day(invited.expiresAt)}` : ""}.`,
      ],
    }
  }),
})

export const OrgRemoveCommand = effectCmd({
  command: "remove <member>",
  describe: "remove someone from the organisation (owners and admins), or yourself with `me`",
  instance: false,
  builder: (yargs) =>
    common(yargs).positional("member", { type: "string", demandOption: true, describe: "e-mail address, id, or me" }),
  handler: run("remove", async (args: Common & { member: string }) => {
    const who = await token("Removing a member")
    const org = await orgOf(args, who.token)
    const target = await memberOf(who, org, args.member)
    await confirm(args, target.me ? `Leave ${org}?` : `Remove ${target.label} from ${org}?`)
    await CloudOrgMembers.remove(who.token, org, target.sub)
    return {
      json: { org, removed: target.sub },
      lines: [target.me ? `You left ${org}.` : `Removed ${target.label} from ${org}.`],
    }
  }),
})

export const OrgLeaveCommand = effectCmd({
  command: "leave",
  describe: "leave the organisation (its last owner transfers ownership first)",
  instance: false,
  builder: (yargs) => common(yargs),
  handler: run("leave", async (args) => {
    const who = await token("Leaving an organisation")
    const org = await orgOf(args, who.token)
    await confirm(args, `Leave ${org}?`)
    await CloudOrgMembers.remove(who.token, org, who.sub)
    return { json: { org, removed: who.sub }, lines: [`You left ${org}.`] }
  }),
})

export const OrgTransferCommand = effectCmd({
  command: "transfer <member>",
  describe: "hand ownership to another member (owners only)",
  instance: false,
  builder: (yargs) =>
    common(yargs)
      .positional("member", { type: "string", demandOption: true, describe: "their e-mail address or id" })
      .option("demote-to", {
        type: "string",
        choices: ROLES,
        default: "member",
        describe: "your role afterwards (owner keeps you an owner too)",
      }),
  handler: run("transfer", async (args: Common & { member: string; "demote-to": string }) => {
    const demoteTo = args["demote-to"]
    const who = await token("Transferring ownership")
    const org = await orgOf(args, who.token)
    await confirm(
      args,
      `Make ${args.member} an owner of ${org}, and you ${demoteTo === "owner" ? "an owner too" : `a ${demoteTo}`}?`,
    )
    const result = await CloudOrgMembers.transfer(who.token, org, args.member, demoteTo as CloudAccountApi.Role)
    return {
      json: { org, ...result },
      lines: [
        `${args.member} is now an owner of ${org}. You're ${result.you === "owner" ? "an owner" : `a ${result.you}`}.`,
      ],
    }
  }),
})

export const OrgInvitationsCommand = effectCmd({
  command: "invitations",
  describe: "invitations waiting for you; with --org, the organisation's pending invitations",
  instance: false,
  builder: (yargs) => common(yargs),
  handler: run("invitations", async (args) => {
    const who = await token("Invitations")
    if (args.org) {
      const { invitations } = await CloudOrgMembers.members(who.token, args.org)
      return {
        json: { org: args.org, invitations },
        lines: invitations.length
          ? invitations.map(
              (item) =>
                `${title(item.role).padEnd(7)} ${item.email} ${dim(item.expired ? "expired" : `until ${day(item.expiresAt)}`)}`,
            )
          : [`No pending invitations to ${args.org}.`],
      }
    }
    const invitations = await CloudAccountApi.invitations(who.token)
    return {
      json: { invitations },
      lines: invitations.length
        ? [
            ...invitations.map(
              (item) =>
                `${item.name} ${dim(`(${item.org})`)} as ${item.role ?? "member"} ${dim(`until ${day(item.expiresAt)}`)}`,
            ),
            dim("Accept with lunos org accept <org>, or decline with lunos org decline <org>."),
          ]
        : ["No invitations are waiting for you."],
    }
  }),
})

export const OrgRevokeCommand = effectCmd({
  command: "revoke <email>",
  describe: "revoke a pending invitation (owners and admins)",
  instance: false,
  builder: (yargs) =>
    common(yargs).positional("email", { type: "string", demandOption: true, describe: "the invited address" }),
  handler: run("revoke", async (args: Common & { email: string }) => {
    const who = await token("Revoking an invitation")
    const org = await orgOf(args, who.token)
    await confirm(args, `Revoke the invitation to ${args.email}?`)
    await CloudOrgMembers.revoke(who.token, org, args.email)
    return { json: { org, revoked: args.email }, lines: [`Revoked the invitation to ${args.email}.`] }
  }),
})

const answer = (accept: boolean) =>
  effectCmd({
    command: `${accept ? "accept" : "decline"} <org>`,
    describe: accept ? "accept an invitation to an organisation" : "decline an invitation to an organisation",
    instance: false,
    builder: (yargs) =>
      common(yargs).positional("org", { type: "string", demandOption: true, describe: "the organisation's id" }),
    handler: run(accept ? "accept" : "decline", async (args: Common & { org: string }) => {
      const who = await token(accept ? "Accepting an invitation" : "Declining an invitation")
      const joined = await CloudAccountApi.answerInvitation(who.token, args.org, accept)
      return {
        json: { org: args.org, joined },
        lines: [
          !accept
            ? `Declined the invitation to ${args.org}.`
            : joined
              ? `You joined ${args.org}.`
              : `You're already a member of ${args.org}.`,
        ],
      }
    }),
  })

export const OrgCommand = cmd({
  command: "org",
  describe: "your organisations on Lunos Cloud: members, owners and invitations",
  builder: (yargs) =>
    yargs
      .command(OrgListCommand)
      .command(OrgMembersCommand)
      .command(OrgOwnersCommand)
      .command(OrgInviteCommand)
      .command(OrgRemoveCommand)
      .command(OrgLeaveCommand)
      .command(OrgTransferCommand)
      .command(OrgInvitationsCommand)
      .command(OrgRevokeCommand)
      .command(answer(true))
      .command(answer(false))
      .demandCommand(),
  async handler() {},
})
