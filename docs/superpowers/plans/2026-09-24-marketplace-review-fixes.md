# Marketplace Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every plugin in the official `lunos-community` marketplace actually install, and fix the four client defects found in the 2026-09-24 end-to-end review of `origin/dev` @ `2ea811741e`.

**Architecture:** Plugin installs are fixed in the data, not the client. The repo-root `marketplace.json` switches from `github` sources, which fail under npm 12 and Arborist, to verified `npm` sources, and a core test stops `github` sources from coming back. The client fixes are small and local:

- header → env-var name mapping in `marketplace/guard.ts`
- a counts-every-kind summary in `marketplace/content.ts`
- scoped-name resolution in `marketplace/resolve.ts`
- `CliError` surfacing in the `marketplace install` handler

**Tech Stack:** Bun + TypeScript monorepo, Effect (`effectCmd`, `fail`), `bun:test`, `jsonc-parser`, `@npmcli/arborist` 9.4.0 (plugin installs).

**Spec:** The findings of the 2026-09-24 review (in conversation; summarised in "Findings → Tasks" below). No separate spec document exists.

## Global Constraints

- **Work in a dedicated worktree, never in the shared checkout.** The shared checkout's local `dev` is at `a43359e44e`, which predates PR #9/#10, so its marketplace files don't match this plan's line numbers. Another session also uses that checkout. Each PR gets its own worktree, under the existing `.agent-worktrees/Axcode/` convention:
  ```bash
  cd <your Lunos checkout> && git fetch origin
  git worktree add ../.agent-worktrees/Axcode/marketplace-npm-sources -b marketplace-npm-sources origin/dev   # PR A
  git worktree add ../.agent-worktrees/Axcode/marketplace-cli-fixes  -b marketplace-cli-fixes  origin/dev   # PR B
  cd ../.agent-worktrees/Axcode/<branch> && bun install
  ```
  Every path and command in a task is relative to that task's worktree root.
- Scratch files: `export SCRATCH=~/lunos-marketplace-fix && mkdir -p $SCRATCH`. Run this in every new shell.
- Trunk is `dev`. There is no `main` branch. Branch from `origin/dev` and never merge `lunos-web/main`.
- PR A takes effect **the moment it merges**, for every user including those on v1.18.37, because `marketplace add AxsionDev/Lunos` reads `marketplace.json` from the default branch `dev`. It does not wait for a release, so do PR A first.
- No DCO sign-off is used on recent commits, so plain `git commit`.
- Merge upstream, never rebase.
- Shared checkout: another session commits in this working tree. **Never `git add -A` / `git add .`.** Stage explicit paths, and re-check `git branch --show-current` before every commit or push.
- Real test command: `bun turbo test --continue` from the repo root. The known baseline is **16 failures** (9 app + 7 opencode). Only a _new_ failure counts.
- Before pushing, run `bunx prettier --write` on every touched `.md`/`.mdx`/`.json`. The `chore: generate` job otherwise pushes formatting fixes to `dev` and rejects your push.
- Fork CI does not run (it needs Blacksmith runners). Local test runs are the gate.
- Manifests carry variable **names**, never values. Nothing may write a manifest string into config without passing `marketplace/guard.ts`.
- Two PRs:
  - **PR A** `marketplace-npm-sources` = Task 1 (data only)
  - **PR B** `marketplace-cli-fixes` = Tasks 2–5 (client code)

## Review Focus

1. **The npm package really is the same project.** An npm name that matches the entry name can belong to a different author: 4 of 30 did. The expected behaviour is that only packages whose `repository.url` or `maintainers` match the manifest's repo get switched. Task 1 carries the verified table; its E2E step installs each one.
2. **A remote MCP entry declaring a hyphenated header (`X-Api-Key`).** The user should be able to `export` the named variable and have the header sent. Covered in Task 2 (unit test plus a manual `debug config` check).
3. **A manifest carrying only MCP servers, skills or hooks.** `list`/`add`/`update` should not say "0 plugin(s)". Covered in Task 3.
4. **Installing a scoped plugin by its bare name** (`marketplace install @openspoon/subtask2`). It should resolve, not be read as marketplace `@openspoon`. Covered in Task 4.
5. **An expected refusal** (unsupported hook event, ambiguous name, duplicate entry). It should print a plain message and exit 1, not the "Unexpected error" crash banner. Covered in Task 5.

## Findings → Tasks

