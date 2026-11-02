# /session-start

Start a new tracked session for state management.

## Purpose

Creates a new session to track tasks, decisions, and context for a work unit (feature, bugfix, etc.).

## Usage

```
/session-start "Session description"
/session-start "Implementing user authentication"
```

## Arguments

- `$ARGUMENTS` - Description of the work to be done (required)

## What It Does

1. **Generate session ID** - Format: `session-{YYYYMMDD}-{HHMMSS}-{slug}`
2. **Create session directory** under `.agent-state/sessions/`
3. **Initialize session files**:
   - `session.yaml` - Metadata
   - `tasks.yaml` - Empty task registry
   - `decisions.yaml` - Empty decision log
   - `context.yaml` - Initial context
4. **Update active session** pointer
5. **Report session details**

## Instructions for Claude

When the user runs `/session-start "description"`:

1. Verify `.agent-state/` exists (if not, prompt for `/state-init`)

2. Generate session ID:
   - Date: YYYYMMDD format
   - Time: HHMMSS format
   - Slug: lowercase, hyphens, from description (max 30 chars)
   - Example: `session-20260113-143022-user-auth`

3. Create session directory:

```bash
mkdir -p .agent-state/sessions/{session-id}
```

4. Create `session.yaml`:

```yaml
id: "{session-id}"
created_at: "{ISO timestamp}"
updated_at: "{ISO timestamp}"

metadata:
  name: "{description from arguments}"
  description: "{description from arguments}"
  parent_session: null
  initiated_by_agent: "state-manager"
  initiated_by: "user"

status: "active"
phase: "discovery"

context_bounds:
  start_message: 1
  current_message: 1
  last_compaction: 0
  token_estimate: 0

active_references:
  files: []
  docs: []
  urls: []

agent_chain:
  - agent: "user"
    started_at: "{ISO timestamp}"
    ended_at: null
    handoff_reason: null
    tasks_completed: []

metrics:
  tasks_completed: 0
  tasks_total: 0
  decisions_made: 0
  files_modified: 0
  compactions_performed: 0
  handoffs_performed: 0

tags: []
labels:
  priority: "normal"
  type: "feature"
```

5. Create `tasks.yaml`:

```yaml
version: "1.0"
session_id: "{session-id}"
updated_at: "{ISO timestamp}"
tasks: []
stats:
  total: 0
  by_status:
    pending: 0
    in_progress: 0
    blocked: 0
    completed: 0
    cancelled: 0
  by_agent: {}
next_task_id: 1
```

6. Create `decisions.yaml`:

```yaml
version: "1.0"
session_id: "{session-id}"
updated_at: "{ISO timestamp}"
decisions: []
next_decision_id: 1
```

7. Create `context.yaml`:

```yaml
version: "1.0"
session_id: "{session-id}"

compaction:
  performed_at: null
  messages_compacted: 0
  token_reduction_estimate: 0
  compaction_method: null
  message_range:
    from: 0
    to: 0

essential_context:
  mission: "{description from arguments}"
  current_state:
    phase: "discovery"
    active_tasks: []
    blocked_tasks: []
    next_milestone: ""
    blockers: []
  key_decisions: []
  key_files:
    frontend: []
    backend: []
    database: []
    config: []
  active_patterns: []
  constraints: []

conversation_summary: {}

queryable_facts: []

recent_errors: []

handoff_notes: ""
```

8. Update `active-session.yaml`:

```yaml
session_id: "{session-id}"
started_at: "{ISO timestamp}"
```

9. Report:

```
Session started: {session-id}

Mission: {description}
Phase: discovery
Status: active

State files created:
  .agent-state/sessions/{session-id}/
  ├── session.yaml
  ├── tasks.yaml
  ├── decisions.yaml
  └── context.yaml

Next: Start working on your tasks. Use TaskCreate to track tasks natively.
Commands: /session-status, /compact, /handoff
```

## Output

Confirmation with session ID and created files.
