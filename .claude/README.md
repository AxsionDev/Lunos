# Claude Code Agent Framework

This folder contains custom agents, commands, and workflows for AI-assisted software development.

## Initial Setup

When you copy this framework to a new project, complete these steps:

### 1. Fill in Project Startup Guide (Required)

**Option A: Auto-generate (recommended)**
```
/generate-startup
```
This scans your project and fills in the values automatically. Review and adjust as needed.

**Option B: Manual**
Edit `.claude/PROJECT_STARTUP.md` with your project's actual values:

```markdown
## Quick Start

### Frontend
- **Path:** `./your-frontend-folder`
- **Install:** `npm install`
- **Start:** `npm run dev`
- **URL:** http://localhost:3000

### Backend
- **Path:** `./your-api-folder`
- **Install:** `dotnet restore`
- **Start:** `dotnet run`
- **URL:** http://localhost:{backend_port}
```

This prevents agents from scanning your project repeatedly.

### 2. Initialize State Tracking (Optional)

If you want session tracking and context persistence:

```
/state-init
```

This creates the `.agent-state/` directory for tracking sessions, tasks, and decisions.

### 3. Start a Session (Optional)

```
/session-start
```

Begins a tracked work session that can be resumed later.

## Folder Structure

```
.claude/
├── README.md              ← You are here
├── PROJECT_STARTUP.md     ← Fill this in first!
├── agents/                ← Specialized AI agent definitions
├── skills/                ← Reusable procedural logic (source of truth for agents)
├── commands/              ← User-invocable slash commands
├── docs/                  ← Feature documentation
│   └── templates/         ← Document templates
├── stories/               ← User stories (generated)
└── workflows/             ← Workflow guides
```

## Plugins

Marketplace plugin enable/disable state lives in **user-scope** `~/.claude/settings.json`, so it already applies to every project on this machine — there's nothing to copy per-repo. On a **new machine**, install these (all from `claude-plugins-official` unless noted):

```
superpowers, remember, atlassian, csharp-lsp, typescript-lsp, context7, github,
frontend-design, playwright, postman, microsoft-docs, plugin-dev, skill-creator,
commit-commands, pr-review-toolkit, code-review, claude-code-setup,
claude-md-management, chrome-devtools-mcp, agent-sdk-dev, session-report,
explanatory-output-style, circleback
```

`claude plugin install <name>@claude-plugins-official` for each. Everything above was audited for real usage on 2026-09-10 — `code-simplifier`, `feature-dev`, `greptile`, `notion`, `ralph-loop`, `serena`, `learning-output-style`, and `ui-ux-pro-max` are deliberately left disabled (no confirmed invocations, or superseded by another plugin); don't re-enable them without a reason.

**Headroom** (token-compression proxy) is the one exception — it's installed **local scope, this repo only**, not user scope, so it does *not* travel automatically even within this machine, and `scripts/sync-claude-fleet.py` never touches `.claude/settings.local.json` either. To add it to another repo/harness:

```
uv tool install --python 3.13 "headroom-ai[all]"
HEADROOM_BEACON=off headroom init -v claude   # run from the target repo root
```
Then restart Claude Code (hooks/routing don't activate until restart). GitHub: https://github.com/headroomlabs-ai/headroom

⚠️ Before replicating it onto a client-code-adjacent repo, know what it writes to `.claude/settings.local.json`: it points `ANTHROPIC_BASE_URL` at a local proxy (`http://127.0.0.1:8787`) and sets `allowDangerouslySkipPermissions: true` + `initialPermissionMode: "bypassPermissions"`. That's a real permission-bypass config, not just a routing tweak — review it before turning it on somewhere that matters.

## Key Commands

| Command | Purpose |
|---------|---------|
| `/generate-startup` | Scan project and fill PROJECT_STARTUP.md |
| `/feature-lifecycle` | Full 5-phase development cycle |
| `/feature` | Multi-developer parallel implementation |
| `/bug-fix` | Structured bug investigation and fix |
| `/discover` | Generate AI-friendly documentation |
| `/compact` | Compress conversation context |
| `/handoff` | Generate handoff for agent transitions |

## Quick Reference

- **CLAUDE.md** (project root) - Main instructions for Claude Code
- **PROJECT_STARTUP.md** - Your project's start commands (fill this in!)
- **agents/** - Agent definitions that handle specific tasks
- **commands/** - Slash commands you can invoke

## Need Help?

Run `/help` in Claude Code for available commands, or check the workflow guides in `.claude/workflows/`.
