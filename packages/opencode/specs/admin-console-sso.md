# Admin console and SSO: does Lunos need one, and what shape (XCOD-104 spike)

**Status:** decision document. No product code is built by this spike. **Recommendation: defer.** Build nothing now, with named triggers for when to revisit (§6). The build / don't build / defer call is Petar's and is recorded on XCOD-104.

Checked against `origin/dev` @ `87c827f` on 2026-09-25.

## What exists today

- **`packages/enterprise`** is upstream's share _viewer_, not an admin product. It is a SolidStart app with a share route (`routes/share/[shareID].tsx`), an API catch-all (`routes/api/[...path].ts`) and `core/share.ts` + `core/storage.ts`. Storage is S3 or Cloudflare R2 only, chosen by `OPENCODE_STORAGE_ADAPTER` (`storage.ts:87-90`), with the S3 region defaulting to `us-east-1` (`storage.ts:68`). There are no users, roles, orgs or policy in it.
- **`packages/console`** is upstream's hosted SaaS console. It covers:
  - accounts, workspaces, users with roles (`core/src/user.ts`), keys, quotas, referrals and billing (`core/src/billing.ts`, Stripe webhooks and products in `infra/console.ts`);
  - auth via openauth with GitHub and Google providers, and storage on Cloudflare KV (`function/src/auth.ts:3-9`);
  - deployment by SST to Cloudflare, plus AWS `us-east-1` (`sst.config.ts:9-13`).

  It is built around opencode's own hosted service.

- **The CLI still carries a login to upstream's console.** `lunos console login|logout|switch|orgs|open` is registered in `src/index.ts:109`. It is hidden from help (`describe: false`, `cli/cmd/account.ts:238-240`), and its default URL is `https://opencode.ai/console` (`account.ts:18`). It's not in any documented path, but it is reachable. See §7.
- **Org-wide control without a server is already partly there.**
  - Managed config is read from a system directory, plus macOS MDM profiles, and wins over user and project config (`config/config.ts:551-566`, `config/managed.ts`).
  - The residency audit log records model calls and shares (`packages/core/src/residency.ts`).
  - Both are being extended this sprint: locked keys and Lunos paths (XCOD-102), and a full audit trail with SIEM forwarding (XCOD-103).

## Decisions this rests on

- **XCOD-55:** Lunos operates **no hosted infrastructure** for now. The public claim is limited to "self-hosted software from an EU-incorporated vendor". A Lunos-run service triggers the full EU-provider evaluation that decision names.
- **XCOD-84 (decided 2026-09-25):** sharing is **export-only**. There is no share server, hosted or self-hosted. Option (a), a self-hostable share server, was not built.
- **XCOD-54:** Lunos, free, MIT-licensed and unmonetised, most likely falls **outside the CRA**. Running a paid or hosted service is one of the named triggers that moves it towards _manufacturer_.

## 1. What does an organisation need that managed config and audit export can't give it?

**Evidence first.** The ticket asks for this answer to rest on the pilot organisation and XCOD-29's outreach notes. It can't:

- **XCOD-29 is Done but recorded no notes or outcomes.** The ticket has no comments and no linked document, so there is no logged answer from any contact.
- **XCOD-109, the pilot, was cancelled on 2026-09-25** because no pilot organisation is available.

**No organisation has asked for an admin console or SSO.** Any list of "what they need" below is therefore a reasoned inventory of what a security team _typically_ asks for, not evidence. It's marked as such.