| #   | Finding                                                                                              | Task                                 |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| F1  | All 36 community plugins are `github`-sourced, and every one tried failed to install                 | Task 1                               |
| F2  | `X-Api-Key` header → `{env:X-Api-Key}`, which no shell can export, so the header is always empty     | Task 2                               |
| F3  | `marketplace list/add/update` count only plugins                                                     | Task 3                               |
| F4  | (found while planning) scoped entry names like `@openspoon/subtask2` can't be installed by bare name | Task 4                               |
| F5  | Expected validation refusals print "Unexpected error"                                                | Task 5                               |
| F6  | TUI Discover not exercised end to end; the release predates PR #10                                   | Task 6                               |
| —   | Installs always go to global config; Claude-format manifests rejected; `mcp add` shares the banner   | **Owner decisions**, see end of plan |

---

### Task 1: Switch the community marketplace to verified npm sources (PR A)

**Files:**

- Modify: `marketplace.json` (repo root: 36 `plugins[]` entries, `version`)
- Test: `packages/core/test/marketplace.test.ts:34-42`. The existing seed-manifest test currently **asserts every plugin is `github`**, which encodes the bug. Invert it.
- Create (not committed): `$SCRATCH/verify-plugins.sh`

**Interfaces:**

- Consumes: `Marketplace.decode`, `seedPath` (already defined at top of the core test file)
- Produces: a `marketplace.json` whose every `plugins[].source.type === "npm"`

**Verified mapping.** npm `repository.url` or `maintainers` was checked against the manifest's repo on 2026-09-24.

Switch to `{ "type": "npm", "package": <pkg> }` (26):

| entry name                       | npm package                          |
| -------------------------------- | ------------------------------------ |
| opencode-helicone-session        | opencode-helicone-session            |
| opencode-openai-codex-auth       | opencode-openai-codex-auth           |
| opencode-gemini-auth             | opencode-gemini-auth                 |
| opencode-antigravity-auth        | opencode-antigravity-auth            |
| opencode-devcontainers           | opencode-devcontainers               |
| opencode-google-antigravity-auth | opencode-google-antigravity-auth     |
| opencode-dynamic-context-pruning | @tarquinen/opencode-dcp              |
| opencode-vibeguard               | opencode-vibeguard                   |
| opencode-websearch-cited         | opencode-websearch-cited             |
| opencode-pty                     | opencode-pty                         |
| opencode-wakatime                | opencode-wakatime                    |
| opencode-md-table-formatter      | @franlol/opencode-md-table-formatter |
| opencode-morph-plugin            | @morphllm/opencode-morph-plugin      |
| oh-my-opencode                   | oh-my-opencode                       |
| opencode-notifier                | @mohak34/opencode-notifier           |
| opencode-zellij-namer            | opencode-zellij-namer                |
| opencode-skillful                | @zenobius/opencode-skillful          |
| opencode-supermemory             | opencode-supermemory                 |
| @openspoon/subtask2              | @spoons-and-mirrors/subtask2         |
| opencode-scheduler               | opencode-scheduler                   |
| opencode-conductor               | opencode-conductor-plugin            |
| micode                           | micode                               |
| octto                            | octto                                |
| opencode-sentry-monitor          | opencode-sentry-monitor              |
| opencode-jfrog-plugin            | @jfrog/opencode-jfrog-plugin         |
| opencode-goal-plugin             | opencode-goal-plugin                 |

Remove (10). None of these can install today, so removing them loses nothing that works:

- **Not on npm:** opencode-type-inject, opencode-morph-fast-apply, opencode-notificator, opencode-workspace, opencode-firecrawl, opencode-tavily
- **npm name owned by a different author (supply-chain hazard; never switch):**
  - opencode-shell-strategy (npm pkg by bendzgerona, repo is JRedeker)
  - opencode-worktree (arturosdg vs kdcokenny)
  - opencode-background-agents (frankqing vs kdcokenny)
  - opencode-notify (mattietk vs kdcokenny)

> If you'd rather keep the 10 listed, leave them as `github` and delete Step 1's test instead. The trade-off is that `lunos marketplace install` on them keeps failing. That is the one owner call inside this task.

- [ ] **Step 1: Write the failing test.** In `packages/core/test/marketplace.test.ts`, replace the existing test `"decodes the seed community manifest at the repo root"` (lines 34–42, including its `expect(plugin.source.type).toBe("github")` loop) with:

```ts
// `github` plugin sources install through npm's git-dep path, which npm 12 disables by default
// (allow-git=none) and which Arborist cannot prepare for repos with a build step or
// `workspace:*` deps. This manifest is what `lunos marketplace add AxsionDev/Lunos` serves, so
// every plugin in it must install from the npm registry.
test("decodes the seed community manifest and sources every plugin from npm", () => {
  const manifest = Marketplace.decode(JSON.parse(readFileSync(seedPath, "utf8")))
  expect(manifest.name).toBe("lunos-community")
  expect(manifest.plugins.length).toBeGreaterThan(0)
  const notNpm = manifest.plugins.filter((plugin) => plugin.source.type !== "npm").map((plugin) => plugin.name)
  expect(notNpm).toEqual([])
})
```

