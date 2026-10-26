#!/usr/bin/env bash
# PostCompact hook — re-inject session state after context compaction
# Stdout is injected as a system-reminder into the compacted context.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="$PROJECT_DIR/.agent-state"

if [[ ! -f "$STATE_DIR/active-session.yaml" ]]; then
  exit 0
fi

SESSION_ID=$(grep -E '^session_id:' "$STATE_DIR/active-session.yaml" 2>/dev/null | awk '{print $2}' | tr -d '"')

if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  exit 0
fi

SESSION_DIR="$STATE_DIR/sessions/$SESSION_ID"

echo "## Session Context (PostCompact Re-injection)"
echo ""
echo "**Active Session:** $SESSION_ID"

if [[ -f "$SESSION_DIR/session.yaml" ]]; then
  TITLE=$(grep -E '^title:' "$SESSION_DIR/session.yaml" 2>/dev/null | cut -d':' -f2- | xargs)
  STATUS=$(grep -E '^status:' "$SESSION_DIR/session.yaml" 2>/dev/null | awk '{print $2}')
  echo "**Title:** $TITLE"
  echo "**Status:** $STATUS"
fi

if [[ -f "$SESSION_DIR/tasks.yaml" ]]; then
  echo ""
  echo "### Active Tasks"
  grep -E '(title:|status:)' "$SESSION_DIR/tasks.yaml" 2>/dev/null | paste - - | \
    awk '{gsub(/title: /, "", $0); gsub(/status: /, "", $0); print "- " $0}' | head -10
fi

if [[ -f "$SESSION_DIR/decisions.yaml" ]]; then
  DECISION_COUNT=$(grep -c '^- ' "$SESSION_DIR/decisions.yaml" 2>/dev/null || echo 0)
  if [[ "$DECISION_COUNT" -gt 0 ]]; then
    echo ""
    echo "### Recent Decisions ($DECISION_COUNT total)"
    tail -20 "$SESSION_DIR/decisions.yaml" 2>/dev/null
  fi
fi

if [[ -f "$SESSION_DIR/context.yaml" ]]; then
  echo ""
  echo "### Compacted Context"
  cat "$SESSION_DIR/context.yaml" 2>/dev/null | head -30
fi

echo ""
echo "_Context restored from .agent-state/$SESSION_ID after compaction._"
