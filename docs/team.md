# Working as a team: your organisation's Lunos console

**XCOD-191, unreleased.** Teams on Lunos Cloud's Team plan, and organisations running the
self-hosted console (Enterprise), get four things that need a server. All of it is kept on that
console, in your data centre or ITService's EU one, and none of it is sent anywhere else.

| What                | You                                                                     | Your admins (console)                     |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| Organisation policy | Lunos fetches it at each start (XCOD-238)                               | _Policy_: edit, version, lock keys        |
| Private marketplace | `lunos marketplace list`, `lunos plugin add`, `lunos mcp add`, Discover | _Marketplace_: publish and remove entries |
| Team memory         | an `org` memory source; `lunos memory share <id>`                       | _Team memory_: approve, reject, remove    |
| Sharing             | `/share` in the TUI, `lunos share`, `lunos share list` / `revoke`       | _Shares_: see, make links, revoke         |

Nothing here works on the free Community edition, or on Lunos Cloud without the Team plan: the
console answers `402 plan_required`, and Lunos says so.

## How Lunos finds the console

The same way as the policy: your administrator's managed config (the system directory or an MDM
profile) names it, and you sign in with `lunos login`:

```json
{
  "cloud": {
    "issuer": "https://id.example.eu/realms/acme",
    "policy": "https://console.example.eu/v1/orgs/acme/policy"
  },
  "$locked": ["cloud"]
}
```

On Lunos Cloud the console is `https://cloud.lunos.tech/v1/orgs/<org>/policy`. `cloud.policy` is
read from managed config only: in user or project config it is ignored, so a repository can't send
your sign-in to its own server. Every request carries your `lunos login` access token to that one
host only, and doesn't follow redirects.

### Hosted Lunos Team without MDM