- [ ] **Step 2: Run it and confirm it fails.**
      Run: `cd packages/core && bun test test/marketplace.test.ts`
      Expected: FAIL. The received array lists all 36 entry names.

- [ ] **Step 3: Rewrite the manifest.** Save as `$SCRATCH/switch-sources.py` and run it from the repo root. It edits the text in place so the file's inline `source` formatting is kept, then re-parses to prove the result is valid.

```python
import json, re, sys

NPM = {
    "opencode-helicone-session": "opencode-helicone-session",
    "opencode-openai-codex-auth": "opencode-openai-codex-auth",
    "opencode-gemini-auth": "opencode-gemini-auth",
    "opencode-antigravity-auth": "opencode-antigravity-auth",
    "opencode-devcontainers": "opencode-devcontainers",
    "opencode-google-antigravity-auth": "opencode-google-antigravity-auth",
    "opencode-dynamic-context-pruning": "@tarquinen/opencode-dcp",
    "opencode-vibeguard": "opencode-vibeguard",
    "opencode-websearch-cited": "opencode-websearch-cited",
    "opencode-pty": "opencode-pty",
    "opencode-wakatime": "opencode-wakatime",
    "opencode-md-table-formatter": "@franlol/opencode-md-table-formatter",
    "opencode-morph-plugin": "@morphllm/opencode-morph-plugin",
    "oh-my-opencode": "oh-my-opencode",
    "opencode-notifier": "@mohak34/opencode-notifier",
    "opencode-zellij-namer": "opencode-zellij-namer",
    "opencode-skillful": "@zenobius/opencode-skillful",
    "opencode-supermemory": "opencode-supermemory",
    "@openspoon/subtask2": "@spoons-and-mirrors/subtask2",
    "opencode-scheduler": "opencode-scheduler",
    "opencode-conductor": "opencode-conductor-plugin",
    "micode": "micode",
    "octto": "octto",
    "opencode-sentry-monitor": "opencode-sentry-monitor",
    "opencode-jfrog-plugin": "@jfrog/opencode-jfrog-plugin",
    "opencode-goal-plugin": "opencode-goal-plugin",
}
REMOVE = {
    "opencode-type-inject", "opencode-morph-fast-apply", "opencode-notificator", "opencode-workspace",
    "opencode-firecrawl", "opencode-tavily", "opencode-shell-strategy", "opencode-worktree",
    "opencode-background-agents", "opencode-notify",
}

text = open("marketplace.json").read()
names = [p["name"] for p in json.loads(text)["plugins"]]
missing = set(names) - set(NPM) - REMOVE
assert not missing, f"unmapped entries: {missing}"

# Each plugin is a block: `    {` / name / source / description / `    },`
block = re.compile(r'    \{\n      "name": "(?P<name>[^"]+)",\n(?P<body>(?:      .*\n)+?)    \},?\n')

def edit(m):
    name = m.group("name")
    if name in REMOVE:
        return ""
    body = re.sub(r'"source": \{[^}]*\}', f'"source": {{ "type": "npm", "package": "{NPM[name]}" }}', m.group("body"))
    return f'    {{\n      "name": "{name}",\n{body}    }},\n'

plugins_start = text.index('  "plugins": [\n') + len('  "plugins": [\n')
plugins_end = text.index("  ],\n", plugins_start)
section = block.sub(edit, text[plugins_start:plugins_end]).rstrip(",\n") + "\n"
text = text[:plugins_start] + section + text[plugins_end:]
text = text.replace('"version": "1.0.0"', '"version": "1.1.0"', 1)

data = json.loads(text)  # proves the result is valid JSON
assert len(data["plugins"]) == 26, len(data["plugins"])
assert all(p["source"]["type"] == "npm" for p in data["plugins"])
open("marketplace.json", "w").write(text)
print("ok:", len(data["plugins"]), "plugins,", len(data.get("mcp", [])), "mcp")
```

Run: `python3 $SCRATCH/switch-sources.py && bunx prettier --write marketplace.json && git diff --stat marketplace.json`
Expected: `ok: 26 plugins, 7 mcp`, and one file changed.

- [ ] **Step 4: Run the tests and confirm they pass.**
      Run: `cd packages/core && bun test test/marketplace.test.ts`
      Expected: all pass (10 tests; the count is unchanged because a test was replaced, not added).

- [ ] **Step 5: Real-install verification.** This is the check that CI can't do. Save as `$SCRATCH/verify-plugins.sh`:

