# /memory-audit - Remember vs Claude-Mem Usage Review

Audit both cross-session memory systems this fleet has used — the `remember` plugin (active) and `claude-mem` (uninstalled 2026-09-10, but its historical data still exists on disk) — and report what's actually being stored, how fresh it is, and whether either is dead weight.

## Arguments: $ARGUMENTS

- No arguments — full report on both systems.
- `remember` — only the `remember` section.
- `claude-mem` — only the `claude-mem` section.
- `--purge-claude-mem` — after reporting, ask for confirmation, then offer to delete `~/.claude-mem/` (irreversible; only do this if the user explicitly confirms in response to the report, not just because this flag was passed).

## Why this command exists

`remember` and `claude-mem` were both installed and running as parallel continuous memory systems on 2026-09-10 (see memory `plugin-audit-2026-09-10.md`). `claude-mem` was disabled, re-enabled, then fully uninstalled the same day after several reversals. This command exists so that decision can be checked against real data on demand instead of re-litigated from memory — run it any time the question "are we still duplicating memory systems / is either one dead" comes up again.

## Instructions for Claude

### 1. Check current plugin state

```bash
claude plugin list 2>&1 | grep -iE "remember|claude-mem"
```

Report enabled/disabled/not-installed for each. As of 2026-09-10, expect `remember` enabled and `claude-mem` absent entirely (uninstalled, not just disabled) — flag it clearly if that's changed.

### 2. `remember` section (skip if `$ARGUMENTS` is `claude-mem`)

`remember` stores state **per-project** in `.remember/` at the project root (`$CLAUDE_PROJECT_DIR/.remember/` — for this repo, `/Users/pminev/Documents/AI/Playground/.remember/`).

```bash
ls -la "$CLAUDE_PROJECT_DIR/.remember/" 2>/dev/null
```

Read and summarize:
- `now.md` — the current in-progress buffer (should be small; if it's grown large, compaction may be overdue)
- `today-*.md` files — one per day worked; count them and note the date range they span
- `recent.md` — rolling 7-day window
- `archive.md` / any `archive-YYYY-MM-DD*.md` / `recent-YYYY-MM-DD*.md` rotated slices — older history, not injected automatically
- `core-memories.md` if present — key moments explicitly promoted out of the daily churn

Report: total size on disk (`du -sh`), number of days with activity, date of last write, and whether rotation is happening (i.e. `archive.md` growing / rotated slices appearing) rather than `now.md`/`today-*.md` growing unbounded.

If this command is run from a different project than Playground, note that `remember`'s data is per-project — this section only reflects the current working directory, not the whole fleet. Say so explicitly rather than implying it's global.

### 3. `claude-mem` section (skip if `$ARGUMENTS` is `remember`)

`claude-mem` stored everything **globally**, across every project, in one SQLite DB at `~/.claude-mem/claude-mem.db`, plus daily logs at `~/.claude-mem/logs/claude-mem-YYYY-MM-DD.log`.

```bash
ls -la ~/.claude-mem/ 2>/dev/null
du -sh ~/.claude-mem/claude-mem.db 2>/dev/null
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;" 2>/dev/null
sqlite3 ~/.claude-mem/claude-mem.db "SELECT MIN(datetime(created_at)), MAX(datetime(created_at)) FROM observations;" 2>/dev/null
ls ~/.claude-mem/logs/ 2>/dev/null | tail -5
```

If the exact column name for the timestamp differs from `created_at`, first run `sqlite3 ~/.claude-mem/claude-mem.db ".schema observations"` to find the real column before the MIN/MAX query, rather than guessing repeatedly.

Report:
- DB size and total observation count
- Date range covered (first → last observation)
- Whether the most recent log file's date is **today** — if it is, and `claude plugin list` showed `claude-mem` absent, that's a contradiction worth surfacing (something is still writing to it, e.g. another machine, a stale background process, or the uninstall didn't fully stop an already-running MCP server this session).
- If the DB/logs directory doesn't exist at all, say plainly that all `claude-mem` history is gone, not just the plugin.

Do **not** delete or modify `~/.claude-mem/` in this step, even if it looks like historical clutter — that's what `--purge-claude-mem` and explicit user confirmation are for.

### 4. Verdict

Compare the two:
- Is `remember` actively growing (recent `today-*.md` entries, `now.md` updated recently)?
- Is `claude-mem`'s data frozen as of the uninstall date, or still growing (see the contradiction check above)?
- Restate plainly: `remember` is the one live system; `claude-mem`'s DB is historical-only unless the freshness check says otherwise.

If `--purge-claude-mem` was passed and the data does look genuinely frozen/historical, offer (don't just do) to delete `~/.claude-mem/` to reclaim disk space, making clear this destroys all historical observations permanently with no backup unless one is made first.

## Output

A short structured report:

```
## Memory System Audit — {date}

### Plugin state
remember:    {enabled/disabled/not installed}
claude-mem:  {enabled/disabled/not installed}

### remember (.remember/, this project only)
Size:        {size}
Days logged: {N} ({earliest} → {latest})
Last write:  {timestamp}
Rotation:    {working normally / now.md growing unbounded / etc.}

### claude-mem (~/.claude-mem/, global — historical unless noted)
Size:        {size}
Observations: {count}
Date range:  {earliest} → {latest}
Last log:    {date} {⚠️ contradicts "uninstalled" if today}

### Verdict
{One paragraph: which system is live, which is dead weight, whether the
2026-09-10 uninstall decision still holds, any surfaced contradiction.}
```
