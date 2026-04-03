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
      "IMPORTANT: After replying to a Discord message, do NOT output any additional text to the terminal. The reply tool already sent the message — no summary or confirmation is needed. Just call reply and stop.",
      "",
      "The post tool sends a message to this session's Discord channel without needing a chat_id. Use it when you want to proactively share something to Discord.",
      "",
      "reply accepts file paths (files: [\"/abs/path.png\"]) for attachments.",
      "Use react to add emoji reactions, and edit_message for interim progress updates.",
      "fetch_messages pulls real Discord history.",
      "",
      "Conversation mirroring to Discord happens automatically via hooks — you do NOT need to call post for every response.",
    ].join("\n"),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "post",
      description:
        "Post a message to this session's Discord channel. Use this to mirror every conversation turn (user input + your response) to Discord. No chat_id needed — it posts to your session's channel automatically. The channel is created on first use.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to post to Discord." },
        },
        required: ["text"],
      },
    },
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
      case "post": {
        const result = await requestWs({
          type: "post",
          text: args.text as string,
        })
        return { content: [{ type: "text", text: String(result) }] }
      }
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

    const timeoutId = setTimeout(() => reject(new Error("Connection timeout")), 10000)

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
          if (msg.channelId) {
            process.stderr.write(
              `discord-router-plugin: registered as #${msg.channelName} (${msg.channelId})\n`
            )
          } else {
            process.stderr.write(
              `discord-router-plugin: registered (channel will be created on first use)\n`
            )
          }
          clearTimeout(timeoutId)
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
      clearTimeout(timeoutId)
      reject(err)
    }
  })
}

function handleInboundMessage(msg: InboundMessage): void {
  process.stderr.write(`discord-router-plugin: [DEBUG] received inbound: "${msg.content.slice(0, 50)}" from ${msg.user}\n`)
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
  }).then(() => {
    process.stderr.write(`discord-router-plugin: [DEBUG] notification sent OK\n`)
  }).catch(err => {
    process.stderr.write(`discord-router-plugin: [DEBUG] notification FAILED: ${err}\n`)
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