```bash
#!/bin/bash
# Installs every plugin from the working-tree marketplace.json into a throwaway HOME.
set -u
REPO=$(git rev-parse --show-toplevel)
SB=$(mktemp -d)
mkdir -p "$SB/home" "$SB/proj" && git -C "$SB/proj" init -q
run() {
  HOME="$SB/home" XDG_CONFIG_HOME="$SB/home/.config" XDG_CACHE_HOME="$SB/home/.cache" \
  XDG_DATA_HOME="$SB/home/.local/share" XDG_STATE_HOME="$SB/home/.local/state" \
  bash -c "cd '$SB/proj' && bun run '$REPO/packages/opencode/src/index.ts' $*"
}
run marketplace add "$REPO/marketplace.json" >/dev/null 2>&1
pass=0; fail=0
for name in $(python3 -c "import json;print('\n'.join(p['name'] for p in json.load(open('$REPO/marketplace.json'))['plugins']))"); do
  if run marketplace install "lunos-community/$name" --kind plugin --yes 2>&1 | tr '\r' '\n' | grep -q "Installed"; then
    echo "PASS $name"; pass=$((pass+1))
  else
    echo "FAIL $name"; fail=$((fail+1))
  fi
done
echo "passed=$pass failed=$fail sandbox=$SB"
```

Run: `bash $SCRATCH/verify-plugins.sh | tee $SCRATCH/verify-plugins.log`. It takes about 10–15 minutes.
Expected: `failed=0`. The qualified `lunos-community/<name>` form is used on purpose so `@openspoon/subtask2` works before Task 4 lands. If an entry fails, run it by hand with `--print-logs`. If the package itself is broken on npm, remove that entry too and note it in the PR body.

- [ ] **Step 6: Commit and open PR A.**

```bash
git add marketplace.json packages/core/test/marketplace.test.ts
git commit -m "fix(marketplace): source community plugins from npm, drop 10 uninstallable entries

github sources fail under npm 12 (allow-git=none) and Arborist git-dep prep.
26 entries switched to npm packages verified against the repo owner; 10 removed
(6 not on npm, 4 whose npm name belongs to a different author)."
```

Put the 26/10 table and the `verify-plugins.log` summary in the PR body.

---

### Task 2: Map header names to exportable env-var names (PR B)

**Files:**

- Modify: `packages/opencode/src/marketplace/guard.ts:28-45` (`references`, `envReferences`, `headerReferences`; add `headerEnvName`)
- Modify: `packages/opencode/src/marketplace/install.ts:96-105` (`planMcp`: `required` and `details`)
- Modify: `packages/web/src/content/docs/mcp-servers.mdx:82` (the Discover paragraph)
- Test: `packages/opencode/test/marketplace/install.test.ts`, `packages/opencode/test/mcp/discover.test.ts`

**Interfaces:**

- Produces: `export function headerEnvName(name: string): string`, where `"X-Api-Key"` → `"X_API_KEY"`. Names that are already exportable, like `EXAMPLE_API_KEY`, are unchanged.
- `headerReferences(entryName, names)` still returns `Record<headerName, "{env:VAR}">`. The keys are unchanged; only the `VAR` changes.

- [ ] **Step 1: Write the failing tests.** Add to `packages/opencode/test/mcp/discover.test.ts`, next to `"turns a remote entry into a remote config with {env:} headers"`:

```ts
test("reads a hyphenated header from an exportable env var", () => {
  // A shell cannot `export X-Api-Key=...`, so `{env:X-Api-Key}` could only ever resolve to "".
  const config = mcpConfigFromEntry({
    name: "api",
    type: "remote",
    url: "https://example.test/mcp",
    headers: ["X-Api-Key", "Authorization"],
  } as any)
  expect((config as any).headers).toEqual({
    "X-Api-Key": "{env:X_API_KEY}",
    Authorization: "{env:AUTHORIZATION}",
  })
})
```

Add to `packages/opencode/test/marketplace/install.test.ts`:

```ts
describe("planInstall: remote MCP headers", () => {
  test("names the env var each header reads from, and warns on that var, not the header", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    const entry = new Marketplace.McpRemoteEntry({
      name: "api",
      type: "remote",
      url: "https://example.test/mcp",
      headers: ["X-Api-Key"],
    })
    const plan = await planInstall({ kind: "mcp", name: "api", marketplace: "mp", entry }, file, offline)
    expect(plan.details).toContain("header X-Api-Key <- $X_API_KEY")
    expect(plan.warnings).toEqual(["X_API_KEY is not set in your environment; the reference is written anyway"])
    await plan.apply()
    expect((await readConfig(file)).mcp.api.headers).toEqual({ "X-Api-Key": "{env:X_API_KEY}" })
  })
})
```

- [ ] **Step 2: Run them and confirm they fail.**
      Run: `cd packages/opencode && bun test test/mcp/discover.test.ts test/marketplace/install.test.ts`
      Expected: FAIL. `{env:X-Api-Key}` is received, and the preview line is missing.

