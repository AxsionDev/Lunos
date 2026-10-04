# /run-eval: rerun the Lunos model evaluation (XCOD-119 harness)

Runs `packages/eval` end to end and publishes the result as `specs/eval/<date>.md`. Spends real
money, so it **stops for the owner's approval before any paid request**. Read
`packages/eval/README.md` first. It explains the metering proxy, budget ledgers and reports.

## Rules

- **Never read, print or copy API keys.** The owner exports them (e.g. `OPENAI_API_KEY`,
  `MISTRAL_API_KEY`) in their shell. Only the proxy reads them.
- **Label the provider's region.** A US model (OpenAI, Anthropic) is reported and documented as a
  US provider; never as EU.
- **No paid run without an explicit "yes" to the estimate in this conversation.** The free steps (3
  and 4) need no approval.
- Prices come from the provider's own pricing page, with the URL and the date checked. Use a
  catalogue such as models.dev only when the provider doesn't list the model, and say so in
  `source`.

## Steps

1. **Config.** `packages/eval/eval.config.json` is gitignored. If it's missing, copy
   `eval.config.example.json` and fill in:
   - the models
   - a new `budget.name` per campaign (the ledger accumulates under that name)
   - `usdToEur` from the ECB daily reference rate (`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`, rate = 1 / USD)
   - € prices with `maxOutputTokens`. Set it to Lunos's `OUTPUT_TOKEN_MAX` (32000,
     `packages/opencode/src/provider/transform.ts`) when the model allows more: the proxy reserves
     the worst case per request, so a model's full limit (e.g. 128k) can make one request reserve
     more than a small cap holds.
   - `cacheRead` too, if the provider lists a cached-input price

   Registry datasets use the bare name (`aider/aider-polyglot`, no `@latest`). Task names carry the
   org prefix (`aider/polyglot_python_forth`).

2. **Count the tasks.** `--tasks` is the total across all datasets (local tasks + listed registry tasks).
3. **Estimate (free):** `bun packages/eval/src/cli.ts estimate --config packages/eval/eval.config.json --tasks <n>`
4. **Pipeline check (free).** Use Harbor's reference-solution agent: no model calls, no key needed.
   Write its output outside the repo so it can't be mistaken for a result:
   `bun packages/eval/src/cli.ts run --config <copy with one model> --tasks <n> --agent oracle --yes --out <tmp> --report <tmp>/oracle.md`.
   Every task should pass. A task that fails under oracle is a broken task, not a model result:
   exclude it and record why.
5. **Ask the owner.** Show the estimate, the budget cap and the oracle result. Wait for "yes".
6. **Smoke run first (2–3 tasks, a small separate budget).** Before the full run, check at least
   one task passes and the agent made tool calls (`"type":"tool_use"` in the trial's
   `agent/opencode.txt`). It catches a key that is rate-limited (every request 429) or a model the
   provider serves only through an API the harness doesn't speak. One plain request with the key
   first is cheaper still.
7. **Paid run:** the same `run` command without `--agent`, with `--yes`. `--concurrency <n>`
   (default 4) keeps parallel tasks within the key's rate limit.
8. **Publish** on a branch off `dev`, PR to `dev`. The owner merges.
   - Commit `specs/eval/<date>.md`, plus `runs/<date>/report.json` copied to
     `specs/eval/<date>.results.json` (`runs/` is gitignored).
   - The report must state: harness commit, Lunos version, task set, models, provider/region, runs
     per task, pass rate, cost, wall time, excluded tasks with reasons, and the one command that
     reproduces it.
   - Commit the spend ledger (`runs/ledger-<budget>.jsonl`) as `specs/eval/<date>.ledger.jsonl`, and
     state any smoke-run spend.
   - INCOMPLETE models show no pass rate. Don't round one into a result. A task that hit a rate
     limit or never started counts as "did not run" (the model is INCOMPLETE); code that doesn't
     compile is the agent's failure.
   - Update the docs page `packages/web/lunos/pages/models-tested.mdx` with the date and result.

Example: `specs/eval/2026-10-04.md` (openai/gpt-5.3-codex, 21 of 33).