| Typical admin need                                             | Covered without a server?                                | How                                                                                                                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set company-wide settings and stop developers turning them off | **Yes, once XCOD-102 lands**                             | Managed config with `$locked` keys, deployed by MDM, GPO or config management                                                                                                                        |
| Allow only approved marketplaces and extensions                | **Yes, with XCOD-102 + XCOD-105**                        | Locked `marketplace.allow`, plus the curated catalogue's review status                                                                                                                               |
| See what the agent did, after an incident or for an audit      | **Yes, with XCOD-103**                                   | Hash-chained local log, exported or forwarded (syslog or OTLP) to the customer's SIEM                                                                                                                |
| See which machines run which Lunos version and policy          | **Partly.** Not today, but cheap to add without a server | Add a start-up audit event carrying the version and a digest of the effective policy. The SIEM then answers "which machines, which version, which policy". Proposed as an addition to XCOD-103 (§6). |
| Revoke a developer's access                                    | **Not a Lunos concern today**                            | Lunos holds no org credential to revoke. Model access uses the organisation's own provider keys or gateway, so it's revoked there, at the provider, the gateway or the IdP in front of it.           |
| Share sessions within a team                                   | **Yes, by decision**                                     | Export (`/export`, `lunos export --sanitize`) and committed artifacts (XCOD-84)                                                                                                                      |
| Central dashboard of usage and cost                            | **No**                                                   | Would need a collector. The SIEM can chart `model.call` events from XCOD-103, which is a partial answer.                                                                                             |

**Conclusion.** Every need that ranks high on a security review is met by policy files plus the audit stream, with no Lunos-run service. The only real gap is a _dashboard_: inventory, usage and cost in one place. The customer's own SIEM can cover it, and no one has asked for it.

## 2. What does SSO attach to?

SSO protects a login. **Lunos has no login today:**

- The CLI talks to model providers with the organisation's own keys (`lunos providers`, alias `auth`, stores provider credentials, not a Lunos identity).
- There is no share server (XCOD-84), so nothing there needs protecting.
- The hidden `lunos console login` authenticates against **upstream's** console, not anything Lunos runs (§7).

SSO would only mean something for a server Lunos ships. The candidates are:

