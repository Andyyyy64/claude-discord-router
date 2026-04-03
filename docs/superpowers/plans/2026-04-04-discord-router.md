# Claude Discord Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daemon + plugin system that routes Discord messages to multiple Claude Code sessions based on working directory, auto-creating Discord channels per session.

**Architecture:** Two components: (1) a persistent daemon process running a Discord bot and WebSocket server that manages channel creation and message routing, and (2) a lightweight MCP plugin that each Claude Code session loads, connecting to the daemon via WebSocket to relay messages.

**Tech Stack:** Bun, TypeScript, discord.js v14, @modelcontextprotocol/sdk, ws (via Bun native WebSocket)

---

## File Structure

```
claude-discord-router/
├── daemon/
│   ├── package.json         # Daemon deps: discord.js, shared types
│   ├── tsconfig.json
│   ├── config.ts            # Load/save config.json and state.json
│   ├── discord.ts           # Discord category/channel CRUD
│   ├── router.ts            # Session table, WS server, message routing
│   └── server.ts            # Entry point: boots Discord + WS, wires them together
├── plugin/
│   ├── package.json         # Plugin deps: @modelcontextprotocol/sdk
│   ├── tsconfig.json
│   ├── .claude-plugin/
│   │   └── plugin.json      # Plugin metadata for Claude Code
│   ├── .mcp.json            # MCP server launch config
│   └── server.ts            # MCP server + WS client + daemon launcher
├── shared/
│   └── protocol.ts          # WS message type definitions shared by daemon + plugin
├── package.json             # Root workspace
└── tsconfig.base.json       # Shared TS config
```

---

### Task 1: Project Scaffolding and Shared Types

**Files:**
- Create: `package.json` (root workspace)
- Create: `tsconfig.base.json`
- Create: `shared/protocol.ts`
- Create: `daemon/package.json`
- Create: `daemon/tsconfig.json`
- Create: `plugin/package.json`
- Create: `plugin/tsconfig.json`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "claude-discord-router",
  "private": true,
  "workspaces": ["daemon", "plugin", "shared"]
}
```

- [ ] **Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 3: Create shared/protocol.ts**

This file defines all WebSocket message types used between daemon and plugin.

```typescript
// ── Client -> Daemon ──

export type RegisterMessage = {
  type: "register"
  cwd: string
  sessionId: string
}

export type DeregisterMessage = {
  type: "deregister"
  sessionId: string
}

export type ReplyMessage = {
  type: "reply"
  chatId: string
  text: string
  replyTo?: string
  files?: string[]
  requestId: string
}

export type ReactMessage = {
  type: "react"
  chatId: string
  messageId: string
  emoji: string
  requestId: string
}

export type EditMessage = {
  type: "edit"
  chatId: string
  messageId: string
  text: string
  requestId: string
}

export type FetchMessagesMessage = {
  type: "fetch_messages"
  chatId: string
  limit?: number
  requestId: string
}

export type DownloadAttachmentMessage = {
  type: "download_attachment"
  chatId: string
  messageId: string
  requestId: string
}

export type ClientMessage =
  | RegisterMessage
  | DeregisterMessage
  | ReplyMessage
  | ReactMessage
  | EditMessage
  | FetchMessagesMessage
  | DownloadAttachmentMessage

// ── Daemon -> Client ──

export type RegisteredMessage = {
  type: "registered"
  channelId: string
  channelName: string
}

export type InboundMessage = {
  type: "message"
  chatId: string
  messageId: string
  user: string
  userId: string
  content: string
  ts: string
  attachmentCount?: number
  attachments?: string[]
}

export type ResultMessage = {
  type: "result"
  requestId: string
  success: boolean
  data?: unknown
  error?: string
}

export type ErrorMessage = {
  type: "error"
  message: string
}

export type DaemonMessage =
  | RegisteredMessage
  | InboundMessage
  | ResultMessage
  | ErrorMessage

// ── Config & State ──

export type Config = {
  discordBotToken: string
  guildId: string
  allowFrom: string[]
  daemonPort: number
  categoryPrefix: string
}

export type ChannelEntry = {
  channelId: string
  channelName: string
  createdAt: string
  active: boolean
}

