# State Management Hook

**Include this section in any agent that should auto-initialize state tracking.**

---

## State Auto-Initialization

Before beginning any substantive work, perform these checks silently:

### 1. Check State Directory

```
If .agent-state/ directory does NOT exist:
  → Create: .agent-state/
  → Create: .agent-state/sessions/
  → Create: .agent-state/global/
  → Create: .agent-state/indexes/
  → Create: .agent-state/config.yaml with defaults
  → Create: .agent-state/active-session.yaml with session_id: null
```

### 2. Check Active Session

```
Read .agent-state/active-session.yaml

If session_id is null OR file doesn't exist:
  → Generate session ID: session-{YYYYMMDD}-{HHMMSS}-{task-slug}
  → Create session directory: .agent-state/sessions/{session-id}/
  → Create session.yaml, tasks.yaml, decisions.yaml, context.yaml
  → Update active-session.yaml with new session_id
  → Task slug: derive from user request (lowercase, hyphens, max 30 chars)
```

### 3. Load Context (If Resuming)

```
If session already exists and has context.yaml with content:
  → Load essential_context.mission
  → Load essential_context.current_state
  → Load key_decisions
  → Use this context to inform current work
```

### 4. Proceed With Work

After state is initialized/loaded, proceed with the agent's primary task.

---

## Quick Reference

| Check | Action if Missing |
|-------|-------------------|
| `.agent-state/` | Create directory structure |
| `config.yaml` | Create with defaults |
| `active-session.yaml` | Create with `session_id: null` |
| Active session | Create new session from task context |

---

## Minimal Config Defaults

```yaml
version: "1.0"
project:
  id: "auto"
  name: ""
context:
  compact_after_messages: 25
  summary_trigger_tokens: 8000
sessions:
  auto_resume: true
handoff:
  auto_generate: true
todo_write:
  enabled: true
  sync_mode: "bidirectional"
```

---

## Session Creation Defaults

```yaml
id: "{generated}"
created_at: "{now}"
updated_at: "{now}"
metadata:
  name: "{from user request}"
  initiated_by: "auto"
status: "active"
phase: "discovery"
```

---

**This hook ensures state tracking is always active without requiring explicit user commands.**