- [ ] **Step 3: Implement in `guard.ts`.** Replace `references`, `envReferences` and `headerReferences` with:

```ts
// The manifest carries variable NAMES; config wants name -> value. We write `{env:NAME}`, the
// substitution syntax config already supports, so the generated config holds no secret and stays
// safe to commit -- which it would not be had we prompted for values and written them literally.
function references(
  entryName: string,
  names: readonly string[] | undefined,
  pattern: RegExp,
  variable: (name: string) => string,
) {
  if (!names?.length) return undefined
  for (const name of names) {
    if (!pattern.test(name)) {
      throw new Error(`Marketplace entry "${entryName}" declares an invalid environment/header name: "${name}"`)
    }
  }
  return Object.fromEntries(names.map((name) => [name, `{env:${variable(name)}}`]))
}

export function envReferences(entryName: string, names: readonly string[] | undefined) {
  return references(entryName, names, ENV_NAME, (name) => name)
}

// A header name is not always an exportable variable name: no shell can `export X-Api-Key=...`, so
// `{env:X-Api-Key}` would always resolve to "". The header keeps its name; the variable it reads
// is upper-cased with `-` -> `_` (X-Api-Key -> X_API_KEY). HEADER_NAME has already limited the
// input to [A-Za-z0-9_-], so the result can't carry a brace or a second substitution.
export function headerEnvName(name: string) {
  return name.toUpperCase().replaceAll("-", "_")
}

export function headerReferences(entryName: string, names: readonly string[] | undefined) {
  return references(entryName, names, HEADER_NAME, headerEnvName)
}
```

- [ ] **Step 4: Implement in `install.ts` `planMcp`.** Change the import to `import { envReferences, headerEnvName, rejectSubstitution, requireHttpUrl } from "./guard"`, then replace the `required` line and the `details` field:

```ts
const headers = config.type === "remote" ? Object.keys(config.headers ?? {}) : []
const required = config.type === "local" ? Object.keys(config.environment ?? {}) : headers.map(headerEnvName)
return {
  kind: "mcp",
  name: item.name,
  marketplace: item.marketplace,
  configPath,
  details: [
    config.type === "local" ? `runs: ${config.command.join(" ")}` : `connects to: ${config.url}`,
    ...headers.map((header) => `header ${header} <- $${headerEnvName(header)}`),
  ],
  warnings: unsetVariables(required),
  apply: () => addMcpToConfig(item.name, config, configPath).then(() => {}),
}
```

- [ ] **Step 5: Update the docs.** In `packages/web/src/content/docs/mcp-servers.mdx`, replace the paragraph starting "A marketplace entry only declares the _names_" with:

```mdx
A marketplace entry only declares the _names_ of the environment variables or headers a server needs. Lunos writes them as `{env:NAME}` references, so the generated config holds no secrets. A header is read from the variable named after it, upper-cased with `-` replaced by `_`: the `X-Api-Key` header reads `$X_API_KEY`. The install preview shows each mapping. Export the variable before starting Lunos.
```

- [ ] **Step 6: Run the tests and confirm they pass.**
      Run: `cd packages/opencode && bun test test/mcp/ test/marketplace/`
      Expected: PASS. That includes the existing `{file:}` positive-control tests in `discover.test.ts`, which build their own objects and must stay green.

