# Owner action checklist — things only you can do

**Generated:** 2026-09-19 · **Board:** [XCOD sprint 169](https://axsion.atlassian.net/jira/software/projects/XCOD/boards/169)

Everything here needs your accounts, your judgement, or your money. Ordered so that the items
unblocking the most work come first. Agent-side work is done and pushed to `dev` unless stated.

---

## 🔴 1. NOW — the npm token (unblocks 3 tickets, ~10 minutes)

This is the single highest-leverage thing on the list. **XCOD-48**, **XCOD-49 AC-2** and
**XCOD-46** are all waiting on it, and nothing else you do will move them.

### Step 1.1 — create the token

1. Log in to <https://www.npmjs.com> → avatar → **Access Tokens** → **Generate New Token**
2. Choose **Granular Access Token** (or classic **Automation** token)
3. Permissions: **Read and write**
4. Scope: **all packages** for now.
   `lunos-ai` does not exist yet (npm returns 404), so you cannot scope to it. The first
   successful publish claims the name. **Narrow the token afterwards.**
5. Expiry: your call — note a 30-day token will silently break the release pipeline later

### Step 1.2 — add it to the repo

```bash
gh secret set NPM_TOKEN --repo AxsionDev/Lunos
# paste the token at the prompt
```

Verify:

```bash
gh secret list --repo AxsionDev/Lunos     # expect NPM_TOKEN + the 5 APPLE_* entries
```

> ⚠️ **Always pass `--repo`.** With an `upstream` remote configured, bare `gh` has resolved to
> `anomalyco/opencode` — upstream's repo — more than once.

### Step 1.3 — dispatch a release

```bash
gh workflow run publish.yml --repo AxsionDev/Lunos -f bump=patch
gh run list --repo AxsionDev/Lunos --workflow=publish.yml --limit 3
```

**What should happen:** guards pass → `preflight` reports signing skipped → `build-cli` ✅ →
`sign-cli-windows` **skipped** → Electron builds unsigned → Homebrew/AUR skipped → ghcr push →
`lunos-ai` published.

**This path has never run end to end.** Most likely surprise: the ghcr push to
`ghcr.io/axsiondev/lunos` — the org may need package-write permission granted to Actions on first
use. If it fails there, everything before it still succeeded.

### Step 1.4 — verify

```bash
npm view lunos-ai version
```

Then tell me and I'll triage whatever the run turned up, and close out XCOD-46 (README install
commands, which have been waiting for a real published package).

---

## 🟠 2. THIS WEEK — review the queue (7 tickets)

Seven tickets are in **in Review** waiting on you. Two are worth actually reading; the rest are
mechanical.

**Read these two properly:**

| Ticket      | Why it needs your eyes                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| **XCOD-51** | Adds `Copyright (c) 2026 ITService EOOD` to `LICENSE`. A legal instrument — confirm the entity string and year.          |
| **XCOD-52** | Adopts the DCO. Changes what you ask of every future contributor. Check the `CONTRIBUTING.md` wording reads as you want. |

**Skim these five:** XCOD-44 (rebrand), XCOD-47, XCOD-50, XCOD-55 (sovereignty claim), XCOD-56.

Move each to **Done** once merged and you're happy — per your convention, in Review means pushed,
Done means merged and accepted.

### ❓ One thing I need you to confirm

**XCOD-44 — I did not follow your instruction on `zen.mdx`.** You said remove both upstream-service
docs pages. I removed `enterprise.mdx` but **kept `zen.mdx`**, because opening it before deleting
showed OpenCode Zen is a third-party provider Lunos _actively supports_ — the TUI ships a
`/connect` flow pointing at `opencode.ai/zen`. Deleting it would have removed docs for a working
feature.

I gave you a wrong premise when I asked. **Say the word and I'll remove it** — it's a two-minute
change — but I wanted the decision made on correct facts.

---

## 🟡 3. DECISIONS WITH TRIGGERS — not now, but don't lose them

These are deliberately deferred. Each has a named trigger; the risk is forgetting the trigger.

### 3.1 Trademark clearance (XCOD-53) — **before the first paid pilot**

You deferred this knowingly. The finding that makes it real: **the senior user of the identical
mark is active in Class 9** — `LUNOS Lüftungstechnik` (Berlin, 1959) holds US serial **79386509**,
a 2023 Madrid extension covering electrical apparatus. Class 9 is where software files.

**When the trigger fires, ~1 hour, free:**

1. **WIPO Madrid Monitor** — look up the international registration behind US **79386509**. This is
   the highest-value single lookup: it tells you what the senior user actually holds _in Europe_.
