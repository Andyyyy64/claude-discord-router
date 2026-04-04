#!/bin/bash
# Mirror Claude Code conversation to Discord via daemon HTTP endpoint
# Called by both UserPromptSubmit and Stop hooks

DATA=$(cat)
CWD=$(echo "$DATA" | jq -r '.cwd // empty')
EVENT=$(echo "$DATA" | jq -r '.hook_event_name // empty')

if [ -z "$CWD" ]; then
  exit 0
fi

case "$EVENT" in
  UserPromptSubmit)
    # Extract user's prompt text
    MSG=$(echo "$DATA" | jq -r '.prompt // empty')
    [ -z "$MSG" ] && exit 0
    # Prefix with user label
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

curl -s -X POST "http://127.0.0.1:9249/mirror" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg cwd "$CWD" --arg text "$TEXT" '{cwd: $cwd, text: $text}')" \
  > /dev/null 2>&1 || true