export type CategoryEntry = {
  categoryId: string
  categoryName: string
  channels: Record<string, ChannelEntry> // keyed by sessionId
}

export type State = {
  categories: Record<string, CategoryEntry> // keyed by absolute cwd path
  daemon: {
    pid: number
    startedAt: string
  } | null
}

export const DEFAULT_CONFIG: Partial<Config> = {
  daemonPort: 9249,
  categoryPrefix: "",
}

export const CONFIG_DIR = `${process.env.HOME}/.config/claude-discord-router`
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`
export const STATE_PATH = `${CONFIG_DIR}/state.json`
export const INBOX_DIR = `${CONFIG_DIR}/inbox`
```

- [ ] **Step 4: Create shared/package.json**

```json
{
  "name": "claude-discord-router-shared",
  "version": "0.0.1",
  "type": "module",
  "main": "protocol.ts"
}
```

- [ ] **Step 5: Create daemon/package.json**

```json
{
  "name": "claude-discord-router-daemon",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "start": "bun run server.ts"
  },
  "dependencies": {
    "discord.js": "^14.14.0"
  }
}
```

- [ ] **Step 6: Create daemon/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["*.ts", "../shared/*.ts"]
}
```

- [ ] **Step 7: Create plugin/package.json**

```json
{
  "name": "claude-discord-router-plugin",
  "version": "0.0.1",
  "type": "module",
  "bin": "./server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 8: Create plugin/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["*.ts", "../shared/*.ts"]
}
```

- [ ] **Step 9: Install dependencies**

Run: `cd /home/andy/claude-discord-router && bun install`
Expected: Dependencies installed, bun.lock created.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: scaffold project structure with shared protocol types"
```

---

### Task 2: Daemon Config and State Management

**Files:**
- Create: `daemon/config.ts`

- [ ] **Step 1: Write daemon/config.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from "fs"
import { type Config, type State, DEFAULT_CONFIG, CONFIG_DIR, CONFIG_PATH, STATE_PATH } from "../shared/protocol.ts"

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8")
    const parsed = JSON.parse(raw) as Partial<Config>
    return {
      discordBotToken: parsed.discordBotToken ?? "",
      guildId: parsed.guildId ?? "",
      allowFrom: parsed.allowFrom ?? [],
      daemonPort: parsed.daemonPort ?? DEFAULT_CONFIG.daemonPort!,
      categoryPrefix: parsed.categoryPrefix ?? DEFAULT_CONFIG.categoryPrefix!,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Config not found at ${CONFIG_PATH}. Create it with:\n` +
        `  mkdir -p ${CONFIG_DIR}\n` +
        `  cat > ${CONFIG_PATH} << 'EOF'\n` +
        `  {\n` +
        `    "discordBotToken": "YOUR_BOT_TOKEN",\n` +
        `    "guildId": "YOUR_GUILD_ID",\n` +
        `    "allowFrom": ["YOUR_DISCORD_USER_ID"],\n` +
        `    "daemonPort": 9249\n` +
        `  }\n` +
        `  EOF`
      )
    }
    throw err
  }
}

export function loadState(): State {
  try {
    const raw = readFileSync(STATE_PATH, "utf8")
    return JSON.parse(raw) as State
  } catch {
    return { categories: {}, daemon: null }
  }
}

export function saveState(state: State): void {
  ensureConfigDir()
  const tmp = STATE_PATH + ".tmp"
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, STATE_PATH)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/andy/claude-discord-router/daemon && bun build --target=bun config.ts --outdir=/tmp/test-build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add daemon/config.ts
git commit -m "feat: add config and state file management"
```

---

### Task 3: Daemon Discord Channel Manager

**Files:**
- Create: `daemon/discord.ts`

- [ ] **Step 1: Write daemon/discord.ts**

```typescript
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Guild,
  type CategoryChannel,
  type TextChannel,
} from "discord.js"
import { basename } from "path"
import type { Config, State, CategoryEntry, ChannelEntry } from "../shared/protocol.ts"
import { saveState } from "./config.ts"

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  })
}

export async function ensureCategory(
  guild: Guild,
  cwd: string,
  config: Config,
  state: State,
): Promise<CategoryEntry> {
  const existing = state.categories[cwd]
  if (existing) {
    // Verify category still exists on Discord
    try {
      await guild.channels.fetch(existing.categoryId)
      return existing
    } catch {
      // Category was deleted on Discord, recreate
    }
  }

  const dirName = basename(cwd)
  const categoryName = config.categoryPrefix
    ? `${config.categoryPrefix}${dirName}`
    : dirName

  const category = await guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
  })

  const entry: CategoryEntry = {
    categoryId: category.id,
    categoryName: category.name,
    channels: existing?.channels ?? {},
  }
  state.categories[cwd] = entry
  saveState(state)
  return entry
}

export async function createSessionChannel(
  guild: Guild,
  cwd: string,
  sessionId: string,
  state: State,
): Promise<ChannelEntry> {
  const category = state.categories[cwd]
  if (!category) throw new Error(`No category for ${cwd}`)

  const dirName = basename(cwd)
  // Find next channel number
  const existingNumbers = Object.values(category.channels)
    .map(ch => {
      const match = ch.channelName.match(/-(\d+)$/)
      return match ? parseInt(match[1], 10) : 0
    })
  const nextNum = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1
  const channelName = `${dirName}-${nextNum}`

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.categoryId,
  })

  const entry: ChannelEntry = {
    channelId: channel.id,
    channelName: channel.name,
    createdAt: new Date().toISOString(),
    active: true,
  }
  category.channels[sessionId] = entry
  saveState(state)
  return entry
}

export async function sendToChannel(
  client: Client,
  channelId: string,
  text: string,
  options?: { replyTo?: string; files?: string[] },
): Promise<string[]> {
  const channel = await client.channels.fetch(channelId)
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`Channel ${channelId} not found or not sendable`)
  }

  // Discord 2000 char limit - split if needed
  const chunks = chunkText(text, 2000)
  const sentIds: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    const sent = await channel.send({
      content: chunks[i],
      ...(i === 0 && options?.files ? { files: options.files } : {}),
      ...(i === 0 && options?.replyTo
        ? { reply: { messageReference: options.replyTo, failIfNotExists: false } }
        : {}),
    })
    sentIds.push(sent.id)
  }
  return sentIds
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const newline = rest.lastIndexOf("\n", limit)
    const space = rest.lastIndexOf(" ", limit)
    const cut = newline > limit / 2 ? newline : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest) out.push(rest)
  return out
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/andy/claude-discord-router/daemon && bun build --target=bun discord.ts --outdir=/tmp/test-build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add daemon/discord.ts
git commit -m "feat: add Discord channel creation and management"
```

---

### Task 4: Daemon Router (Session Table + WebSocket Server)

**Files:**
- Create: `daemon/router.ts`

- [ ] **Step 1: Write daemon/router.ts**

```typescript
import type { ServerWebSocket } from "bun"
import type {
  ClientMessage,
  DaemonMessage,
  InboundMessage,
  State,
  Config,
} from "../shared/protocol.ts"
import { saveState } from "./config.ts"

export type Session = {
  sessionId: string
  cwd: string
  channelId: string
  channelName: string
  ws: ServerWebSocket<{ sessionId: string }>
}

export class Router {
  // channelId -> session
  private channelToSession = new Map<string, Session>()
  // sessionId -> session
  private sessions = new Map<string, Session>()

  register(session: Session): void {
    this.sessions.set(session.sessionId, session)
    this.channelToSession.set(session.channelId, session)
  }

  deregister(sessionId: string, state: State): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.channelToSession.delete(session.channelId)
    this.sessions.delete(sessionId)

    // Mark inactive in state
    const category = state.categories[session.cwd]
    if (category?.channels[sessionId]) {
      category.channels[sessionId].active = false
      saveState(state)
    }
  }

  getSessionByChannel(channelId: string): Session | undefined {
    return this.channelToSession.get(channelId)
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  sendToSession(channelId: string, message: DaemonMessage): boolean {
    const session = this.channelToSession.get(channelId)
    if (!session) return false
    session.ws.send(JSON.stringify(message))
    return true
  }

  sendToSessionById(sessionId: string, message: DaemonMessage): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.ws.send(JSON.stringify(message))
  }

  isAllowed(userId: string, config: Config): boolean {
    return config.allowFrom.includes(userId)
  }

  getAllActiveSessions(): Session[] {
    return [...this.sessions.values()]
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/andy/claude-discord-router/daemon && bun build --target=bun router.ts --outdir=/tmp/test-build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add daemon/router.ts
git commit -m "feat: add session router with channel-to-session mapping"
```

---

### Task 5: Daemon Server Entry Point

**Files:**
- Create: `daemon/server.ts`

- [ ] **Step 1: Write daemon/server.ts**

```typescript
#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { join } from "path"
import type { ServerWebSocket } from "bun"
import type {
  ClientMessage,
  RegisterMessage,
  ReplyMessage,
  ReactMessage,
  EditMessage,
  FetchMessagesMessage,
  DownloadAttachmentMessage,
  State,
} from "../shared/protocol.ts"
import { INBOX_DIR } from "../shared/protocol.ts"
import { loadConfig, loadState, saveState, ensureConfigDir } from "./config.ts"
import { createDiscordClient, ensureCategory, createSessionChannel, sendToChannel } from "./discord.ts"
import { Router } from "./router.ts"

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

ensureConfigDir()
const config = loadConfig()
const state = loadState()
const router = new Router()

if (!config.discordBotToken) {
  process.stderr.write("discord-router: discordBotToken required in config\n")
  process.exit(1)
}
if (!config.guildId) {
  process.stderr.write("discord-router: guildId required in config\n")
  process.exit(1)
}

// Save daemon PID
state.daemon = { pid: process.pid, startedAt: new Date().toISOString() }
saveState(state)

// ── Discord Bot ──
const client = createDiscordClient()

client.on("error", err => {
  process.stderr.write(`discord-router: client error: ${err}\n`)
})

client.on("messageCreate", msg => {
  if (msg.author.bot) return
  if (!router.isAllowed(msg.author.id, config)) return

  const session = router.getSessionByChannel(msg.channelId)
  if (!session) return

  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    const name = (att.name ?? att.id).replace(/[\[\]\r\n;]/g, "_")
    atts.push(`${name} (${att.contentType ?? "unknown"}, ${kb}KB)`)
  }

  router.sendToSession(msg.channelId, {
    type: "message",
    chatId: msg.channelId,
    messageId: msg.id,
    user: msg.author.username,
    userId: msg.author.id,
    content: msg.content || (atts.length > 0 ? "(attachment)" : ""),
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachmentCount: atts.length, attachments: atts } : {}),
  })
})

client.once("ready", c => {
  process.stderr.write(`discord-router: Discord connected as ${c.user.tag}\n`)
})

await client.login(config.discordBotToken)

const guild = await client.guilds.fetch(config.guildId)
if (!guild) {
  process.stderr.write(`discord-router: guild ${config.guildId} not found\n`)
  process.exit(1)
}

// ── WebSocket Server ──
async function handleRegister(
  ws: ServerWebSocket<{ sessionId: string }>,
  msg: RegisterMessage,
): Promise<void> {
  const { cwd, sessionId } = msg
  ws.data.sessionId = sessionId

  const category = await ensureCategory(guild, cwd, config, state)
  const channel = await createSessionChannel(guild, cwd, sessionId, state)

  router.register({
    sessionId,
    cwd,
    channelId: channel.channelId,
    channelName: channel.channelName,
    ws,
  })

  process.stderr.write(
    `discord-router: session ${sessionId} registered -> #${channel.channelName} (${channel.channelId})\n`
  )

  ws.send(JSON.stringify({
    type: "registered",
    channelId: channel.channelId,
    channelName: channel.channelName,
  }))
}

async function handleReply(msg: ReplyMessage): Promise<void> {
  const sentIds = await sendToChannel(client, msg.chatId, msg.text, {
    replyTo: msg.replyTo,
    files: msg.files,
  })
  const session = router.getSessionByChannel(msg.chatId)
  if (session) {
    session.ws.send(JSON.stringify({
      type: "result",
      requestId: msg.requestId,
      success: true,
      data: sentIds.length === 1
        ? `sent (id: ${sentIds[0]})`
        : `sent ${sentIds.length} parts (ids: ${sentIds.join(", ")})`,
    }))
  }
}

async function handleReact(msg: ReactMessage): Promise<void> {
  const channel = await client.channels.fetch(msg.chatId)
  if (!channel?.isTextBased()) throw new Error("Channel not found")
  const discordMsg = await channel.messages.fetch(msg.messageId)
  await discordMsg.react(msg.emoji)
  const session = router.getSessionByChannel(msg.chatId)
  if (session) {
    session.ws.send(JSON.stringify({
      type: "result",
      requestId: msg.requestId,
      success: true,
      data: "reacted",
    }))
  }
}

async function handleEdit(msg: EditMessage): Promise<void> {
  const channel = await client.channels.fetch(msg.chatId)
  if (!channel?.isTextBased()) throw new Error("Channel not found")
  const discordMsg = await channel.messages.fetch(msg.messageId)
  const edited = await discordMsg.edit(msg.text)
  const session = router.getSessionByChannel(msg.chatId)
  if (session) {
    session.ws.send(JSON.stringify({
      type: "result",
      requestId: msg.requestId,
      success: true,
      data: `edited (id: ${edited.id})`,
    }))
  }
}

async function handleFetchMessages(msg: FetchMessagesMessage): Promise<void> {
  const channel = await client.channels.fetch(msg.chatId)
  if (!channel?.isTextBased()) throw new Error("Channel not found")
  const limit = Math.min(msg.limit ?? 20, 100)
  const msgs = await channel.messages.fetch({ limit })
  const me = client.user?.id
  const arr = [...msgs.values()].reverse()
  const out = arr.length === 0
    ? "(no messages)"
    : arr.map(m => {
        const who = m.author.id === me ? "me" : m.author.username
        const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ""
        const text = m.content.replace(/[\r\n]+/g, " ⏎ ")
        return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
      }).join("\n")

  const session = router.getSessionByChannel(msg.chatId)
  if (session) {
    session.ws.send(JSON.stringify({
      type: "result",
      requestId: msg.requestId,
      success: true,
      data: out,
    }))
  }
}

async function handleDownloadAttachment(msg: DownloadAttachmentMessage): Promise<void> {
  const channel = await client.channels.fetch(msg.chatId)
  if (!channel?.isTextBased()) throw new Error("Channel not found")
  const discordMsg = await channel.messages.fetch(msg.messageId)

  if (discordMsg.attachments.size === 0) {
    const session = router.getSessionByChannel(msg.chatId)
    if (session) {
      session.ws.send(JSON.stringify({
        type: "result",
        requestId: msg.requestId,
        success: true,
        data: "message has no attachments",
      }))
    }
    return
  }

  mkdirSync(INBOX_DIR, { recursive: true })
  const lines: string[] = []
  for (const att of discordMsg.attachments.values()) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB`)
    }
    const res = await fetch(att.url)
    const buf = Buffer.from(await res.arrayBuffer())
    const name = att.name ?? `${att.id}`
    const rawExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin"
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin"
    const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
    writeFileSync(path, buf)
    const kb = (att.size / 1024).toFixed(0)
    lines.push(`  ${path}  (${name}, ${att.contentType ?? "unknown"}, ${kb}KB)`)
  }

  const session = router.getSessionByChannel(msg.chatId)
  if (session) {
    session.ws.send(JSON.stringify({
      type: "result",
      requestId: msg.requestId,
      success: true,
      data: `downloaded ${lines.length} attachment(s):\n${lines.join("\n")}`,
    }))
  }
}

async function handleClientMessage(
  ws: ServerWebSocket<{ sessionId: string }>,
  raw: string,
): Promise<void> {
  const msg = JSON.parse(raw) as ClientMessage
  try {
    switch (msg.type) {
      case "register":
        await handleRegister(ws, msg)
        break
      case "deregister":
        router.deregister(msg.sessionId, state)
        process.stderr.write(`discord-router: session ${msg.sessionId} deregistered\n`)
        break
      case "reply":
        await handleReply(msg)
        break
      case "react":
        await handleReact(msg)
        break
      case "edit":
        await handleEdit(msg)
        break
      case "fetch_messages":
        await handleFetchMessages(msg)
        break
      case "download_attachment":
        await handleDownloadAttachment(msg)
        break
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: error handling ${msg.type}: ${errorMsg}\n`)
    if ("requestId" in msg && msg.requestId) {
      ws.send(JSON.stringify({
        type: "result",
        requestId: msg.requestId,
        success: false,
        error: errorMsg,
      }))
    }
  }
}

const wsServer = Bun.serve<{ sessionId: string }>({
  hostname: "127.0.0.1",
  port: config.daemonPort,
  fetch(req, server) {
    const upgraded = server.upgrade(req, { data: { sessionId: "" } })
    if (!upgraded) {
      return new Response("WebSocket upgrade required", { status: 426 })
    }
  },
  websocket: {
    open(ws) {
      process.stderr.write("discord-router: new WS connection\n")
    },
    message(ws, raw) {
      handleClientMessage(ws, String(raw)).catch(err => {
        process.stderr.write(`discord-router: WS message error: ${err}\n`)
      })
    },
    close(ws) {
      const sessionId = ws.data.sessionId
      if (sessionId) {
        router.deregister(sessionId, state)
        process.stderr.write(`discord-router: session ${sessionId} disconnected\n`)
      }
    },
  },
})

process.stderr.write(
  `discord-router: WS server listening on ws://127.0.0.1:${wsServer.port}\n`
)

// Graceful shutdown
function shutdown(): void {
  process.stderr.write("discord-router: shutting down\n")
  state.daemon = null
  saveState(state)
  wsServer.stop()
  client.destroy()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/andy/claude-discord-router && bun build --target=bun daemon/server.ts --outdir=/tmp/test-build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add daemon/server.ts
git commit -m "feat: add daemon entry point with Discord bot and WebSocket server"
```

---

### Task 6: MCP Plugin (Client)

**Files:**
- Create: `plugin/server.ts`
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `plugin/.mcp.json`

- [ ] **Step 1: Write plugin/server.ts**

```typescript
#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { readFileSync } from "fs"
import { spawn } from "child_process"
import { randomUUID } from "crypto"
import type {
  DaemonMessage,
  RegisteredMessage,
  ResultMessage,
  InboundMessage,
  Config,
  State,
} from "../shared/protocol.ts"
import { CONFIG_PATH, STATE_PATH, DEFAULT_CONFIG } from "../shared/protocol.ts"

// ── Config ──
function loadConfig(): Config {
  const raw = readFileSync(CONFIG_PATH, "utf8")
  const parsed = JSON.parse(raw) as Partial<Config>
  return {
    discordBotToken: parsed.discordBotToken ?? "",
    guildId: parsed.guildId ?? "",
    allowFrom: parsed.allowFrom ?? [],
    daemonPort: parsed.daemonPort ?? DEFAULT_CONFIG.daemonPort!,
    categoryPrefix: parsed.categoryPrefix ?? DEFAULT_CONFIG.categoryPrefix!,
  }
}

function loadState(): State | null {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State
  } catch {
    return null
  }
}

function isDaemonRunning(): boolean {
  const state = loadState()
  if (!state?.daemon?.pid) return false
  try {
    process.kill(state.daemon.pid, 0)
    return true
  } catch {
    return false
  }
}

function startDaemon(): void {
  const daemonPath = new URL("../daemon/server.ts", import.meta.url).pathname
  const child = spawn("bun", ["run", daemonPath], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  process.stderr.write(`discord-router-plugin: daemon started (pid: ${child.pid})\n`)
}

// ── WebSocket Connection ──
const config = loadConfig()
const sessionId = randomUUID()
const cwd = process.cwd()
let ws: WebSocket | null = null
let channelId: string | null = null
let channelName: string | null = null

// Pending request callbacks
const pendingRequests = new Map<string, {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}>()

function sendWs(data: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to daemon")
  }
  ws.send(JSON.stringify(data))
}

function requestWs(data: Record<string, unknown>): Promise<unknown> {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })
    sendWs({ ...data, requestId })
    // Timeout after 30s
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId)
        reject(new Error("Request timed out"))
      }
    }, 30000)
  })
}

// ── MCP Server ──
const mcp = new Server(
  { name: "discord-router", version: "0.0.1" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: [
      "The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.",
      "",
      'Messages from Discord arrive as <channel source="discord-router" chat_id="..." message_id="..." user="..." ts="...">.',
      "Reply with the reply tool — pass chat_id back.",
      "",
      "reply accepts file paths (files: [\"/abs/path.png\"]) for attachments.",
      "Use react to add emoji reactions, and edit_message for interim progress updates.",
      "fetch_messages pulls real Discord history.",
    ].join("\n"),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Reply on Discord. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          text: { type: "string" },
          reply_to: { type: "string", description: "Message ID to thread under." },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach. Max 10 files, 25MB each.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a Discord message.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "edit_message",
      description: "Edit a message the bot previously sent.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          text: { type: "string" },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
    {
      name: "fetch_messages",
      description: "Fetch recent messages from a Discord channel.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string" },
          limit: { type: "number", description: "Max messages (default 20, max 100)." },
        },
        required: ["channel"],
      },
    },
    {
      name: "download_attachment",
      description: "Download attachments from a Discord message.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
        },
        required: ["chat_id", "message_id"],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case "reply": {
        const result = await requestWs({
          type: "reply",
          chatId: args.chat_id as string,
          text: args.text as string,
          replyTo: args.reply_to as string | undefined,
          files: args.files as string[] | undefined,
        })
        return { content: [{ type: "text", text: String(result) }] }
      }
      case "react": {
        const result = await requestWs({
          type: "react",
          chatId: args.chat_id as string,
          messageId: args.message_id as string,
          emoji: args.emoji as string,
        })
        return { content: [{ type: "text", text: String(result) }] }
      }
      case "edit_message": {
        const result = await requestWs({
          type: "edit",
          chatId: args.chat_id as string,
          messageId: args.message_id as string,
          text: args.text as string,
        })
        return { content: [{ type: "text", text: String(result) }] }
      }
      case "fetch_messages": {
        const result = await requestWs({
          type: "fetch_messages",
          chatId: args.channel as string,
          limit: args.limit as number | undefined,
        })
        return { content: [{ type: "text", text: String(result) }] }
      }
      case "download_attachment": {
        const result = await requestWs({
          type: "download_attachment",
          chatId: args.chat_id as string,
          messageId: args.message_id as string,
        })
        return { content: [{ type: "text", text: String(result) }] }
      }
      default:
        return {
          content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: "text", text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ── Connect ──
async function connect(): Promise<void> {
  // Lazy start daemon
  if (!isDaemonRunning()) {
    process.stderr.write("discord-router-plugin: daemon not running, starting...\n")
    startDaemon()
    // Wait for daemon to start
    await new Promise(resolve => setTimeout(resolve, 3000))
  }

  const url = `ws://127.0.0.1:${config.daemonPort}`
  process.stderr.write(`discord-router-plugin: connecting to ${url}\n`)

  return new Promise((resolve, reject) => {
    ws = new WebSocket(url)

    ws.onopen = () => {
      process.stderr.write("discord-router-plugin: connected to daemon\n")
      sendWs({ type: "register", cwd, sessionId })
    }

    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as DaemonMessage
      switch (msg.type) {
        case "registered":
          channelId = msg.channelId
          channelName = msg.channelName
          process.stderr.write(
            `discord-router-plugin: registered as #${msg.channelName} (${msg.channelId})\n`
          )
          resolve()
          break
        case "message":
          handleInboundMessage(msg)
          break
        case "result":
          handleResult(msg)
          break
        case "error":
          process.stderr.write(`discord-router-plugin: daemon error: ${msg.message}\n`)
          break
      }
    }

    ws.onclose = () => {
      process.stderr.write("discord-router-plugin: disconnected from daemon\n")
      ws = null
      // Attempt reconnect after 5s
      setTimeout(() => {
        if (!ws) connect().catch(() => {})
      }, 5000)
    }

    ws.onerror = (err) => {
      process.stderr.write(`discord-router-plugin: WS error: ${err}\n`)
      reject(err)
    }

    // Timeout connection attempt
    setTimeout(() => reject(new Error("Connection timeout")), 10000)
  })
}

function handleInboundMessage(msg: InboundMessage): void {
  mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: msg.content,
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId,
        user: msg.user,
        user_id: msg.userId,
        ts: msg.ts,
        ...(msg.attachmentCount
          ? {
              attachment_count: String(msg.attachmentCount),
              attachments: msg.attachments?.join("; ") ?? "",
            }
          : {}),
      },
    },
  }).catch(err => {
    process.stderr.write(`discord-router-plugin: failed to deliver message: ${err}\n`)
  })
}

function handleResult(msg: ResultMessage): void {
  const pending = pendingRequests.get(msg.requestId)
  if (!pending) return
  pendingRequests.delete(msg.requestId)
  if (msg.success) {
    pending.resolve(msg.data)
  } else {
    pending.reject(new Error(msg.error ?? "Unknown error"))
  }
}

// ── Start ──
await mcp.connect(new StdioServerTransport())

try {
  await connect()
} catch (err) {
  process.stderr.write(`discord-router-plugin: initial connection failed: ${err}\n`)
  // Keep running - will retry via reconnect
}

// Graceful shutdown
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write("discord-router-plugin: shutting down\n")
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendWs({ type: "deregister", sessionId })
  }
  setTimeout(() => process.exit(0), 1000)
}

process.stdin.on("end", shutdown)
process.stdin.on("close", shutdown)
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
```

- [ ] **Step 2: Write plugin/.claude-plugin/plugin.json**

```json
{
  "name": "discord-router",
  "description": "Discord channel router for Claude Code — routes multiple sessions to separate Discord channels based on working directory.",
  "version": "0.0.1",
  "keywords": ["discord", "routing", "channel", "mcp"]
}
```

- [ ] **Step 3: Write plugin/.mcp.json**

```json
{
  "mcpServers": {
    "discord-router": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd /home/andy/claude-discord-router && bun build --target=bun plugin/server.ts --outdir=/tmp/test-build`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add plugin/
git commit -m "feat: add MCP plugin with WS client and daemon launcher"
```

---

### Task 7: Integration Test — Manual End-to-End

**Files:** None (testing only)

Prerequisites: A Discord bot token and guild ID. The bot must have `Manage Channels`, `Send Messages`, `Read Messages/View Channels`, `Message Content` intent enabled.

- [ ] **Step 1: Create config**

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

- [ ] **Step 2: Start daemon manually to verify**

Run: `cd /home/andy/claude-discord-router && bun run daemon/server.ts`
Expected output:
```
discord-router: Discord connected as BotName#1234
discord-router: WS server listening on ws://127.0.0.1:9249
```

Check Discord server — bot should be online.

- [ ] **Step 3: Test plugin registration**

In a new terminal:
Run: `cd /home/andy/some-test-project && bun run /home/andy/claude-discord-router/plugin/server.ts`
Expected daemon output:
```
discord-router: new WS connection
discord-router: session <uuid> registered -> #some-test-project-1 (<channelId>)
```

Check Discord — `some-test-project` category and `some-test-project-1` channel should exist.

- [ ] **Step 4: Test message routing**

Send a message in `#some-test-project-1` on Discord.
Expected: Plugin should receive the message via WS and emit MCP notification.

- [ ] **Step 5: Test with Claude Code**

Update `cc` alias to use the plugin:
```bash
alias cc="CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --channels /home/andy/claude-discord-router/plugin"
```

Run `cc` in a test directory. Verify:
1. Daemon starts (or connects to running daemon)
2. Category and channel created in Discord
3. Send message in Discord channel -> Claude receives it
4. Claude replies -> message appears in Discord

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes"
```

---

### Task 8: README and Setup Script

**Files:**
- Create: `README.md`
- Create: `setup.sh`

- [ ] **Step 1: Write README.md**

```markdown
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
bun run daemon/server.ts

# Check if running
cat ~/.config/claude-discord-router/state.json | jq .daemon
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup instructions"
```

Plan complete and saved to `docs/superpowers/plans/2026-04-04-discord-router.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?