2. **EUIPO eSearch plus** — `LUNOS`, filtered to Nice **Class 9** and **Class 42**; then by owner name
3. **TMview** — same query (catches German national marks EUIPO alone misses)
4. **USPTO Trademark Search** — `LUNOS` and `LUNO`, live marks, Classes 9/42

Screenshot everything — register printouts are what a procurement due-diligence file wants.
Then engage a Bulgarian/EU trade mark attorney _with those results in hand_; it makes the
engagement much cheaper.

> I could not do any of this: all seven registers and aggregators block automated access. It needs
> a human with a browser. Don't ask me to retry — the attempts are documented so nobody repeats them.

**Also treat as early warning:** the launch post shipping, the repo going public, or any
procurement response naming Lunos. All raise visibility before the formal trigger.

### 3.2 CRA assessment (XCOD-54) — when its own gates open

Blocked by the ticket's own text. Both gates are still shut: the CRA/SBOM milestone is **Phase 1**
work, and no monetisation decision exists. XCOD-55 narrowed it — _open-source steward_ is the
working assumption today, with a foreseeable move to _manufacturer_ if a hosted offering appears.

### 3.3 `deploy.yml` region (XCOD-58) — before that workflow is un-deferred

`deploy.yml:34` targets AWS `us-east-1` — a US region, in a public workflow file, on a project whose
README leads with EU sovereignty. Not live (the workflow is deferred), but region gets baked into
SST state once a stack deploys, so moving later means recreating resources.

> 📌 **XCOD-58 is not on the sprint board** — it's in the backlog. Add it to a sprint if you want it
> tracked.

---

## 🟢 4. OPTIONAL — only if you want these capabilities

None of these block anything. Listed so they're not mistaken for gaps.

| Item                            | Cost / effort                                 | Needed for                                  |
| ------------------------------- | --------------------------------------------- | ------------------------------------------- |
| **Apple certs** (exist, broken) | re-export the `.p12`, free                    | signed macOS builds — no Gatekeeper warning |
| **Azure Trusted Signing**       | ~$120/yr **+ org identity check, takes days** | signed Windows builds — no SmartScreen      |
| **Tauri signing keys**          | free, generated locally                       | desktop auto-updater manifests              |
| **Lunos Homebrew tap**          | create `AxsionDev/homebrew-tap`               | `brew install lunos`                        |
| **AUR package**                 | register `lunos-bin` + SSH key                | Arch users                                  |

On Apple specifically: the 5 secrets exist but `import-codesign-certs` fails at `security` exit 1 —
that's a **malformed cert or wrong password**, not an absent one. Most likely a stray newline in the
base64, or the wrong cert type (needs **Developer ID Application**, not Apple Development).
Re-export and `base64 -i cert.p12 | pbcopy`.

On Azure: **start early if you ever want Windows signing.** The organisation identity validation can
take days — it is not a same-day purchase.

> ⚠️ **Do NOT provision the other secrets the workflows mention** — `CLOUDFLARE_API_TOKEN`,
> `PLANETSCALE_*`, `STRIPE_*`, `HONEYCOMB_API_KEY`, `POSTHOG_KEY`, `VSCE_PAT`, `OPENVSX_TOKEN`,
> `AWS_DEPLOY_ROLE_ARN`. They belong to workflows XCOD-19 deferred, and several imply
> infrastructure Lunos does not operate.

---

## 5. Things worth knowing, no action required

- **XCOD-20 (Phase 0 exit criterion) is already Done**, as is XCOD-31. Both XCOD-48 and XCOD-49
  still describe themselves as "blocking XCOD-20" — that framing is stale. Worth a glance to
  confirm XCOD-20 was genuinely satisfied, since it closed before any package was ever published.
- **The `workflow` OAuth scope no longer blocks pushes.** It did before; confirmed working today.
- **`version.ts` runs `bun i -g opencode-ai`** (`publish.yml:52`) — our release path installs
  _upstream's_ package as a build tool. Works, but it's an upstream dependency inside our release.
- **Test baseline is 715 pass / 9 fail.** All 9 are pre-existing in
  `packages/app/.../submit.test.ts`. Use `bun turbo test` — `bun test | tail` masks the exit code.
- **XCOD-14** (host the registry service) is a multi-day infrastructure build needing hosting
  accounts. Nothing to do until you decide where it runs — which interacts with XCOD-55's
  EU-provider question.

---

## The short version

1. **Create an npm token, `gh secret set NPM_TOKEN`, dispatch `publish.yml`.** ← do this
2. Review 7 tickets; confirm the `zen.mdx` call.
3. Diarise: trademark searches before any paid pilot.
4. Everything else is optional or waiting on a trigger.
