# /state-init

Initialize the agent state management system in the current project.

## Purpose

Creates the `.agent-state/` directory structure with default configuration for tracking sessions, tasks, decisions, and context across agent workflows.

## Usage

```
/state-init
```

## What It Does

1. **Check existing state** - Verify if `.agent-state/` already exists
2. **Create directory structure**:
   ```
   .agent-state/
   ├── config.yaml
   ├── active-session.yaml
   ├── sessions/
   ├── global/
   └── indexes/
   ```
3. **Copy templates** from `~/.claude/agent-state-templates/` or create defaults
4. **Auto-detect project name** from directory name
5. **Report status** with next steps

## Instructions for Claude

When the user runs `/state-init`:

1. Check if `.agent-state/` directory exists in project root
2. If it exists, ask user if they want to reset or abort
3. Create the directory structure:

```bash
mkdir -p .agent-state/sessions
mkdir -p .agent-state/global
mkdir -p .agent-state/indexes
```

4. Create `config.yaml` with defaults:

```yaml
version: "1.0"
schema_version: "2026.01"

project:
  id: "auto" # Will be set on first session
  name: "{detected from directory}"

context:
  max_active_tasks: 10
  compact_after_messages: 25
  summary_trigger_tokens: 8000
  compaction_strategy: "hierarchical"

sessions:
  auto_archive_after_days: 7
  max_active_sessions: 3
  naming_strategy: "timestamp_task"
  auto_resume: true

handoff:
  auto_generate: true
  include_context: true
  max_context_lines: 200

todo_write:
  enabled: true
  sync_mode: "bidirectional"

claude_dir:
  enabled: true
  read_agents: true
  read_docs: true
```

5. Create empty `active-session.yaml`:

```yaml
# No active session
session_id: null
```

6. Create empty index files:

```yaml
# .agent-state/indexes/task-index.yaml
version: "1.0"
tasks: []

# .agent-state/indexes/decision-index.yaml
version: "1.0"
decisions: []
```

7. Report completion:

```
State management initialized in .agent-state/

Structure created:
  .agent-state/
  ├── config.yaml          (configured)
  ├── active-session.yaml  (no active session)
  ├── sessions/            (empty)
  ├── global/              (empty)
  └── indexes/             (initialized)

Next steps:
  /session-start "Your task description"
```

## Output

Confirmation of initialization with directory structure and next steps.
