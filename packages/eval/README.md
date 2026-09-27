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
  only to it. For every request it reserves the worst-case cost (prompt bytes counted as tokens,
  plus the largest possible completion) and **refuses the request, before sending it, if that could
  pass the total cap or the model's class cap**. It then settles the measured cost from the
  response's usage. Prices come from the harness's own table (`prices` in the config), never from
  Lunos's reported cost.
- **Residency.** Each model runs with its own `residency` policy. Because the provider's base URL
  points at the proxy, Lunos's audit log records the proxy's address. The proxy's log of
  upstream hosts, included in the report, is the record of where traffic actually went.
- **The report** marks any model whose runs didn't all finish, or that hit a cap, as INCOMPLETE,
  and doesn't show its pass rate.

## Run

1. Copy `eval.config.example.json` to `eval.config.json` (gitignored). Fill in models, the budget,
   `usdToEur`, and a price for every model, each with its source URL and the date you checked it.
   An unpriced model is refused.
2. Set each model's key on the host (`keyEnv`). Only the proxy reads it.
3. `bun src/cli.ts estimate --config eval.config.json --tasks <n>`
4. `bun src/cli.ts run --config eval.config.json --tasks <n>` shows the estimate and stops. Add
   `--yes` to spend.

Needs Docker and [uv](https://docs.astral.sh/uv/) (Harbor runs with `uvx --from harbor`).

## Lunos task set

`tasks/` holds tasks taken from real Lunos fixes, in Harbor's format. Each one's test fails on the
code before the fix and passes on the fix Lunos shipped (`solution/solve.sh`). Check a task with
Harbor's oracle agent, which applies the solution without a model:

```bash
uvx --from harbor harbor run -p packages/eval/tasks -a oracle
```

## Tests

`bun test ./test` covers the price and budget arithmetic, the proxy against a mock provider
(metering from the usage chunk, refusal before sending, spend never passing the cap, settlement
on a dropped stream), config validation, the estimate, job generation and result parsing.
