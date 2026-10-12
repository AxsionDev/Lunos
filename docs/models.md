# Choosing a model: Recommended and size filters

The model picker in the TUI, desktop and web apps has four filters: **All**, **Recommended**, **Large** and **Small**. In the TUI, `ctrl+l` cycles through them. In desktop and web, they are buttons under the search box. Lunos remembers your choice across restarts. The same filters work on the command line:

```sh
lunos models --recommended        # curated models, each with why
lunos models --size small         # small models only (also: large, medium)
lunos models --recommended --size large
```

Filters don't override [data residency](data-residency.md). A model your policy blocks keeps its **blocked by policy** tag under every filter, and can't be chosen.

## What "Recommended" means

Recommended is a **curated list**, maintained by Lunos and shipped with each release. It is **not an evaluation or a benchmark**. No eval results for these models have been published yet. When they exist, the list will be updated from them and this page will link the results.

The built-in list has only EU-hosted and local models, to match the residency defaults Lunos is built around. "EU-hosted" means what [model provider jurisdictions](provider-jurisdictions.md) records for that provider. Each entry comes with a one-line reason. In the TUI it shows under the model's name, and in desktop and web it shows in the tooltip.

| Model                                   | Why                                             |
| --------------------------------------- | ----------------------------------------------- |
| `mistral/mistral-medium-latest`         | EU-hosted; a balanced default for coding        |
| `mistral/mistral-large-latest`          | EU-hosted; flagship for hard reasoning          |
| `mistral/codestral-latest`              | EU-hosted; fast for completion and small edits  |
| `mistral/mistral-small-latest`          | EU-hosted; cheap and fast for simple tasks      |
| `scaleway/qwen3-coder-30b-a3b-instruct` | EU-hosted (Scaleway, France); open-weight coder |
| `ovhcloud/qwen3-coder-30b-a3b-instruct` | EU-hosted (OVHcloud); open-weight coding model  |
| `ollama/qwen3:4b`                       | Runs on your machine, offline; for simple edits |

A model shows up only if you have its provider set up.

### Your organisation's list

The `recommended` key replaces the built-in list entirely. Its value maps `provider/model` to a reason. To set it for everyone in an organisation, put it in managed config and lock it:

```json
{
  "recommended": {
    "mistral/mistral-large-latest": "Approved for client code",
    "ollama/qwen3:4b": "Approved for offline work"
  },
  "$locked": ["recommended"]
}
```

## When your organisation locks the model

An organisation can pin the model everyone uses by locking `model` in managed config:

```json
{
  "model": "mistral/mistral-large-latest",
  "$locked": ["model"]
}
```

Every other model then has a grey **locked by your organisation** tag in the TUI, desktop and web pickers, and choosing one shows the policy message instead of switching. `lunos models` adds a `locked by your organisation (model)` column to those rows. The server refuses it too: `lunos run --model other/model` (or any client asking for another model) fails with the policy message, and the attempt is written to the audit log as `policy.override_refused`. A model picked before the lock falls back to the locked one.

`agent.<name>.model` locks one agent's model the same way: for that agent as the main agent, and for it as a subagent. `subagent.model` locks the model of every subagent that has no locked model of its own; the main agent can't choose another one per task. Locking `model` alone doesn't pin subagents, or `small_model` (lock those keys too if you need them pinned). Without a lock nothing changes.

## How size is decided

Every model gets a `Large`, `Medium` or `Small` tag, or no tag at all. Large and Small have filters. Medium models appear under **All** only. The first rule that applies decides:

1. **Not a chat model** (embeddings, speech, image, video, safety classifiers): no tag.
2. **A curated override**, for hosted models whose name doesn't say their size. For example, every Anthropic Sonnet is Large.
3. **Parameter count**, for open-weight and local models whose id states it (`qwen3:4b`, `llama-3.3-70b`, `open-mixtral-8x22b`). The count is the **total** parameters. For a mixture of experts like `qwen3.5-397b-a17b`, that's 397B, not the 17B active.
   - **Small:** 15B or fewer
   - **Medium:** 16B to 69B
   - **Large:** 70B or more
4. **The provider's own tier**, from the model's name:
   - **Small:** `mini`, `nano`, `small`, `tiny`, `lite`, `flash`, `haiku`, `ministral`
   - **Medium:** `medium`
   - **Large:** `large`, `opus`, `fable`, `pro`, `max`, `ultra`
5. **Otherwise: no tag.** Lunos leaves the size blank rather than guess. Such models are listed under **All** only.

The rules live in `packages/opencode/src/provider/curation.ts`.