- [ ] **Step 7: Manual check.** With a sandbox HOME (as in Task 1's script), add a local manifest containing `{"name":"remote-demo","type":"remote","url":"https://example.com/mcp","headers":["X-Api-Key"]}`, then:
  - `marketplace install remote-demo --yes`
  - `X_API_KEY=abc <run> debug config`

  Expected: `mcp.remote-demo.headers` is `{ "X-Api-Key": "abc" }`. Before this fix it was `""`.

- [ ] **Step 8: Commit** (in the `marketplace-cli-fixes` worktree).

```bash
bunx prettier --write packages/web/src/content/docs/mcp-servers.mdx
git add packages/opencode/src/marketplace/guard.ts packages/opencode/src/marketplace/install.ts \
  packages/opencode/test/mcp/discover.test.ts packages/opencode/test/marketplace/install.test.ts \
  packages/web/src/content/docs/mcp-servers.mdx
git commit -m "fix(marketplace): read header refs from exportable env var names (X-Api-Key -> X_API_KEY)"
```

---

### Task 3: Count every content kind in `marketplace list` / `add` / `update` (PR B)

**Files:**

- Modify: `packages/opencode/src/marketplace/content.ts` (add `describeContents`)
- Modify: `packages/opencode/src/cli/cmd/marketplace.ts:92,160-178,212,303-308` (`MarketplaceListEntry.plugins` → `contents`, plus three message strings)
- Test: `packages/opencode/test/cli/marketplace.test.ts:198,259,287,288,338` (expectations), plus one new test

**Interfaces:**

- Produces: `export function describeContents(manifest: Marketplace.Manifest): string`. It returns e.g. `"2 plugin(s), 1 MCP server(s)"`, or `"empty"`.
- `MarketplaceListEntry` loses `plugins?: number` and gains `contents?: string`. Before changing it, run `git grep -n "\.plugins\b" packages/tui/src packages/opencode/src/cli`. The only consumer at `2ea811741e` is the `list` handler.

- [ ] **Step 1: Write the failing test.** Add to `packages/opencode/test/cli/marketplace.test.ts`, inside the `describe` that holds `"shows plugin count for a resolvable marketplace"`, reusing that test's setup helpers:

```ts
test("counts MCP servers, skills and hooks, not just plugins", async () => {
  await using tmp = await tmpdir()
  const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
  await fs.mkdir(path.dirname(cfgFile), { recursive: true })
  await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))
  const mcpOnly = {
    name: "mcp-only",
    owner: { name: "x" },
    plugins: [],
    mcp: [{ name: "a", type: "remote", url: "https://example.test/mcp" }],
    hooks: [{ name: "h", event: "session.idle", command: ["true"] }],
  }

  const entries = await listMarketplaces(
    ctx(tmp.path),
    listDeps(path.join(tmp.path, "global"), {
      fetchText: async (url) =>
        url.includes("api.github.com") ? JSON.stringify({ default_branch: "dev" }) : JSON.stringify(mcpOnly),
      readText: async () => "",
      stat: async () => undefined,
    }),
  )

  expect(entries[0].contents).toBe("1 hook(s), 1 MCP server(s)")
})
```

- [ ] **Step 2: Run it and confirm it fails.**
      Run: `cd packages/opencode && bun test test/cli/marketplace.test.ts -t "counts MCP servers"`
      Expected: FAIL. `contents` is `undefined`.

- [ ] **Step 3: Implement `describeContents`.** Append to `packages/opencode/src/marketplace/content.ts`:

```ts
const COUNT_LABEL: Record<Marketplace.Kind, string> = {
  plugin: "plugin(s)",
  skill: "skill source(s)",
  hook: "hook(s)",
  mcp: "MCP server(s)",
}

// One summary for every surface that describes a whole marketplace (`list`, `add`, `update`), so an
// MCP-only marketplace isn't reported as "0 plugin(s)". Order follows Marketplace.KINDS.
export function describeContents(manifest: Marketplace.Manifest) {
  const all = rows(manifest)
  const parts = Marketplace.KINDS.map((kind) => [kind, all.filter((row) => row.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${COUNT_LABEL[kind]}`)
  return parts.length ? parts.join(", ") : "empty"
}
```

`content.ts` imports `Marketplace` as a type only. Change that line to `import { Marketplace } from "@opencode-ai/core/marketplace"` so `Marketplace.KINDS` is available at runtime.

- [ ] **Step 4: Use it in `cli/cmd/marketplace.ts`.** Add `import { describeContents } from "../../marketplace/content"`, then:
  - line 92: ``resolve.stop(`Validated "${manifest.item.name}" (${describeContents(manifest.item)})`)``
  - `MarketplaceListEntry`: replace `plugins?: number` with `contents?: string`
  - `listMarketplaces`: replace `plugins: entry.manifest.plugins.length,` with `contents: describeContents(entry.manifest),`
  - line 212: ``spin.stop(`Refreshed "${result.manifest.name}" (${describeContents(result.manifest)})`)``
  - lines 306–307: replace `${entry.plugins} plugin(s)` with `${entry.contents}` in both branches

- [ ] **Step 5: Update the existing expectations.** In `packages/opencode/test/cli/marketplace.test.ts`, lines 198, 259, 287, 288 and 338: replace `plugins: 2` with `contents: "2 plugin(s)"`.

- [ ] **Step 6: Run the tests and confirm they pass.**
      Run: `cd packages/opencode && bun test test/cli/marketplace.test.ts test/cli/marketplace-content.test.ts test/cli/tui/marketplace-discover.test.ts`
      Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/opencode/src/marketplace/content.ts packages/opencode/src/cli/cmd/marketplace.ts \
  packages/opencode/test/cli/marketplace.test.ts
git commit -m "fix(marketplace): list/add/update count every content kind, not only plugins"
```

---

### Task 4: Resolve scoped entry names by their bare name (PR B)

**Files:**

- Modify: `packages/opencode/src/marketplace/resolve.ts` (whole file, 15 lines)
- Test: `packages/opencode/test/marketplace/resolve.test.ts`

**Interfaces:**

- Unchanged signature: `resolveByName<T extends { name: string; marketplace: string }>(entries: readonly T[], name: string): T[]`

