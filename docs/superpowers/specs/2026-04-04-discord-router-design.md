# Claude Discord Router - Design Spec

## Overview

A daemon-based Discord channel router for Claude Code that automatically creates and manages Discord channels per Claude Code session, routing messages based on working directory.

## Problem

Claude Code's official Discord plugin is 1 bot = 1 session. When running multiple sessions across different projects, there's no way to route Discord messages to the correct session. Users must manually manage which session is connected.

## Solution

A two-component system:
1. **Router Daemon**: A persistent process running a Discord bot + WebSocket server. Manages Discord channel creation and routes messages between Discord channels and Claude Code sessions.
2. **MCP Plugin (Client)**: A lightweight MCP server plugin for Claude Code that connects to the daemon via WebSocket, registers the session, and relays messages.

## Decisions

| Topic | Decision |
|-------|----------|
| Daemon startup | Lazy start - first `cc` invocation auto-starts the daemon |
| Channel lifecycle | Persist channels for reuse; same directory reuses same category |
| Multiple sessions/dir | Separate channels per session (`projectA-1`, `projectA-2`) |
| Discord server | Single dedicated server (configured by guild ID) |
| Tech stack | Bun + TypeScript |
| Daemon-session comms | WebSocket (localhost) |
| Auth | Simple Discord user ID allowlist |

## Architecture

```
┌─────────────────────────────────────────────┐
│  Router Daemon (persistent process)          │
│  - Discord Bot (single)                      │
│  - WebSocket server (session connections)     │
│  - Channel auto-creation/management          │
│  - Message routing (channelId -> session WS)  │
└──────────┬──────────┬──────────┬─────────────┘
           │WS        │WS        │WS
     ┌─────┴──┐ ┌─────┴──┐ ┌────┴───┐
     │Client A│ │Client B│ │Client C│  <- MCP plugins
     │stdio   │ │stdio   │ │stdio   │
     └───┬────┘ └───┬────┘ └───┬────┘
         │          │          │
   [CC Session] [CC Session] [CC Session]
   ~/projectA   ~/projectA   ~/projectB
```

## Components

### Directory Structure
```
claude-discord-router/
├── daemon/
│   ├── server.ts        # Entry: Discord Bot + WS server
│   ├── discord.ts       # Channel creation/management
│   ├── router.ts        # Session table + message routing
│   ├── config.ts        # Config/state management
│   └── package.json
├── plugin/
│   ├── server.ts        # MCP server + WS client
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── .mcp.json
│   └── package.json
└── config.json          # Example config
```

### Config: `~/.config/claude-discord-router/config.json`
```json
{
  "discordBotToken": "MTIz...",
  "guildId": "1234567890",
  "allowFrom": ["609009874625495040"],
  "daemonPort": 9249,
  "categoryPrefix": ""
}
```

### State: `~/.config/claude-discord-router/state.json`
```json
{
  "categories": {
    "/home/andy/projectA": {
      "categoryId": "1111111111",
      "categoryName": "projectA",
      "channels": {
        "session-uuid-1": {
          "channelId": "2222222222",
          "channelName": "projectA-1",
          "createdAt": "2026-04-04T03:00:00Z",
          "active": false
        }
      }
    }
  },
  "daemon": {
    "pid": 12345,
    "startedAt": "2026-04-04T03:00:00Z"
  }
}
```

### Channel Naming
- Category: directory basename (`/home/andy/projectA` -> `projectA`)
- Channel: `{dirname}-{incrementing number}` (`projectA-1`, `projectA-2`)
- New channel = max existing number + 1 within the category

## Data Flows

### Session Startup
1. User runs `cc` in `~/projectA`
2. Claude Code starts `plugin/server.ts` as MCP server
3. Plugin reads `~/.config/claude-discord-router/config.json`
4. If daemon not running (check PID in state.json), plugin spawns it as detached child
5. Plugin connects via WebSocket, sends: `{ type: "register", cwd: "/home/andy/projectA", sessionId: "<uuid>" }`
6. Daemon creates category "projectA" if needed, creates channel "projectA-N"
7. Daemon updates state.json, responds: `{ type: "registered", channelId: "...", channelName: "projectA-1" }`
8. Plugin stores channelId, MCP tools ready

### Inbound (Discord -> Claude Code)
1. User sends message in `#projectA-1`
2. Daemon receives via `messageCreate`, checks allowlist
3. Router looks up channelId -> session WS connection
4. Daemon sends via WS: `{ type: "message", chatId, messageId, user, content, ts, attachments? }`
5. Plugin emits MCP notification: `notifications/claude/channel`
6. Claude receives as `<channel>` tag

### Outbound (Claude Code -> Discord)
1. Claude calls `reply` tool with `chat_id` and `text`
2. Plugin forwards via WS: `{ type: "reply", chatId, text, replyTo?, files? }`
3. Daemon sends via Discord API
4. Result returned through WS -> Plugin -> Claude

### Session End
1. Claude Code exits -> plugin stdin EOF
2. Plugin sends `{ type: "deregister", sessionId }` via WS, disconnects
3. Daemon marks session inactive in state.json
4. Channel persists for future reuse
5. Daemon stays running for other sessions

## MCP Tools (exposed by plugin)

Same interface as official plugin for compatibility:
- `reply(chat_id, text, reply_to?, files?)` - Send message to Discord
- `react(chat_id, message_id, emoji)` - Add reaction
- `edit_message(chat_id, message_id, text)` - Edit bot message
- `fetch_messages(channel, limit?)` - Fetch channel history
- `download_attachment(chat_id, message_id)` - Download attachments

## WebSocket Protocol

All messages are JSON with a `type` field.

### Client -> Daemon
- `{ type: "register", cwd: string, sessionId: string }` - Register session
- `{ type: "deregister", sessionId: string }` - Unregister session
- `{ type: "reply", chatId: string, text: string, replyTo?: string, files?: string[] }` - Send Discord message
- `{ type: "react", chatId: string, messageId: string, emoji: string }` - React
- `{ type: "edit", chatId: string, messageId: string, text: string }` - Edit message
- `{ type: "fetch_messages", chatId: string, limit?: number, requestId: string }` - Fetch history
- `{ type: "download_attachment", chatId: string, messageId: string, requestId: string }` - Download

### Daemon -> Client
- `{ type: "registered", channelId: string, channelName: string }` - Registration confirmed
- `{ type: "message", chatId: string, messageId: string, user: string, userId: string, content: string, ts: string, attachments?: string[] }` - Inbound message
- `{ type: "reply_result", requestId?: string, success: boolean, data?: any, error?: string }` - Tool result
- `{ type: "fetch_result", requestId: string, messages: Array }` - Fetch result
- `{ type: "download_result", requestId: string, files: Array }` - Download result

## Security

- Daemon listens on localhost only (127.0.0.1)
- Discord messages gated by user ID allowlist
- No outbound to channels without active sessions
- Config file permissions 0o600
- Bot token stored in config, not env vars (single location)

## Error Handling

- Daemon crash: Plugin detects WS disconnect, attempts reconnect with backoff. If daemon is dead (PID check), re-spawn it.
- Plugin crash: Daemon detects WS close, marks session inactive. Channel persists.
- Discord API errors: Daemon logs to stderr, returns error through WS to plugin.
- Duplicate category/channel names: Use state.json as source of truth, verify against Discord API on startup.
