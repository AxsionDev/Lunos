---
name: project-lunos-repo-environment
description: This CLAUDE.md's stack description is wrong; actual work happens in the Lunos monorepo worktree, not Axcode/.NET
metadata:
  type: project
---

The story-preparer agent's own CLAUDE.md (WeTrack/.NET/Angular template) does not describe the
actual target repo. When invoked from within an Axcode git worktree task
(`/Users/pminev/Documents/ITS/Projects/AxCode/.agent-worktrees/Axcode/task`), the real project is
**Lunos** — a Bun/TypeScript monorepo (Cloudflare Workers, SST, D1, Effect Schema validation,
`bun:test` only, no vitest/miniflare). This matches the pre-existing memory
`project_claude_md_mismatch.md` from the user-journey-analyst agent's memory — same repo, same
mismatch, now confirmed from the story-preparer side too.

**Why:** The agent's `.claude/docs/` and `.claude/stories/` inputs/outputs live inside the git
worktree, not the primary `Axcode` directory the agent's own CLAUDE.md sits in. Reading paths
under the primary directory (e.g. `/Users/pminev/.../Axcode/.claude/docs/...`) fails — the correct
root is the worktree path given in the task's "Working directory" line.

**How to apply:** Always resolve `.claude/docs/{feature}.md` and write `.claude/stories/{feature}.md`
relative to the working directory stated in the task/environment block, not relative to any
CLAUDE.md-described location. Disregard WeTrack/.NET/Angular language in the agent's own
instructions when the working directory is an Axcode/Lunos worktree — follow Bun/TS/Cloudflare
Worker/SST conventions instead (manual pathname routing, no router library, `bun:test` with DI
seams over mocking, Effect `Schema` for validation).