Today `resolveByName(entries, "@openspoon/subtask2")` splits on the first `/`. It looks for marketplace `@openspoon` and finds nothing, so `lunos marketplace install @openspoon/subtask2` reports "No marketplace entry named …".

- [ ] **Step 1: Write the failing test.** Add to `packages/opencode/test/marketplace/resolve.test.ts`:

```ts
test("a scoped entry name resolves by its bare name, not as <marketplace>/<name>", () => {
  const entries = [{ name: "@openspoon/subtask2", marketplace: "lunos-community" }]
  expect(resolveByName(entries, "@openspoon/subtask2")).toEqual(entries)
  expect(resolveByName(entries, "lunos-community/@openspoon/subtask2")).toEqual(entries)
})
```

- [ ] **Step 2: Run it and confirm it fails.**
      Run: `cd packages/opencode && bun test test/marketplace/resolve.test.ts`
      Expected: FAIL on the first `expect`, which receives `[]`.

- [ ] **Step 3: Implement.** Replace the body of `resolveByName` in `resolve.ts`:

```ts
export function resolveByName<T extends { name: string; marketplace: string }>(
  entries: readonly T[],
  name: string,
): T[] {
  // An exact name wins first: npm-scoped plugin names (`@scope/pkg`) contain a slash and would
  // otherwise be misread as `<marketplace>/<name>`.
  const exact = entries.filter((entry) => entry.name === name)
  if (exact.length) return exact
  const slash = name.indexOf("/")
  if (slash > 0) {
    const marketplace = name.slice(0, slash)
    const bare = name.slice(slash + 1)
    return entries.filter((entry) => entry.marketplace === marketplace && entry.name === bare)
  }
  return []
}
```

Keep the file's existing top comment.

- [ ] **Step 4: Run the tests and confirm they pass.**
      Run: `cd packages/opencode && bun test test/marketplace/resolve.test.ts test/cli/mcp-add-marketplace.test.ts test/cli/marketplace-content.test.ts`
      Expected: PASS. The ambiguity test (`mp-a/filesystem`, `mp-b/filesystem`) must still pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/opencode/src/marketplace/resolve.ts packages/opencode/test/marketplace/resolve.test.ts
git commit -m "fix(marketplace): resolve scoped entry names (@scope/pkg) by bare name"
```

---

### Task 5: Report expected install refusals without the "Unexpected error" banner (PR B)

**Files:**

- Modify: `packages/opencode/src/cli/cmd/marketplace-content.ts` (`MarketplaceInstallCommand.handler`, imports)
- Test: `packages/opencode/test/cli/marketplace-content.test.ts` (inside `describe("opencode marketplace install (subprocess)")`)

**Interfaces:**

- Consumes: `fail` from `../effect-cmd` (emits `CliError`, which `cli/error.ts` `FormatError` prints as a plain message with exit 1), and `errorMessage` from `../../util/error`

Scope: `lunos marketplace install` only. `lunos mcp add <name>` has the same banner, but it comes from that whole command's upstream error style (see the Owner decisions section).

- [ ] **Step 1: Write the failing test.** Add to the install `describe` in `marketplace-content.test.ts`:

```ts
cliIt.concurrent(
  "reports a refused install as a plain error, without the Unexpected error banner",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      yield* setup(home, opencode, { ...allKinds, hooks: [{ ...allKinds.hooks[0], event: "PostToolUse" }] })
      const result = yield* opencode.spawn(["marketplace", "install", "format-on-edit", "--yes"])
      opencode.expectExit(result, 1, "marketplace install")
      expect(result.stderr).toContain('targets event "PostToolUse"')
      expect(result.stderr).not.toContain("Unexpected error")
    }),
  60_000,
)
```

- [ ] **Step 2: Run it and confirm it fails.**
      Run: `cd packages/opencode && bun test test/cli/marketplace-content.test.ts -t "plain error"`
      Expected: FAIL. stderr contains `Unexpected error`.

- [ ] **Step 3: Implement.** In `marketplace-content.ts`, add the imports `import { effectCmd, fail } from "../effect-cmd"` (merge with the existing `effectCmd` import) and `import { errorMessage } from "../../util/error"`. Then replace the handler body of `MarketplaceInstallCommand` from `const item = yield* …` to the end with:

```ts
// Refusals from pickOne/planInstall (ambiguous name, unsupported hook event, duplicate entry)
// are expected outcomes, so they surface as a CliError: plain message, exit 1, no "Unexpected
// error" banner. A cancelled prompt is rethrown to keep its existing path.
const refusal = (error: unknown) => {
  if (error instanceof UI.CancelledError) throw error
  return errorMessage(error)
}