If your organisation is on hosted Lunos Team, no managed config is needed. Run `lunos login`
(Lunos's own sign-in, `auth.lunos.tech`). Lunos asks `cloud.lunos.tech` which hosted organisations
you belong to and turns team features on for yours: `Team features: on for acme`. The policy,
private marketplace, team memory and sharing then work as if managed config set
`cloud.policy` to `https://cloud.lunos.tech/v1/orgs/acme/policy`. `/settings` → Status shows
**Team features: acme on cloud.lunos.tech, from hosted (Lunos sign-in)**.

- **Only Lunos's console.** The host is built into Lunos. Nothing in your sign-in, your account or
  your organisation's policy can point it anywhere else. A sign-in to any other identity provider
  never turns this on.
- **Several organisations.** If your sign-in's organisation claim names one of them, that one is
  used. Otherwise, with more than one, nothing is turned on, and your administrator sets
  `cloud.policy` in managed config.
- **Your sign-in stays yours.** A hosted organisation's policy can't set or lock anything under
  `cloud` (the sign-in issuer, the Lunos Cloud endpoint, the policy address): your Lunos sign-in
  is valid for your whole Lunos account, so an organisation admin can't point it at another host.
  Organisations that need those keys set them in managed config.
- **Managed config wins.** If managed config sets `cloud.policy`, that console is used and nothing
  is looked up. An organisation turns this off with `"cloud": { "auto_team": false }` in managed
  config.
- **When it's checked.** Only at `lunos login`. If you join an organisation later, run
  `lunos login` again. `lunos logout` turns it off, including the organisation's policy: unlike
  `cloud.policy` in managed config, a policy you only get through your sign-in doesn't outlive it.
  An organisation that needs its policy enforced on every machine, signed in or not, uses MDM.
  Each start also tells the console the Lunos version, OS, architecture, surface, a random install
  id and the policy digest; locking all of `cloud`, as above, keeps that on for everyone (see
  [what Lunos sends to the console](deployment/self-hosted.md#what-lunos-sends-to-the-console-at-start-clientstart)).

## Private marketplace

Owners and admins publish plugins, skills, hooks and MCP servers on the console's _Marketplace_ page
(the same entry shapes as a public `marketplace.json`; names of environment variables and headers
only, never values). Members signed in see it as the first marketplace, named after the
organisation:

```sh
lunos marketplace list          # [org] acme (https://console.example.eu/v1/orgs/acme/marketplace.json)
lunos mcp add acme/acme-kb      # the usual install commands; Discover lists it too
lunos plugin add acme/acme-lint
```

- An entry an admin marked _reviewed_ is "verified by acme" and installs without
  `--allow-unreviewed`, pinned to the version reviewed. Others need `--allow-unreviewed`, which a
  locked `marketplace_unreviewed: false` forbids.
- A locked `marketplace_allow` list applies to it like any marketplace: add its URL
  (`…/v1/orgs/<org>/marketplace.json`) to the list.
- It is re-fetched after 5 minutes. Offline or signed out, the last copy is listed.

## Team memory

Your own memory stays on your machine. Team memory is what members chose to share and an admin
approved:

```sh
lunos memory list                         # find the fact's id
lunos memory share <id> [<id>…]           # preview: nothing is uploaded
lunos memory share <id> [<id>…] --yes     # upload these facts, for an admin to approve
```

Only the facts named are sent, in the memory bundle's fact format (`lunos-memory/1`, with their
provenance), after the same secret screen memory writes use. Outdated facts and facts that failed
the ledger's integrity check aren't shared. Each one waits on the console's _Team memory_ page until
an owner or admin approves it.

To recall team memory, add it as a memory source:

```json
{ "memory": { "sources": [{ "name": "team", "type": "org", "jurisdiction": "EU" }] } }
```

It behaves like every [memory source](../packages/opencode/specs/memory-layer.md): checked against
the residency policy before it is first contacted (the turn's question is sent to the console),
results screened, capped and labelled `type="org"`, never stored locally. Managed config can mark it
`trusted`.

## Sharing a session or an artifact

In the TUI, `/share` (with `"share": "cloud"`) asks how, then uploads the session you're in:

- **Share with your organisation:** the whole session, as `lunos export` writes it.
- **Share redacted:** transcript and file data redacted first, as `lunos export --sanitize`.
- **…with a link:** also a link that works without signing in, for 30 days (or your
  organisation's shorter maximum).

It shows the share's URL (and copies it), the link and when it expires. From a terminal:

```sh
lunos share <session-id>                         # the session, as lunos export writes it
lunos share <session-id> --sanitize              # redacted first, as lunos export --sanitize
lunos share --artifact .opencode/plans/<file>.md # a plan, research note, any text file up to 1 MB
lunos share --artifact notes.md --link           # plus a link that works without signing in, for 30 days
lunos share --artifact notes.md --link 48        # … for 48 hours
lunos share list                                 # your shares: id, kind, title, created, link expiry, URL
lunos share list --all                           # every share in the organisation
lunos share revoke <id>                          # revoke one of yours, and its links
```

`/share` and `lunos share` are the same code with the same rules: the `share` setting, the
residency check, the audit record, sanitize and the link. `list` and `revoke` can't be session ids
(those start with `ses_`), so `lunos share <session-id>` is unchanged. They upload nothing, so they
work with sharing off: you can always take back what you shared.

Members see shares on the console's _Shares_ page, shown as text: nothing in them is run or
rendered as HTML. A link is signed (HMAC over its id, the share and its expiry) and checked against
the console's records, so it stops working when it expires (30 days unless asked for less, and never
past the organisation's maximum, which owners and admins set on _Shares_), when its link or share is
revoked, or when the organisation loses the plan. The expiry Lunos shows is the one the console
returned. Whoever shared it, and the organisation's owners and admins, can revoke it; revoking a
share deletes its content.

**Off by default.** `share` defaults to `"disabled"`. `"cloud"` allows `/share`, `lunos share` and
`lunos memory share` to your organisation's console and nothing else: upstream's share service
stays off. Your organisation can lock it either way:

```json
{ "$locked": ["share"], "share": "cloud" }
```

**Residency.** Before every upload (`/share`, `lunos share`, `lunos memory share`), Lunos asks the
console which region it declares (`GET <console>/v1`, which answers `{ "api", "region", "name" }`)
and checks it against `residency.allow`, as `share:lunos-console`. A region the policy doesn't
allow is refused before anything is sent, and recorded in the audit log as `share.denied`; an
allowed upload is `share.upload`. Lunos Cloud declares `eu`. A self-hosted console declares what
its operator set (`LUNOS_CONSOLE_REGION`), and `other` if nobody did. Under a residency policy:

- If the console can't be asked, the upload is refused (audit-only mode goes on).
- A console that declares no region at all (an older one) is assessed as before: `eu` on
  `cloud.lunos.tech`, otherwise your own endpoint, which you declare:
  `{ "residency": { "endpoints": { "share:lunos-console": { "region": "eu" } } } }`.
- If the console declares `eu` or `us` and your `residency.endpoints` declares something else,
  the upload is refused: fix whichever is wrong. If it answers `other` (no region set), your
  declaration stands.

`lunos memory share <id>` without `--yes` prints exactly the request body `--yes` would send (each
fact's full text, provenance and dataset id), and uploads nothing.

## Setting it up on every machine with MDM

Your IT administrator turns the team features on once, with the device management they already use;
developers then only run `lunos login`.

1. **Point Lunos at the console.** Deploy one `managed.json` (root- or administrator-owned,
   readable by everyone):

   ```json
   {
     "cloud": {
       "issuer": "https://id.example.eu/realms/acme",
       "policy": "https://console.example.eu/v1/orgs/acme/policy"
     },
     "$locked": ["cloud"]
   }
   ```

   | OS      | Where                                                                                   | Typical tool                                                           |
   | ------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
   | macOS   | `/Library/Application Support/Lunos/managed.json`, or a profile in `tech.lunos.managed` | Jamf Pro, Intune, Kandji (a configuration profile or a package)        |
   | Windows | `%ProgramData%\Lunos\managed.json`                                                      | Intune (a PowerShell platform script), Group Policy (Files preference) |
   | Linux   | `/etc/lunos/managed.json`                                                               | Ansible, Puppet, Chef, Salt                                            |

   A sample macOS profile and Windows and Linux notes are in
   [`examples/managed-policy/`](../examples/managed-policy/).

2. **Turn the features on in the organisation policy.** On the console's _Policy_ page (fetched by
   every signed-in Lunos at start, so a change needs no new MDM push), or in the same `managed.json`:

   ```json
   {
     "$locked": ["share", "residency"],
     "share": "cloud",
     "residency": { "allow": ["eu"], "audit": true },
     "memory": { "sources": [{ "name": "team", "type": "org", "jurisdiction": "EU" }] }
   }
   ```

3. **Check one machine:** `lunos login`, then `lunos debug config --sources` (shows `cloud`,
   `share` and `residency` coming from managed config or the console), `lunos marketplace list`
   (the organisation's marketplace first) and `lunos share list`.

To turn sharing off again, set `share` back to `"disabled"` in the policy: clients pick it up at
their next start.