| Surface                                                                    | Exists?                            | Would need SSO?                                                             |
| -------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| Self-hosted share server                                                   | **No.** Decided against in XCOD-84 | Yes, if built                                                               |
| Admin console (self-hosted)                                                | No                                 | Yes                                                                         |
| `lunos serve` / `lunos web` (local HTTP server on the developer's machine) | Yes                                | **No.** It is local, protected by its own auth and not a multi-user service |
| Model gateway in front of providers                                        | The customer's own, if any         | Already the customer's IdP. Not a Lunos surface.                            |

So **"add SSO" is not a standalone piece of work.** It is a consequence of deciding to ship a multi-user server.

## 3. If something is needed, what is its shape?

Only relevant if a trigger in §6 fires. This is the shape to start from:

- **Self-hostable only.** One container image, run on the customer's infrastructure, never on Lunos's. This keeps XCOD-55's claim intact, and keeps Lunos out of the data path and, very likely, outside the CRA manufacturer regime (XCOD-54).
- **OIDC against the customer's IdP** (Keycloak, Entra ID, Okta and so on). There is no local user database and no Lunos-held identities. Group claims map to two roles: admin and viewer.
- **It distributes policy; it is not a second source of truth.** The console _writes_ the same managed-config document XCOD-102 defines, or renders the `.mobileconfig` and Intune profile for it. Machines still read the managed file from disk. A machine that can't reach the console keeps its last policy, and no CLI code path asks the console for permission.
- **Inventory comes from the audit stream, not from phone-home.** The console reads the customer's log sink (the start-up event in §1). Machines don't need a new outbound connection to it.
- **New package.** Don't grow it out of `packages/enterprise` (a share viewer tied to S3/R2 env vars) or `packages/console` (§4).

## 4. Upstream relationship: reuse or strip

| Package               | What's in it                                                                                                              | Worth keeping for a Lunos admin service                                                                                                                                            | Tied to SaaS or billing                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/console`    | openauth issuer, accounts, workspaces, users and roles, keys, quotas, referrals, Stripe billing, Cloudflare KV, SST infra | **The openauth _pattern_ only** (an OIDC issuer/provider split), and it would be re-pointed at the customer's IdP. The GitHub and Google providers and the KV storage don't apply. | Billing, quotas, referrals, Stripe, Cloudflare/AWS infra, the workspace model built around hosted keys |
| `packages/enterprise` | Share viewer + S3/R2 storage                                                                                              | **Nothing for admin.** It's only relevant if XCOD-84's option (a) is ever revisited.                                                                                               | Its storage adapters assume S3 (default `us-east-1`) or Cloudflare R2                                  |

**Recommendation:** leave both packages untouched as upstream-synced code for now, since stripping them would only create merge noise with upstream. Don't ship or document them as Lunos features. If a build is triggered, start a new package that borrows only the OIDC shape.

## 5. Cost and sovereignty, per option

| Option                                                  | Build cost                                                                                                      | Run cost to customer                                                   | Sovereignty (XCOD-55)                                                                                                         | CRA (XCOD-54)                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **A. Defer: policy files + audit stream (recommended)** | None beyond XCOD-102/103, plus one start-up audit event                                                         | None: files and their existing SIEM                                    | Unchanged, since Lunos runs nothing                                                                                           | Unchanged: outside scope while unmonetised                                    |
| B. Self-hostable admin console + OIDC                   | Large: new service, UI, OIDC integration, policy renderer, security review, docs, release pipeline for an image | One more container to run and patch                                    | Holds, as long as it's self-hosted only                                                                                       | Unchanged if free. Commercial support for it would be a monetisation trigger. |
| C. Lunos-hosted admin console                           | Large, plus operations                                                                                          | None for the customer, but their policy and inventory data go to Lunos | **Breaks the current claim.** Needs the full EU-provider evaluation, and "self-hosted, not in the data path" stops being true | Most likely **manufacturer**: a hosted, paid-for service                      |

## 6. Recommendation: defer

**Build nothing now.** Reasons:

1. **No evidence of need.** Outreach logged no answers (XCOD-29), and the pilot is cancelled (XCOD-109). Building a server for an unasked question is the pattern the memory spike (XCOD-85) warned against.
2. **The high-value needs are met without a server** once XCOD-102 and XCOD-103 ship (§1).
3. **SSO has nothing to attach to** (§2).
4. **Option C contradicts XCOD-55,** and option B is a large build that adds an attack surface for a dashboard the customer's SIEM can mostly provide.

**Cheap follow-ups that make "defer" hold up** (proposed, not created, pending the decision):

- **XCOD-103:** add a `client.start` audit event with the Lunos version, OS and a SHA-256 digest of the effective locked policy. This is the no-server answer to "which machines run which version and policy".
- **CLI:** remove, or re-point and document, the hidden `lunos console` command group that logs into `opencode.ai/console` (§7).

**Revisit when any of these first happens:**

1. An organisation (a revived XCOD-109 pilot or the XCOD-110 dry-run reviewer) asks in writing for a capability that §1 marks as not covered, and the SIEM answer is refused.
2. A share server is reconsidered (XCOD-84 option (a)). That brings SSO with it.
3. A hosted or managed Lunos offering moves from "eventually" to planned work. That is XCOD-55's own trigger, and it reopens this question together with the CRA assessment.

If a trigger fires, the build is option **B**, in the shape given in §3, and implementation stories are created from this document before the spike closes, as the ticket requires.

## 7. Finding: a hidden login to upstream's hosted console

`lunos console login [url]` defaults to `https://opencode.ai/console` (`cli/cmd/account.ts:18`, `:188`). It is hidden from help but registered (`src/index.ts:109`).

This matters because a developer who runs it signs in to a service Lunos doesn't operate and that XCOD-55's claim doesn't cover. And `self-hosted.md` §3 says ITService EOOD is "not in the data path" and doesn't mention this route to _upstream's_ hosted service.

This is out of scope for a spike, so it's recorded here and on XCOD-104 for follow-up: remove the command group, or make it refuse without an explicit URL and name it in the deployment guide's egress list. It also bears on XCOD-102: an org policy may want to lock it off.
