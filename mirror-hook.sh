#!/bin/bash
# Mirror Claude Code conversation to Discord via daemon HTTP endpoint
# Called by both UserPromptSubmit and Stop hooks
# Uses PID mapping to route to the correct session when multiple sessions share the same cwd

DATA=$(cat)
CWD=$(echo "$DATA" | jq -r '.cwd // empty')
EVENT=$(echo "$DATA" | jq -r '.hook_event_name // empty')

if [ -z "$CWD" ]; then
  exit 0
fi

# Find daemon sessionId via PID mapping
# The plugin writes ~/.config/claude-discord-router/plugin-pids/<claude-code-pid>
# Walk up the process tree to find a matching PID file
SESSION_ID=""
PID_DIR="$HOME/.config/claude-discord-router/plugin-pids"
if [ -d "$PID_DIR" ]; then
  CHECK_PID=$$
  for i in 1 2 3 4 5; do
    CHECK_PID=$(ps -o ppid= -p "$CHECK_PID" 2>/dev/null | tr -d ' ')
    [ -z "$CHECK_PID" ] || [ "$CHECK_PID" = "1" ] && break
    if [ -f "$PID_DIR/$CHECK_PID" ]; then
      SESSION_ID=$(jq -r '.sessionId // empty' "$PID_DIR/$CHECK_PID" 2>/dev/null)
      break
    fi
  done
fi

case "$EVENT" in
  UserPromptSubmit)
    MSG=$(echo "$DATA" | jq -r '.prompt // empty')
    [ -z "$MSG" ] && exit 0
    TEXT="**User:** $MSG"
    ;;
  Stop)
    MSG=$(echo "$DATA" | jq -r '.last_assistant_message // empty')
    [ -z "$MSG" ] && exit 0
    TEXT="**Claude:** $MSG"
    ;;
  *)
    exit 0
    ;;
esac

# Truncate long messages
if [ ${#TEXT} -gt 1800 ]; then
  TEXT="${TEXT:0:1800}..."
fi

# Build JSON payload with optional sessionId
if [ -n "$SESSION_ID" ]; then
  PAYLOAD=$(jq -n --arg cwd "$CWD" --arg text "$TEXT" --arg sid "$SESSION_ID" \
    '{cwd: $cwd, text: $text, sessionId: $sid}')
else
  PAYLOAD=$(jq -n --arg cwd "$CWD" --arg text "$TEXT" \
    '{cwd: $cwd, text: $text}')
fi

curl -s -X POST "http://127.0.0.1:9249/mirror" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 || true
