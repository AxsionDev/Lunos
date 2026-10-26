# How many tools a session gets (MCP servers)

Every tool of every configured MCP server is offered to every session. One server can add about 30. Large models cope; small ones (Ministral, Codestral, a local 8B) start calling tools that don't exist. This was seen while recording XCOD-152.

## Keep a server's tools out where they aren't needed

MCP tools are named `<server>_<tool>`, so one rule drops a whole server. Use the existing `permission` setting; no new configuration is needed.

For one project, in its `opencode.json`:

```json
{ "permission": { "bigserver_*": "deny" } }
```

For one agent, only:

```json
{ "agent": { "explore": { "permission": { "bigserver_*": "deny" } } } }
```

A tool that is denied for everything (`"deny"` with no narrower rule) isn't offered to the model at all, so it takes no room in the prompt. The legacy form `"tools": { "bigserver_*": false }` does the same.

## See how many tools an agent gets

```sh
lunos debug agent build
```

The output has `toolCount`, and a `warning` with the rule above when there are more than 20.

## When the model calls a tool that doesn't exist

The call doesn't fail the turn. The model is told the tool doesn't exist and is given the nearest real ones, then carries on:

> There is no tool named "memory_serch". The closest are: memory_search, memory_remember, grep. Call one of the tools you were given.

Before XCOD-167, it was told "the arguments provided to the tool are invalid", which sent small models back to retry the same made-up name.

## Why not load MCP tools on demand

Loading tools only when the model searches for them would keep every prompt small. But it adds a round trip to every MCP use, and it relies on the model searching well, which is what small models do worst. Per-project and per-agent rules are explicit, need no new configuration, and fit how organisations already lock permissions in managed config. On-demand loading stays an option if tool counts keep growing.
