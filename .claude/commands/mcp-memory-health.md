# /mcp-memory-health - Docker `mcp/memory` Knowledge-Graph Health Check

Checks whether the Docker MCP Toolkit's `memory` knowledge-graph server (tools: `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`, `delete_relations`, `open_nodes`, `read_graph`, `search_nodes` — exposed as `mcp__MCP_DOCKER__*`) is actually contributing anything, or just sitting there as dead schema/connection cost.

## Arguments: $ARGUMENTS

None expected. Ignore any passed.

## Background

This is **not** the same thing as `remember`/`claude-mem` (see `/memory-audit` for those) — this is Docker Desktop's separate MCP Toolkit, config at `~/.docker/mcp/`, managed by the `docker mcp` CLI, not `claude plugin`. On 2026-09-10 it was found running but its data volume held zero stored entities, and it was removed from the `default` Docker MCP profile via `docker mcp profile server remove default memory`. This command exists to re-verify that removal actually stuck — profile removal, registry entries, leftover volumes, and already-running sessions can drift out of sync with each other, so "removed once" isn't the same as "gone."

## Instructions for Claude

Run each check and report the result plainly — don't skip a check because a previous one already looked conclusive; they check different layers and can disagree.

### 1. Registry — is it still registered at all?

```bash
grep -A2 "^  memory:" ~/.docker/mcp/registry.yaml 2>/dev/null
```

An entry here just means the server is *known* to Docker MCP Toolkit, not that it's active. If this is empty/absent, the server has been fully de-registered, not just profile-removed — say so, that's a stronger state than what was done on 2026-09-10.

### 2. Active profile — is it enabled for actual use?

```bash
docker mcp profile server ls 2>&1
```

Check whether `memory` appears against the `default` profile (or any other profile in use). As of 2026-09-10 it should be **absent** — flag clearly if it's reappeared (e.g. from a Docker Desktop update resetting the catalog, or someone re-adding it).

### 3. Data volume — does it hold anything real?

```bash
docker volume ls 2>&1 | grep -i memory
docker run --rm -v claude-memory:/data alpine find /data -type f 2>&1
```

If the volume exists, inspect what's actually in it (not just that files exist — cat any small JSON/data files found to check for real entity/relation content vs. just the server's own installed code). An empty or code-only volume after real usage would mean the tool was connected but never actually used to store anything.

### 4. Currently-exposed tool schema — is this session still paying for it right now?

Check whether any of these tool names appear in this session's own available/deferred tool list right now: `mcp__MCP_DOCKER__create_entities`, `mcp__MCP_DOCKER__create_relations`, `mcp__MCP_DOCKER__add_observations`, `mcp__MCP_DOCKER__delete_entities`, `mcp__MCP_DOCKER__delete_observations`, `mcp__MCP_DOCKER__delete_relations`, `mcp__MCP_DOCKER__open_nodes`, `mcp__MCP_DOCKER__read_graph`, `mcp__MCP_DOCKER__search_nodes`.

If they're still present despite step 2 showing `memory` removed from the profile: this means the **already-running MCP_DOCKER gateway** for this session was started before the profile change and hasn't picked it up — the schema cost is still being paid in this exact session, and won't stop until the gateway/session restarts. Say this explicitly; don't just report the profile state and imply the cost is gone if the live tool list contradicts it.

### 5. Real invocation history — was it ever actually called?

Scan local transcripts for real `tool_use` blocks (not raw substring matches — those are inflated by system-reminder tool-name listings, per the same caveat as the `/memory-audit` command and today's plugin audit). Write a small script rather than shell grep for this, e.g.:

```bash
python3 - <<'EOF'
import json, glob

patterns = ("mcp__MCP_DOCKER__create_entities", "mcp__MCP_DOCKER__create_relations",
            "mcp__MCP_DOCKER__add_observations", "mcp__MCP_DOCKER__delete_entities",
            "mcp__MCP_DOCKER__delete_observations", "mcp__MCP_DOCKER__delete_relations",
            "mcp__MCP_DOCKER__open_nodes", "mcp__MCP_DOCKER__read_graph",
            "mcp__MCP_DOCKER__search_nodes")
hits = 0
files_hit = set()
for path in glob.glob("/Users/pminev/.claude/projects/**/*.jsonl", recursive=True):
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            for line in f:
                if '"type":"tool_use"' not in line and '"type": "tool_use"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                msg = obj.get("message", {})
                content = msg.get("content", [])
                if not isinstance(content, list):
                    continue
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") in patterns:
                        hits += 1
                        files_hit.add(path)
    except Exception:
        continue
print(f"Real tool_use invocations: {hits}, across {len(files_hit)} transcript files")
EOF
```

Report the count. Zero real invocations across a large local transcript sample (hundreds of files, per the plugin audit's validated methodology) is strong evidence of non-use, not proof — note the same caveat as before: this only covers local `~/.claude/projects/` history on this machine.

### 6. Verdict

State plainly, in one paragraph:
- Is `memory` registered / profile-active / volume-populated / still schema-live in this session / ever actually invoked — five separate yes/no facts, not blended into one vague "unused."
- Whether the 2026-09-10 removal decision still holds given current evidence.
- If step 4 shows it's still schema-live in this session, say the fix requires restarting the Claude Code session (or the MCP gateway) — removing it from the profile alone doesn't retroactively free the cost for sessions already running.
- Offer (don't do unannounced) cleanup of the leftover `claude-memory` Docker volume (`docker volume rm claude-memory`) if step 3 confirms it's empty/code-only.

## Output

```
## mcp/memory Health Check — {date}

1. Registry:        {registered / not found}
2. Default profile:  {absent (expected) / present ⚠️}
3. Data volume:      {absent / present — {empty|code-only|contains real data: details}}
4. Live in THIS session: {yes ⚠️ restart needed / no}
5. Real invocations found (local transcripts): {N}

### Verdict
{one paragraph, per above}
```
