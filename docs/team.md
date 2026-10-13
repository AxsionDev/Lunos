# Working as a team: your organisation's Lunos console

**XCOD-191, unreleased.** Teams on Lunos Cloud's Team plan, and organisations running the
self-hosted console (Enterprise), get four things that need a server. All of it is kept on that
console, in your data centre or ITService's EU one, and none of it is sent anywhere else.

| What                | You                                                                     | Your admins (console)                     |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| Organisation policy | Lunos fetches it at each start (XCOD-238)                               | _Policy_: edit, version, lock keys        |
| Private marketplace | `lunos marketplace list`, `lunos plugin add`, `lunos mcp add`, Discover | _Marketplace_: publish and remove entries |
| Team memory         | an `org` memory source; `lunos memory share <id>`                       | _Team memory_: approve, reject, remove    |
| Sharing             | `lunos share <session>` or `--artifact <file>`, with an optional link   | _Shares_: see, make links, revoke         |

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
your sign-in to its own server. Signing in alone doesn't point Lunos at a console. Every request
carries your `lunos login` access token to that one host only, and doesn't follow redirects.
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

```sh
lunos share <session-id>                         # the session, as lunos export writes it
lunos share <session-id> --sanitize              # redacted first, as lunos export --sanitize
lunos share --artifact .opencode/plans/<file>.md # a plan, research note, any text file up to 1 MB
lunos share --artifact notes.md --link 48        # plus a link that works without signing in, for 48 hours
```

Members see shares on the console's _Shares_ page, shown as text: nothing in them is run or
rendered as HTML. A link is signed (HMAC over its id, the share and its expiry) and checked against
the console's records, so it stops working when it expires (at most 30 days), when its link or share
is revoked, or when the organisation loses the plan. Whoever shared it, and the organisation's owners
and admins, can revoke it; revoking a share deletes its content.

**Off by default.** `share` defaults to `"disabled"`. `"cloud"` allows `lunos share` and
`lunos memory share` to your organisation's console and nothing else: `/share` in the TUI and
upstream's share service stay off. Your organisation can lock it either way:

```json
{ "$locked": ["share"], "share": "cloud" }
```

**Residency.** Each upload is checked as `share:lunos-console` at the console's host before
anything is sent, and recorded in the audit log as `share.upload` or `share.denied`. Lunos Cloud's
console (`cloud.lunos.tech`) counts as EU. A self-hosted console is your own endpoint: under a
residency policy, declare it:

```json
{ "residency": { "allow": ["eu"], "endpoints": { "share:lunos-console": { "region": "eu" } } } }
```
