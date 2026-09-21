# Marketplace registry — preserved design specs

Design documentation for the Lunos Marketplace Registry Service (epic
[XCOD-32](https://axsion.atlassian.net/browse/XCOD-32)). **Nothing here is implemented in this
repo.** These files exist so the design work survives; see _Status_ below.

## Why these files are here

The registry was implemented in full in this repo (XCOD-33/34/35/36), then deliberately reverted
out on 2026-09-15 in commit `45a0944778`, on the decision that it would be built as a separate
project instead:

> The Lunos Marketplace Registry Service will be built as a separate project instead of living in
> this repo. [...] Functional requirements for the separate project were extracted from the removed
> design docs and handed off outside this repo.

That handoff target was never located — no successor ticket exists anywhere in Jira, and no
successor doc survived. This directory is the recovery, filed under
[XCOD-59](https://axsion.atlassian.net/browse/XCOD-59).

## What is here

Restored from `45a0944778^`. **Prose is unmodified** — only the filenames are new, and Prettier
reflowed the markdown on the way in (`script/format.ts` runs `prettier --write .` repo-wide, so
files that skip it get rewritten and auto-committed by the `generate` workflow anyway). No wording
was edited. The "original" column is the line count at that commit; two files grew purely from
re-wrapping.

| File                                           | Restored from                                        | Original |
| ---------------------------------------------- | ---------------------------------------------------- | -------- |
| [`service-spec.md`](service-spec.md)           | `packages/opencode/specs/marketplace-registry.md`    | 215      |
| [`api-overview.md`](api-overview.md)           | `.claude/docs/xcod-34-registry-api.md`               | 228      |
| [`api-contracts.md`](api-contracts.md)         | `.claude/docs/xcod-34-registry-api-contracts.md`     | 603      |
| [`api-user-journeys.md`](api-user-journeys.md) | `.claude/docs/xcod-34-registry-api-user-journeys.md` | 475      |
| [`api-stories.md`](api-stories.md)             | `.claude/stories/xcod-34-registry-api.md`            | 404      |
| [`deployment.md`](deployment.md)               | `.claude/docs/xcod-36-registry-deploy.md`            | 89       |

2,014 lines at origin. Note XCOD-59's own table lists only the first five (~1,925 lines) and omits
`deployment.md`; it is included here because the same commit removed it and it is part of the same
design set.

To read any of them exactly as written, bypassing the reflow:

```sh
git show 45a0944778^:.claude/docs/xcod-34-registry-api-contracts.md
```

## Recovering the implementation

The reverted implementation is equally recoverable and is **not** copied into this directory — it
is code, not design, and duplicating it here would create a second unbuilt copy to keep in sync.
Retrieve it from git when the separate project exists:

```sh
# the 35 implementation files, as a directory
git show 45a0944778^:packages/registry           # browse the tree
git checkout 45a0944778^ -- packages/registry    # restore into a working tree

# supporting infrastructure removed by the same commit
git show 45a0944778^:infra/registry.ts
```

It comprised `packages/registry` (D1 schema + migrations, read API handlers, ingestion worker,
resolver, router, seed) with test files alongside each module, plus `infra/registry.ts` and an
`sst.config.ts` entry. Per the epic's own records XCOD-34/35/36 were completed and tested, so this
is a working starting point rather than a sketch — but it has not been built or run since
2026-09-15 and will have drifted from the current `dev`.

## Design decisions worth not re-deriving

- **Hosting:** Cloudflare Worker + D1 created with `jurisdiction: "eu"`, chosen over Enterprise-tier
  Regional Services, AWS `eu-*`, and self-hosted EU VPS. Rationale and rejected options are in
  [`service-spec.md`](service-spec.md).
- **Claim discipline:** the spec is explicit that `jurisdiction: "eu"` guarantees where the
  _dataset_ lives, **not** that every Worker invocation executes in the EU. That distinction
  matches the wording rules XCOD-55 later established for infrastructure claims, and should be
  carried forward rather than softened.
- **Scope:** the registry is an _additional, optional_ marketplace source. The existing client-side
  marketplace model (XCOD-8–13) is unaffected and `marketplace add <source>` does not change.

## Status

Preserving this design is the whole of XCOD-59. Two things remain open and are **owner decisions**,
not engineering ones:

1. **Where the separate registry project lives** — a new repository, or an explicit "not yet" with
   a named owner. Until that is answered, this directory is the durable home, which is the fallback
   XCOD-59 permits.
2. **Whether the reverted `packages/registry` implementation is the intended starting point** or is
   to be rewritten from these specs.

Standing up or hosting the service is explicitly out of scope — hosted infrastructure is deferred
by [XCOD-55](https://axsion.atlassian.net/browse/XCOD-55), which scoped the public claim to
self-hosted-only for now.

## Related

- [XCOD-32](https://axsion.atlassian.net/browse/XCOD-32) — the epic whose output this preserves
- [XCOD-59](https://axsion.atlassian.net/browse/XCOD-59) — this recovery
- [XCOD-55](https://axsion.atlassian.net/browse/XCOD-55) — defers the hosted offering
- [XCOD-14](https://axsion.atlassian.net/browse/XCOD-14) — closed as a duplicate of XCOD-32
