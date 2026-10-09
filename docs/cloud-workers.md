# Cloud workers: `lunos run --cloud`

`lunos run --cloud` sends a run to a Lunos Cloud worker instead of running it on your machine. The worker clones your repository at your current commit, runs the agent, and pushes the results to a branch, `lunos/cloud/<id>`. It never pushes to your default branch. You can close your laptop in the meantime.

> **Status:** the client side is in Lunos. Lunos Cloud's control plane isn't live yet, so `cloud.endpoint` has no default. Until it's live, `--cloud` says so and stops.

## Using it

```sh
lunos login                                   # once; see cloud-login.md
lunos settings set cloud.endpoint https://cloud.lunos.tech
git push                                      # the worker starts from what's on your remote
lunos run --cloud "Add input validation to parse.ts"
git fetch origin lunos/cloud/<id>             # the results, when it's done
```

| Option                | What it does                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `--cloud`             | Run on a worker. Output streams here, and approvals come to you here, as in a local run.           |
| `--cloud-size large`  | A larger worker. It counts double toward your agent-hours.                                         |
| `--cloud-secret NAME` | Send environment variable `NAME` to the worker for this run. Repeat it for more than one variable. |

Ctrl+C ends the worker, and anything it changed is still pushed to its branch.

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
  "activeSeconds": 0
}
```

- `url` and `auth` give the worker's Lunos server. The client attaches to it as `lunos run --attach` does.
- `branch` must be `lunos/cloud/<id>`. The client refuses any other value.

**Errors** are `{ "error": { "code", "message" } }`. Lunos shows the message as is, and adds the next step:

| Status | Code                | Meaning                                                                  |
| ------ | ------------------- | ------------------------------------------------------------------------ |
| 401    | `unauthenticated`   | The token is missing or expired.                                         |
| 402    | `spending_cap`      | The spending cap is reached. The agent stops; nothing is billed past it. |
| 403    | `forbidden`         | Not allowed: the plan, the organisation's policy, or residency.          |
| 404    | `not_found`         | No such worker.                                                          |
| 409    | `conflict`          | The id is in use with a different request.                               |
| 429    | `concurrency_limit` | Too many workers at once for the tier.                                   |

### Who does what (XCOD-186)

| Acceptance criterion                                        | Done by                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| AC1: `lunos run --cloud`; attach, watch, approve and cancel | **Client (this repository).** The IDE and TUI toggle, `/tasks` and the web view are follow-ups.                                   |
| AC2: an isolated environment per run, destroyed afterwards  | Control plane                                                                                                                     |
| AC3: egress allow-list; secrets encrypted at rest           | Control plane. The client sends only the secrets the user names.                                                                  |
| AC4: repo access with the user's token; results as a branch | Shared. The control plane holds the token. The client sends the remote and commit, and refuses any branch but `lunos/cloud/<id>`. |
| AC5: metering of active time                                | Control plane. It reports `activeSeconds`, and the client shows it.                                                               |
| AC6: concurrency limits and spending cap                    | Control plane. The client turns 429 and 402 into clear messages.                                                                  |
| AC7: residency applies on the worker                        | Shared. The client checks the region and sends the resolved policy; the worker enforces it.                                       |
| AC8: workers only in the Phase 7 data centre                | Control plane. `GET /v1` reports the region.                                                                                      |