const picked =
  yield *
  Effect.promise(() =>
    listContent(marketplaceCtx, kind)
      .then(({ items }) => ({ item: pickOne(items, name) }))
      .catch((error: unknown) => ({ error: refusal(error) })),
  )
if ("error" in picked) return yield * fail(picked.error)
const item = picked.item
if (!item) {
  UI.error(`No marketplace entry named "${name}"${kind ? ` of kind ${kind}` : ""}. Try: lunos marketplace search`)
  process.exitCode = 1
  return
}

if (item.kind === "plugin") {
  // Plugins keep their own install path, which fetches the package and reads its manifest.
  const ok =
    yield * Effect.promise(() => createPlugTask({ mod: item.spec, global: true, force: false })(marketplaceCtx))
  if (!ok) process.exitCode = 1
  return
}

const failure = yield * Effect.promise(() => confirmAndInstall(item, Boolean(args.yes)).then(() => undefined, refusal))
if (failure !== undefined) return yield * fail(failure)
```

Keep the "No marketplace entry named …" branch exactly as it is today (`UI.error` + `process.exitCode = 1`). Only the thrown refusals change.

- [ ] **Step 4: Run the tests and confirm they pass.**
      Run: `cd packages/opencode && bun test test/cli/marketplace-content.test.ts test/cli/mcp-add-marketplace.test.ts test/cli/error.test.ts`
      Expected: PASS. Check that the existing ambiguity test still finds `mp-a/filesystem` in stderr.

- [ ] **Step 5: Typecheck.**
      Run: `cd packages/opencode && bun run typecheck` (or `bunx tsc --noEmit -p .` if the script is absent)
      Expected: no new errors in `marketplace-content.ts`.

- [ ] **Step 6: Commit and open PR B.**

```bash
git add packages/opencode/src/cli/cmd/marketplace-content.ts packages/opencode/test/cli/marketplace-content.test.ts
git commit -m "fix(marketplace): print install refusals as plain errors, not 'Unexpected error'"
```

Before pushing: `bun turbo test --continue` from the root. Expect exactly the 16 baseline failures and nothing new in `marketplace`, `mcp`, `cli`, or `core`.

---

### Task 6: End-to-end verification and release (after PR A and PR B merge)

**Files:** none changed. Verification and release only.

- [ ] **Step 1: Verify against the live source, as a user sees it.** In a sandbox HOME:
  - `marketplace add AxsionDev/Lunos`
  - `marketplace update lunos-community`, which forces a re-fetch. Otherwise the 24h cache can serve the old 36-plugin manifest.
  - `marketplace list`

  Expected: `lunos-community … 26 plugin(s), 7 MCP server(s)`. Then `marketplace install @openspoon/subtask2 --yes` installs by bare name. Finally, re-run `bash $SCRATCH/verify-plugins.sh` in a fresh worktree of merged `dev`, and expect `failed=0`.

- [ ] **Step 2: Drive the TUI Discover view headlessly.** Use pty + `TIOCSWINSZ` at 120x45, per the TUI-verification memory. In a sandbox HOME with `AxsionDev/Lunos` added, open Discover and check each of the four tabs lists entries. Install one MCP server from the TUI, then confirm `lunos mcp list` shows it `connected`.
      Expected: all four tabs populate, and the TUI install lands in global config like the CLI install does.

- [ ] **Step 3: Cut the next release from `dev`.** Confirm first that it contains `2ea811741e` (PR #10, the `{file:}` fix) and both new PRs: `git merge-base --is-ancestor 2ea811741e origin/dev`. Expect the release pipeline to surface one inherited-infra failure per dispatch. Use a `version=` override if a stale draft release gets in the way.

- [ ] **Step 4: Point the v1.18.37 advisory at the fixed version.** Edit the `[!WARNING]` block in the v1.18.37 GitHub release notes to name the new version as the fix. Whether to deprecate v1.18.37 on npm stays an owner call.

---

## Owner decisions (no code until you choose)

1. **Remove or keep the 10 uninstallable entries** (Task 1). The recommendation is to remove them; keeping them means shipping entries that always fail.
2. **Install scope.** `confirmAndInstall` and the plugin path always write **global** config. The code documents this as intended ("Marketplace installs always write global config"). If you want a `--global`/local switch to match `marketplace add`, that becomes a new task touching `marketplace-content.ts` (`resolveConfigPath(…, true)` and `createPlugTask({ global: true })`).
3. **Claude Code-format marketplaces** (`"source": "./path"`, `.claude-plugin/marketplace.json`). They are rejected by the v1 schema by design (`packages/opencode/specs/marketplace-manifest.md`). Supporting them is a feature, not a fix.
4. **`lunos mcp add` banner.** Every error in that command prints "Unexpected error", which is upstream's style. Fixing it is a wider change than this plan and grows the merge surface with upstream.
