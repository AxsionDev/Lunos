# Cloud workers: `lunos run --cloud`

`lunos run --cloud` sends a run to a Lunos Cloud worker instead of running it on your machine. The worker clones your repository at your current commit, runs the agent, and pushes the results to a branch, `lunos/cloud/<id>`. It never pushes to your default branch. You can close your laptop in the meantime.

> **Status:** the client side is in Lunos. Lunos Cloud's control plane isn't live yet, so `cloud.endpoint` has no default. Until it's live, `--cloud` says so and stops.

## Using it

```sh
lunos login                                   # once; see cloud-login.md
lunos settings set cloud.endpoint https://cloud.lunos.tech
lunos cloud git-token set github.com          # once per git host; paste the token (hidden)
git push                                      # the worker starts from what's on your remote
lunos run --cloud "Add input validation to parse.ts"
git fetch origin lunos/cloud/<id>             # the results, when it's done
```

| Option                | What it does                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `--cloud`             | Run on a worker. Output streams here, and approvals come to you here, as in a local run.        |
| `--cloud-size large`  | A larger worker. It counts double toward your agent-hours.                                      |
| `--cloud-secret NAME` | Send environment variable `NAME` to the worker for this run. Repeat it, or list several: `A,B`. |

`--model provider/model` must be a model the worker can run. If its provider isn't set up there (usually because its key wasn't sent with `--cloud-secret`), the run stops before it starts, rather than using another model.

A run whose session ends in an error (for example, refused by the residency policy on the worker) exits non-zero and reports `failed`.

If Lunos Cloud stops the run part-way, for example because the spending cap was reached or the subscription was suspended after a failed payment, Lunos prints Lunos Cloud's reason (`Lunos Cloud stopped the run: …`), exits non-zero and reports `failed`. The worker is still ended, and anything it changed is pushed to its branch.

Ctrl+C ends the worker, and anything it changed is still pushed to its branch.

### Your git token

The worker clones and pushes with your own git token for the repository's host, which Lunos Cloud
keeps encrypted and never shows again (XCOD-243):

```sh
lunos cloud git-token set github.com          # type it at a hidden prompt
echo "$GH_TOKEN" | lunos cloud git-token set github.com   # or pipe it in
lunos cloud git-token set gitlab.example.eu --username ada
lunos cloud git-token rm github.com
```

The token is read from stdin or a hidden prompt, never from an argument, so it doesn't end up in
your shell history. Use a token that can read and push to the repositories you run on (for GitHub, a
fine-grained token with Contents and Pull requests read and write). Lunos Cloud only keeps tokens for
the git hosts it clones from. You can also manage them in the console, under **Git access**. The
token goes to the same Lunos Cloud as session sync: `cloud.endpoint` in your user or managed config,
never a project's.

## What leaves your machine, and what doesn't

**Sent:**

- your repository's remote URL;
- the commit to start from;
- your branch name;
- the worker size;
- your resolved residency policy;
- the values of the `--cloud-secret` variables you name.

**Not sent:**

- your working tree: uncommitted changes stay on your machine, and Lunos tells you so;
- your stored provider keys from `lunos auth`, unless you name one with `--cloud-secret`;
- any other environment variable.

**Before anything is sent, Lunos refuses the run when:**

- offline mode is on;
- you aren't signed in;
- `cloud.endpoint` isn't https (localhost is allowed, for testing);
- the control plane's region isn't allowed by your residency policy;
- your current commit isn't on the remote yet.

**Audit log:** each refusal is written as `cloud.denied`, each dispatch as `cloud.dispatch`, and each end as `cloud.finish`. The log records the worker id, endpoint, region, repository and the names of the secrets you sent, never their values.

**Residency on the worker:** the worker is sent the residency policy Lunos resolved here, managed and locked settings included, and must enforce it as Lunos does locally.

## Workspaces

The same workers are a workspace type, `lunos-cloud`, next to `worktree` and `docker`. Creating one starts a worker. Its sessions run there, and removing it ends the worker and pushes its branch.

---

## The worker API (version 1)

This is the interface between the MIT harness and the Lunos Cloud control plane. The control plane is commercial and lives outside this repository: under the [open-core policy](licensing.md), commercial code uses the harness only through public interfaces like this one.

The schema is in `packages/opencode/src/cloud/contract.ts`. The client and the test fake (`test/cloud/fixtures/fake-control-plane.ts`) both use it.

