#!/usr/bin/env bash
#
# File: .claude/hooks/session-start-tts.sh
#
# Stub. AgentVibes (TTS on SessionStart) was fully removed 2026-09-10 —
# Piper TTS was never installed, so every session paid for a broken
# protocol injection with no working voice output, plus a GitHub-star nag.
#
# This file is kept ONLY because ~/.claude/settings.json has a global
# SessionStart hook that runs it unconditionally in every project:
#   bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start-tts.sh
# Deleting it outright would make that hook error on this project. If you
# ever remove the global hook entry too, this file can go with it.
#
exit 0
