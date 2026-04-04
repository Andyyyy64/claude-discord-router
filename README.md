# Claude Discord Router

> **Route multiple Claude Code sessions to separate Discord channels** — manage all your coding sessions from your phone.

Run `cc` in any project directory. A Discord channel is automatically created. Talk to Claude from Discord, or just watch the conversation mirror in real-time.

```
Discord Server (auto-managed)
├── projectA/
│   ├── #projectA-1  ←→  Claude Code session (~/projectA)
│   └── #projectA-2  ←→  Another session (~/projectA)
├── projectB/
│   └── #projectB-1  ←→  Claude Code session (~/projectB)
```

## Features

- **Auto channel creation** — Categories and channels are created per working directory, on first use
- **Channel reuse** — `--resume` reuses the existing channel instead of creating a new one
- **Bidirectional messaging** — Send commands from Discord, get responses back
- **Conversation mirroring** — Terminal conversation is automatically posted to Discord via hooks (no visible tool calls)
- **Multi-session** — Run multiple `cc` sessions across different projects simultaneously
- **Lazy daemon** — Daemon starts automatically on first `cc`, no manual setup needed

## How It Works

```
┌──────────────────────────────────────────┐
│  Router Daemon (auto-started)            │
│  Discord Bot + WebSocket Server          │
│  Channel management + Message routing    │
└─────┬──────────┬──────────┬──────────────┘
      │WS        │WS        │WS
   Plugin A   Plugin B   Plugin C    ← MCP plugins (per session)
      │          │          │
  [Claude]   [Claude]   [Claude]     ← Claude Code sessions
  ~/projA    ~/projA    ~/projB
```

**Daemon**: Single persistent process. Runs the Discord bot, manages channels, routes messages between Discord and sessions.

**Plugin**: Lightweight MCP server loaded by each Claude Code session. Connects to daemon via WebSocket, relays messages bidirectionally.

## Setup

### 1. Prerequisites

- [Bun](https://bun.sh) runtime
- A Discord bot ([create one here](https://discord.com/developers/applications)) with:
  - `Manage Channels`, `Send Messages`, `Read Messages/View Channels` permissions
  - `Message Content` privileged intent enabled
- A dedicated Discord server — invite the bot to it

### 2. Install

```bash
git clone https://github.com/Andyyyy64/claude-discord-router.git
cd claude-discord-router
bun install
```

### 3. Configure

```bash
mkdir -p ~/.config/claude-discord-router
cat > ~/.config/claude-discord-router/config.json << 'EOF'
{
  "discordBotToken": "YOUR_BOT_TOKEN",
  "guildId": "YOUR_GUILD_ID",
  "allowFrom": ["YOUR_DISCORD_USER_ID"],
  "daemonPort": 9249
}
EOF
chmod 600 ~/.config/claude-discord-router/config.json
```

### 4. Register MCP server

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "discord-router": {
      "command": "bun",
      "args": ["run", "/path/to/claude-discord-router/plugin/server.ts"]
    }
  }
}
```

### 5. Set up shell alias

```bash
# Add to ~/.zshrc or ~/.bashrc
alias cc="claude --dangerously-skip-permissions --dangerously-load-development-channels server:discord-router"
```

### 6. (Optional) Auto-mirror conversation to Discord

Add a Stop hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.config/claude-discord-router/mirror-hook.sh",
            "async": true
          }
        ]
      }
    ]
  }
}
```

The mirror hook script is installed at `~/.config/claude-discord-router/mirror-hook.sh` — it posts Claude's responses to the session's Discord channel in the background, with zero visual noise in the terminal.

### 7. Use it

```bash
cd ~/my-project
cc  # Channel auto-created on first interaction
```

## Config

| Key | Description | Default |
|-----|-------------|---------|
| `discordBotToken` | Discord bot token | required |
| `guildId` | Discord server ID | required |
| `allowFrom` | Discord user IDs allowed to send messages | required |
| `daemonPort` | WebSocket server port | `9249` |
| `categoryPrefix` | Prefix for category names (e.g. `cc-`) | `""` |

Config location: `~/.config/claude-discord-router/config.json`

## License

MIT
