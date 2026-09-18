# Marketplace manifest

Technical reference for the Lunos plugin marketplace manifest format (XCOD-8, child of the
marketplace epic XCOD-7). This spec defines the schema only — discovery, fetching, and
install flows are downstream work for other stories under that epic.

## Overview

- A marketplace is a single JSON manifest listing installable plugins.
- Modeled loosely on Claude Code's `.claude-plugin/marketplace.json`, scoped down for v1.
- v1 supports exactly two plugin source types: `npm` and `github`. `archive`, `command`,
  `git-subdir` sources, and cross-marketplace dependencies are explicitly out of scope for
  this pass.
- Validated with an Effect Schema class (`Marketplace.Manifest`), consistent with how the
  rest of `packages/core/src/config` validates configuration — not Zod/JSON-schema.
- Type and validator live in `packages/core/src/marketplace.ts`, not under
  `packages/core/src/config/` — a marketplace manifest is a distinct artifact from the
  `opencode.json`/`.opencode` config tree that `Config.Info` describes.

## Manifest location

- **Local marketplace:** `.opencode/marketplace.json`, following this fork's established
  config-directory convention (the same `.opencode` directory `tui.json` and plugin files
  already live in).
- **Remote marketplace:** fetched from a git repository or URL, expected at `marketplace.json`
  in the repository root — the direct mirror of the local `.opencode/marketplace.json`
  convention above, so the same file works whether it's read from a local checkout or a
  remote clone. This spec fixes the manifest's own shape and this location convention;
  the actual fetch/install implementation is downstream epic work, not part of this story.

## Manifest schema

```json
{
  "name": "lunos-community",
  "owner": {
    "name": "Lunos Community",
    "url": "https://github.com/lunos-community"
  },
  "description": "Community-curated plugins for Lunos.",
  "version": "1.0.0",
  "plugins": [
    {
      "name": "conventional-commits",
      "source": {
        "type": "npm",
        "package": "@lunos-community/conventional-commits",
        "version": "^1.2.0"
      },
      "description": "Enforces Conventional Commits message format.",
      "author": "Lunos Community",
      "category": "git",
      "tags": ["git", "commits"]
    },
    {
      "name": "rust-analyzer-bridge",
      "source": {
        "type": "github",
        "repo": "lunos-community/rust-analyzer-bridge",
        "ref": "v2"
      },
      "description": "Bridges rust-analyzer diagnostics into Lunos.",
      "category": "lsp"
    }
  ]
}
```

### Top-level fields

| Field         | Required | Type                    | Notes                                                                                                                                                                                                                                   |
| ------------- | -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`     | no       | `string`                | JSON schema reference, matching `opencode.json`/`tui.json` convention. No schema is published/hosted for this format yet — the field is supported for when one exists, and omitted from the example above to avoid implying a live URL. |
| `name`        | yes      | `string`                | Marketplace identifier.                                                                                                                                                                                                                 |
| `owner`       | yes      | `object`                | See below.                                                                                                                                                                                                                              |
| `description` | no       | `string`                |                                                                                                                                                                                                                                         |
| `version`     | no       | `string`                |                                                                                                                                                                                                                                         |
| `plugins`     | yes      | array of plugin entries | May be empty.                                                                                                                                                                                                                           |

### `owner`

| Field   | Required | Type     |
| ------- | -------- | -------- |
| `name`  | yes      | `string` |
| `email` | no       | `string` |
| `url`   | no       | `string` |

### Plugin entry

| Field         | Required | Type              | Notes      |
| ------------- | -------- | ----------------- | ---------- |
| `name`        | yes      | `string`          |            |
| `source`      | yes      | tagged union      | See below. |
| `description` | no       | `string`          |            |
| `version`     | no       | `string`          |            |
| `author`      | no       | `string`          |            |
| `category`    | no       | `string`          |            |
| `tags`        | no       | array of `string` |            |

### `source` (tagged on `type`)

Exactly two shapes are valid in v1:

```json
{ "type": "npm", "package": "@scope/name", "version": "1.2.3" }
```

```json
{ "type": "github", "repo": "org/name", "ref": "v2" }
```

| Type     | Field     | Required | Type     | Notes                                                                |
| -------- | --------- | -------- | -------- | -------------------------------------------------------------------- |
| `npm`    | `package` | yes      | `string` | npm package name.                                                    |
| `npm`    | `version` | no       | `string` | Defaults to latest.                                                  |
| `github` | `repo`    | yes      | `string` | `org/name` form.                                                     |
| `github` | `ref`     | no       | `string` | Branch, tag, or commit. Defaults to the repository's default branch. |

Any other `type` value fails validation — see [Validation errors](#validation-errors).

## Validation errors

`Marketplace.decode` (`Schema.decodeUnknownSync(Marketplace.Manifest)`) throws a descriptive
`ParseError` naming the failing field path and what was expected. For example, an
unsupported source `type`:

```json
{ "type": "archive", "url": "https://example.com/plugin.tar.gz" }
```

produces:

```
Expected { readonly "type": "npm", ... } | { readonly "type": "github", ... }, got {"type":"archive","url":"https://example.com/plugin.tar.gz"}
  at ["plugins"][0]["source"]
