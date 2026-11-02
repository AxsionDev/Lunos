# Project Initialization Hook

**Include this in any agent that needs to know how to start the project.**

---

## Project Environment Check

Before beginning work, check for project startup documentation:

### 1. Read Project Startup Guide

```
Read .claude/PROJECT_STARTUP.md

If file EXISTS:
  → Use the documented paths, commands, and URLs
  → Proceed with your task

If file MISSING:
  → STOP and inform the user:
    "Project startup documentation not found. Run /generate-startup
    to auto-detect your project, or manually create
    .claude/PROJECT_STARTUP.md with your project's start commands."
  → Do NOT attempt to auto-detect or scan the project
```

### 2. Key Information to Extract

From PROJECT_STARTUP.md, agents should note:

- Frontend/Backend paths and start commands
- Development server URLs
- Any required environment setup

---

**This hook ensures agents use documented configuration instead of scanning.**
