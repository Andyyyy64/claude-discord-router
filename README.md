# Claude Discord Router

Routes multiple Claude Code sessions to separate Discord channels based on working directory. Each session gets its own channel, organized under categories by project.

## Architecture

```
Discord Server
├── projectA (category)
│   ├── #projectA-1 → Claude Code session in ~/projectA
│   └── #projectA-2 → Another session in ~/projectA
├── projectB (category)
│   └── #projectB-1 → Claude Code session in ~/projectB
```

Two components:
- **Daemon**: Persistent process running Discord bot + WebSocket server. Auto-creates channels, routes messages.
- **Plugin**: MCP plugin loaded by Claude Code. Connects to daemon via WebSocket, relays messages.

## Prerequisites

- [Bun](https://bun.sh) runtime
- Discord bot with:
  - `Manage Channels` permission
  - `Send Messages` permission
  - `Read Messages/View Channels` permission
  - `Message Content` privileged intent enabled
- A dedicated Discord server for the bot

## Setup

1. Clone and install:
```bash
git clone https://github.com/Andyyyy64/claude-discord-router.git
cd claude-discord-router
bun install
```

2. Create config:
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

3. Update your shell alias:
```bash
alias cc="CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --channels /path/to/claude-discord-router/plugin"
```

4. Run `cc` in any project directory. The daemon starts automatically, creates a Discord category + channel, and routes messages.

## Config Options

| Key | Description | Default |
|-----|-------------|---------|
| `discordBotToken` | Discord bot token | required |
| `guildId` | Discord server ID | required |
| `allowFrom` | Array of Discord user IDs allowed to send | required |
| `daemonPort` | WebSocket port for daemon | `9249` |
| `categoryPrefix` | Prefix for category names | `""` |

## Manual Daemon Management

```bash
# Start daemon manually
cd /path/to/claude-discord-router && bun run daemon/server.ts

# Check if running
cat ~/.config/claude-discord-router/state.json | jq .daemon
```
