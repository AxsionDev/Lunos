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

| Field         | Required | Type              | Notes                                             |
| ------------- | -------- | ----------------- | -------------------------------------------------- |
| `$schema`     | no       | `string`           | JSON schema reference, matching `opencode.json`/`tui.json` convention. No schema is published/hosted for this format yet — the field is supported for when one exists, and omitted from the example above to avoid implying a live URL. |
| `name`        | yes      | `string`           | Marketplace identifier.                            |
| `owner`       | yes      | `object`           | See below.                                         |
| `description` | no       | `string`           |                                                    |
| `version`     | no       | `string`           |                                                    |
| `plugins`     | yes      | array of plugin entries | May be empty.                                |

### `owner`

| Field   | Required | Type     |
| ------- | -------- | -------- |
| `name`  | yes      | `string` |
| `email` | no       | `string` |
| `url`   | no       | `string` |

### Plugin entry

| Field         | Required | Type              | Notes                                    |
| ------------- | -------- | ----------------- | ----------------------------------------- |
| `name`        | yes      | `string`           |                                           |
| `source`      | yes      | tagged union       | See below.                                |
| `description` | no       | `string`           |                                           |
| `version`     | no       | `string`           |                                           |
| `author`      | no       | `string`           |                                           |
| `category`    | no       | `string`           |                                           |
| `tags`        | no       | array of `string`  |                                           |

### `source` (tagged on `type`)

Exactly two shapes are valid in v1:

```json
{ "type": "npm", "package": "@scope/name", "version": "1.2.3" }
```

```json
{ "type": "github", "repo": "org/name", "ref": "v2" }
```

| Type     | Field     | Required | Type     | Notes                                          |
| -------- | --------- | -------- | -------- | ----------------------------------------------- |
| `npm`    | `package` | yes      | `string` | npm package name.                              |
| `npm`    | `version` | no       | `string` | Defaults to latest.                             |
| `github` | `repo`    | yes      | `string` | `org/name` form.                                |
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

## Current in-repo examples

- Valid manifest: `packages/core/test/fixtures/marketplace/valid.json`
- Malformed manifest (unsupported source type): `packages/core/test/fixtures/marketplace/malformed.json`
- Schema and validator: `packages/core/src/marketplace.ts`
- Tests: `packages/core/test/marketplace.test.ts`
