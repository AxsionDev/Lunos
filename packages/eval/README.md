# Lunos evaluation (XCOD-119)

Measures how well **Lunos itself** (its agent loop, tools, prompts and permissions) solves coding
tasks on EU, self-hosted and frontier models, and what that costs. Results are published in
`specs/eval/<date>.md`.

## How it works

- **[Harbor](https://github.com/harbor-framework/harbor)** runs every task in its own Docker
  container and grades it with tests the agent never sees. Its registry provides Aider Polyglot
  and Terminal-Bench. `harbor/lunos_agent.py` adapts Harbor's opencode agent to Lunos: it installs
  `lunos-ai`, runs with `LUNOS_OFFLINE=1`, and replaces every API key with a placeholder.
- **The metering proxy** (`src/proxy.ts`) runs on the host and holds the real keys. Containers talk
  only to it, through a path that includes a random token per run, so nothing else on the network
  can spend through it. For every request it reserves the worst-case cost (prompt bytes counted as tokens,
  plus the largest possible completion) and **refuses the request, before sending it, if that could
  pass the total cap or the model's class cap**. It then settles the measured cost from the
  response's usage. Prices come from the harness's own table (`prices` in the config, in €), never
  from Lunos's reported cost. A provider error without usage is recorded but not charged.
- **Spend is cumulative per named budget.** Every request is appended to
  `runs/ledger-<budget.name>.jsonl`, and a new run loads it: a pilot and the baseline after it, or a
  run restarted after a crash, share the same caps. The CLI also stops starting new trials for a
  model once its class can't pay for one more request.
- **Residency.** Each model runs with its own `residency` policy. Because the provider's base URL
  points at the proxy, Lunos's audit log records the proxy's address. The proxy's log of
  upstream hosts, included in the report, is the record of where traffic actually went.
- **The report** marks any model whose runs didn't all finish, or that hit a cap, as INCOMPLETE,
  and doesn't show its pass rate.

## Run

1. Copy `eval.config.example.json` to `eval.config.json` (gitignored). Fill in models, the budget
   (with a `name`), `usdToEur`, and a € price for every model, each with its source URL and the
   date you checked it. An unpriced model is refused.
2. Set each model's key on the host (`keyEnv`). Only the proxy reads it.
3. `bun src/cli.ts estimate --config eval.config.json --tasks <n>`
4. `bun src/cli.ts run --config eval.config.json --tasks <n>` shows the estimate and stops. Add
   `--yes` to spend.

Needs Docker and [uv](https://docs.astral.sh/uv/) (Harbor runs with `uvx --from harbor`).
`--agent oracle` runs the whole pipeline with Harbor's reference-solution agent instead of Lunos,
at no cost; `--report <file>` writes the report somewhere other than `specs/eval/`. Its report is
titled "pipeline check" and lists the tasks that failed: a task that fails under the oracle is
broken and must be left out of the paid run.

Registry datasets (Aider Polyglot) are exported to `runs/datasets/` and built from there
(`src/stage.ts`), for two reasons:

- Exported task files are all dated 1970 and most oracle payloads are the same size, so BuildKit
  reused one task's solution file in other tasks' images (`--no-cache` doesn't help). Each task's
  files get their own date.
- The Java tasks hard-code the amd64 `JAVA_HOME`. It's pointed at the host's JDK, and the report
  says which tasks were changed.

The Lunos agent doesn't install anything in the task container. `src/agent-bin.ts` downloads the
release's `lunos-linux-<arch>.tar.gz` once (checked against the release's SHA256SUMS) and the
ripgrep build pinned for the offline bundles, and `harbor/lunos_agent.py` copies both in. Installing
with apt and `npm i -g lunos-ai` failed on the Ubuntu 22.04 task images (Node 12) and used most of
Harbor's 360 s agent-setup limit.

## Lunos task set

`tasks/` holds tasks taken from real Lunos fixes, in Harbor's format. Each one's test fails on the
code before the fix and passes on the fix Lunos shipped (`solution/solve.sh`). Check a task with
Harbor's oracle agent, which applies the solution without a model:

```bash
uvx --from harbor harbor run -p packages/eval/tasks -a oracle
```

## Verified end to end (2026-09-27, no spend)

- 2026-10-03: oracle on the 3 Lunos tasks + the 30-task Aider Polyglot slice, 33/33. Each trial's
  oracle log shows it applied its own exercise's solution (before the fix, 8 of 30 Polyglot tasks
  passed, some with another task's solution).

- Oracle agent through the CLI's own job files: 3/3 tasks in each of 2 trials, report complete.
- Lunos 1.18.40 in Harbor's containers, through the proxy, to a priced mock model: 6 requests
  metered at the mock's usage (€0.09), the only upstream host was the mock, the real key appeared
  in no container or job output, and Lunos's audit log recorded `mistral`/`eu`/allowed.
- The same with a €0.06 budget: 4 requests settled (€0.06), 2 refused with HTTP 402, each task
  ended within 3 seconds, and the report marked the run INCOMPLETE with no pass rate.

## Tests

`bun test ./test` covers the price and budget arithmetic, the proxy against a mock provider
(metering from the usage chunk, refusal before sending, spend never passing the cap, settlement
on a dropped stream), config validation, the estimate, job generation and result parsing.