```

## Seed marketplace (community plugins)

`marketplace.json` at the repository root (XCOD-9) is the default community marketplace,
converted from `packages/web/src/content/docs/ecosystem.mdx`'s "Plugins" table. It's reachable
at a fixed location — `https://raw.githubusercontent.com/pminev1/Lunos/dev/marketplace.json` —
for a fresh install to add without hunting for a source, per this doc's manifest-location
convention above. `ecosystem.mdx` itself is unchanged; the seed manifest is a second,
structured artifact derived from the same data, not a replacement for the docs page.

Mapping decisions:

- 36 of the table's 38 "Plugins" rows are included, each mapped to a `github` source using
  the row's linked repository.
- **2 rows excluded — monorepo subdirectories:** `opencode-daytona`
  (`daytona/integrations/tree/main/packages/opencode-plugin`) and `@plannotator/opencode`
  (`backnotprop/plannotator/tree/main/apps/opencode-plugin`) each link to a subdirectory of a
  larger repository, not a plugin repository root. The `github` source type has no subpath
  field — `git-subdir` sources are explicitly deferred past v1 (see Overview) — so pointing
  `repo` at the monorepo root would name the wrong install location. Excluded rather than
  misrepresented.
- **"Projects" and "Agents" sections excluded entirely:** those rows (a Discord bot, editor
  frontends, a mobile client, agent/prompt configs, etc.) aren't installable Lunos/opencode
  plugins — they're separate tools and integrations built around the ecosystem, which is why
  `ecosystem.mdx` lists them under different headings in the first place.
- **`ref` omitted unless the source table states one.** Only one row's link
  (`opencode-md-table-formatter`, `.../tree/main`) names a branch; that one entry sets
  `ref: "main"`. For the other 35 included entries, no branch is knowable from the table, and
  `ref` is optional (defaults to the repository's default branch per the schema) — guessing
  `"main"` for all of them would fabricate data that's wrong for any repository still on
  `master`.
- `category` and `tags` are omitted throughout — `ecosystem.mdx`'s table doesn't carry that
  data, and the schema doesn't require it.

## Marketplace cache (XCOD-13)

Resolved manifests are cached to disk so `lunos marketplace list`, `plugin list`/`search`, and the
TUI Discover view (XCOD-11, XCOD-12) all read from cache instead of re-fetching independently —
following the same on-disk cache precedent as `@opencode-ai/core`'s npm plugin install cache
(`Npm.add`, keyed under `Global.Path.cache`) and its `models-dev` catalog cache (`Hash.fast(source)`

- file mtime as the freshness clock), rather than inventing a new cache location or format.

* **Location:** `~/.cache/opencode/marketplace/<hash>.json`, one file per added source, where
  `<hash>` is `Hash.fast(source)` (`packages/core/src/util/hash.ts`, sha1) of the source string
  exactly as configured (owner/repo shorthand, URL, or normalized local path).
* **Format:** the resolved `Marketplace.Manifest` JSON as-is — no wrapper object. The file's mtime
  doubles as `fetchedAt`, so there's nothing else to keep in sync.
* **Freshness policy (v1):** a cache hit younger than 24 hours is served with no network or file
  fetch at all. Once it's older than that, the next read attempts one live re-fetch: success
  rewrites the cache; failure falls back to the existing (now-stale) cached manifest rather than
  failing the read. This is the "refresh in the background on a timer" policy this manifest-spec's
  Overview deferred to a later story, implemented lazily on read rather than as a background fiber.
* **Local `path` sources bypass the cache entirely** and are always read live, mirroring how
  `resolvePluginTarget` (`packages/opencode/src/plugin/shared.ts`) caches npm plugin installs but
  reads file-plugin paths straight off disk every time. A local directory/file has no network
  round-trip to save and can't go "unreachable but last-known-good" the way a URL or GitHub source
  can.
* **Explicit refresh:** `lunos marketplace update <name>` (accepts either the configured source or
  the manifest's declared `name`) bypasses the freshness check and forces a re-fetch. On failure it
  leaves the on-disk cache untouched and reports the error — the last-known-good manifest keeps
  being served by `list`/`search`/Discover.
* **Unreachable sources:** a source that fails its live re-fetch (via the lazy TTL check above, or
  via `marketplace update`) but has a prior successful cache continues to resolve successfully, with
  a `stale` field carrying the failure reason. Callers surface this as a visible "refresh failed,
  showing cache from <time>" indicator rather than silently degrading or erroring the whole command.
  A source with no successful fetch ever (nothing cached yet) still fails outright — there is no
  last-known-good to fall back to.
* **Implementation:** `packages/opencode/src/marketplace/shared.ts` (`resolveWithCache`,
  `resolveAddedMarketplaces`, `refreshMarketplaceCache`).

## Current in-repo examples

- Valid manifest: `packages/core/test/fixtures/marketplace/valid.json`
- Malformed manifest (unsupported source type): `packages/core/test/fixtures/marketplace/malformed.json`
- Seed community marketplace: `marketplace.json` (repository root)
- Schema and validator: `packages/core/src/marketplace.ts`
- Tests: `packages/core/test/marketplace.test.ts`, `packages/opencode/test/marketplace/shared.test.ts`
