# Editing and sharing agents

Package an agent once and use it on another machine, or hand it to a colleague: `lunos agent export` writes the agent, the MCP servers it uses and the skills it names into one bundle file, and `lunos agent import` adds it on the other side after showing exactly what it will be allowed to do.

This page covers **editing (XCOD-210), exporting and importing (XCOD-209)**, all unreleased. Running agents on a schedule is separate, later work (XCOD-211).

## Editing

```sh
lunos agent edit reviewer                                    # opens the agent's file in $EDITOR
lunos agent edit reviewer --prompt-file prompt.md --model mistral/mistral-large-latest
lunos agent edit reviewer --permission bash=ask,webfetch=deny --steps 20
lunos agent edit reviewer --skill code-review --mcp github   # may load the skill, may use github's tools
```

In the TUI, `/agents` lists every agent. Enter opens the selected agent's file in `$VISUAL` or `$EDITOR`.

**Every save is checked before it's written:**

- the model must be one that's available here (`provider/model`);
- every permission must name a tool, or an MCP server's tools, that exists here (a wildcard must match at least one);
- every skill the agent names must be installed.

If anything is wrong, every problem is listed and the file isn't touched. In `$EDITOR` you edit a copy, so a save that's refused leaves the agent exactly as it was.

- **What can be edited:** agents defined in markdown files, in your global config or a project's `.opencode/agents/`.
- **What can't:** built-in agents (`lunos agent create` makes your own), agents defined in JSON config (edit them there), and Claude Code files under `.claude/agents/` (import one to get a Lunos copy).
- **Rule order:** a rule set with `--permission`, `--skill` or `--mcp` goes after the agent's existing rules. Rules match last-wins, so the new rule takes effect even after a wildcard such as `"*": "allow"`.

## Exporting

```sh
lunos agent export reviewer                 # writes reviewer.lunos-agent
lunos agent export reviewer -o ~/share/reviewer.lunos-agent
```

The bundle contains:

- **The agent:** description, mode, model, prompt, permissions, step limit, color and model options.
- **The MCP servers it uses:** any server whose tools the agent's permissions name (`github_search` names `github`), plus any you list with `--mcp github,docs`.
- **The skills it names:** any skill the agent's `skill` permission allows by name, plus any you list with `--skill code-review`. Built-in skills aren't bundled.

**A bundle never contains a secret value.** An MCP server's environment variables and headers go in by **name** only (`GITHUB_TOKEN`, `Authorization`), never by value. Export refuses, and names the field, when a secret is somewhere it can't be turned into a name:

- credentials in a server's URL, or a query parameter such as `?api_key=`;
- an OAuth client secret;
- agent options that set a model endpoint or hold a credential (`baseURL`, `apiKey`, `headers`, …);
- a secret value from a server's environment or headers that also appears elsewhere, such as in a command argument, the prompt or a skill file.

Hooks are never exported.

## Importing

```sh
lunos agent import reviewer.lunos-agent --dry-run    # preview only
lunos agent import reviewer.lunos-agent              # preview, then asks
lunos agent import https://example.com/reviewer.lunos-agent --name reviewer-2 --yes
lunos agent import .claude/agents/helper.md          # a Claude Code subagent
```

Before anything is written, import shows:

- the agent's model, its provider and the region it runs in;
- its permissions, after the trust step below;
- the MCP servers it adds, what each one runs or connects to, and which environment variables they need that aren't set on this machine;
- the skills it adds, and every file it will write.

Nothing in the agent runs at import time. `--dry-run` stops after the preview. Answering no at the prompt writes nothing. Without a terminal, import needs `--yes`.

A URL must be `https://`, every redirect too, and the download stops at 20 MB.

The agent goes into your global config (`~/.config/opencode/agents/`), or into the project's `.opencode/` with `--project`.

### What an imported agent may do

- **It asks before bash, edits and subagents.** Whatever the bundle's rules would allow for `bash`, `edit` or `task`, including through wildcards such as `"*": "allow"`, becomes `ask`; what they deny stays denied. Pass `--trust` to keep the bundle's permissions as they are.
- **MCP servers apply to every agent.** A server added by an import starts for every agent and session, not only the imported agent. The preview says so. A server that is already configured here under the same name, with the same command or URL, is kept exactly as it is, credentials included. A different server under that name is refused.
- **Secrets stay out of config.** An MCP server's variables are written as references such as `{env:GITHUB_TOKEN}`, so the config file holds no secret and is safe to commit. Set the variables before using the agent.
- **Nothing is overwritten.** An agent, MCP server or skill that already exists under the same name is refused, built-in agents included (a bundle named `build` or `title` would otherwise replace Lunos's own). Use `--name` to import an agent under another name.
- **Writing is all or nothing.** If any write fails, the files and folders the import created are removed and the config file is restored.

### What import refuses

Import treats a bundle as untrusted input and refuses it when:

- a path would leave the bundle: absolute paths, `..`, backslashes or drive letters;
- it contains symbolic links, more than 500 files, or more than 20 MB unpacked;
- a file isn't listed in its manifest, or doesn't match its checksum;
- it declares hooks;
- it carries a config substitution token (`{env:…}`, `{file:…}`) anywhere: the prompt, the description, an MCP server or a skill file;
- the agent's options would redirect its model or carry a credential;
- it has fields this version of Lunos doesn't know.

**The checksums only detect a damaged file.** Whoever made the bundle also wrote its checksums, so they don't show who made it or that it wasn't changed on purpose. Import bundles only from people and places you trust, and read the preview.

### Claude Code subagents

`lunos agent import helper.md` reads a Claude Code subagent file (`.claude/agents/*.md`) and reports which fields carried over and which didn't:

- **Carried over:** the name, the description, the prompt, `tools` (as permissions: everything else denied) and a `provider/model` model.
- **Not carried over, and listed:** model aliases such as `sonnet`, named colours, and any other Claude Code field.

Lunos also loads `.claude/agents/` from a project directly. Importing makes a Lunos agent of its own that you can export again.

## Organisation policy

- **Residency.** Under a residency policy, an agent whose model runs outside the allowed regions is refused, with the region and the policy in the message. To use it, change its model, or declare the endpoint in `residency.endpoints`.
- **Turning imports off.** `"agent_import": false` in managed config, locked with `"$locked": ["agent_import"]`, stops everyone on the machine importing agents. Each attempt is refused and recorded in the audit log as `policy.override_refused`. See [organisation policy](deployment/self-hosted.md#organisation-policy-settings-developers-cant-change).
- **Permission locks still apply.** A locked `permission` (XCOD-202) holds for imported agents as it does for any other agent.