Every request carries `Authorization: Bearer <access token>`. The token comes from `lunos login` at `cloud.issuer`, and the control plane validates it against that issuer.

| Request                   | Response                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /v1`                 | `{ api: 1, region: "eu" \| "us" \| "other", name? }`. Asked first, so residency is checked before code leaves.  |
| `PUT /v1/workers/{id}`    | **Worker.** Idempotent: the client picks `id` (`[a-z0-9]{8,32}`), so a retried request starts only one worker.  |
| `GET /v1/workers/{id}`    | **Worker.** The client polls while `status` is `starting`.                                                      |
| `DELETE /v1/workers/{id}` | `{ id, status: "destroyed", branch, pushed, commit?, activeSeconds }`. Answers only after the branch is pushed. |

**The `PUT` body:**

```json
{
  "repo": { "url": "git@github.com:acme/app.git", "commit": "<sha>", "branch": "main" },
  "size": "standard",
  "residency": { "allow": ["eu"], "enforce": true },
  "secrets": { "MISTRAL_API_KEY": "…" },
  "client": { "version": "1.18.44" }
}
```

**The Worker object:**

```json
{
  "id": "…",
  "status": "starting|running|stopped|failed|destroyed",
  "region": "eu",
  "url": "…",
  "auth": { "username": "…", "password": "…" },
  "directory": "…",
  "branch": "lunos/cloud/<id>",
  "activeSeconds": 0,
  "ended": { "reason": "spending_cap", "message": "…" }
}
```

- `url` and `auth` give the worker's Lunos server. The client attaches to it as `lunos run --attach` does.
- `directory` is the project directory on the worker (for example `/workspace`), not a path on your machine. The client only passes it to the worker's server.
- `branch` must be `lunos/cloud/<id>`. The client refuses any other value.
- `ended` (optional, added in XCOD-237) is set when the control plane itself stopped the run, for example for billing. `reason` is a code (`spending_cap`, `suspended`, `user_cap`, …; clients must accept codes they don't know) and `message` is shown to the user as is. The worker can still be `running`: `ended` is about the agent, and the worker stays up until `DELETE` pushes the results. The control plane sets `ended` **before** it aborts the worker's sessions, and keeps returning it for as long as `GET` answers for that worker, after it is destroyed too. Leave the key out when it isn't set (clients accept `null`, but don't rely on it). When an attached run ends, the client reads the Worker once (`GET`) and, if `ended` is set, prints the message and exits non-zero. Older clients ignore the field, and older control planes don't send it.

**Errors** are `{ "error": { "code", "message" } }`. Lunos shows the message as is. For a 401 and a 429 it adds the next step; a 402's message must say itself what happened and what to do, because one code covers several causes. Only a 402 without a message gets a generic billing explanation.

| Status | Code                | Meaning                                                                                      |
| ------ | ------------------- | -------------------------------------------------------------------------------------------- |
| 401    | `unauthenticated`   | The token is missing or expired.                                                             |
| 402    | `spending_cap`      | Billing refuses the run: no plan, a failed payment, seats full, or the spending cap reached. |
| 403    | `forbidden`         | Not allowed: the plan, the organisation's policy, or residency.                              |
| 404    | `not_found`         | No such worker.                                                                              |
| 409    | `conflict`          | The id is in use with a different request.                                                   |
| 429    | `concurrency_limit` | Too many workers at once for the tier.                                                       |

### Who does what (XCOD-186)

| Acceptance criterion                                        | Done by                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| AC1: `lunos run --cloud`; attach, watch, approve and cancel | **Client (this repository).** The IDE and TUI toggle, `/tasks` and the web view are follow-ups.                                   |
| AC2: an isolated environment per run, destroyed afterwards  | Control plane                                                                                                                     |
| AC3: egress allow-list; secrets encrypted at rest           | Control plane. The client sends only the secrets the user names.                                                                  |
| AC4: repo access with the user's token; results as a branch | Shared. The control plane holds the token. The client sends the remote and commit, and refuses any branch but `lunos/cloud/<id>`. |
| AC5: metering of active time                                | Control plane. It reports `activeSeconds`, and the client shows it.                                                               |
| AC6: concurrency limits and spending cap                    | Control plane. The client shows a 402's reason as is, explains a 429, and reports a run stopped mid-way (`ended`).                |
| AC7: residency applies on the worker                        | Shared. The client checks the region and sends the resolved policy; the worker enforces it.                                       |
| AC8: workers only in the Phase 7 data centre                | Control plane. `GET /v1` reports the region.                                                                                      |
