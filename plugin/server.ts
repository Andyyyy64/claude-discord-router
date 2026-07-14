#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs"
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
const sessionId = process.env.CDR_SESSION_ID ?? randomUUID()
const cwd = process.cwd()
const pinnedChannelId = process.env.CDR_CHANNEL_ID ?? null
const CLAUDE_ACK_REACTION = process.env.CDR_CLAUDE_ACK_REACTION ?? "🧠"

// Write PID → sessionId mapping so the mirror hook can find us
const SESSION_MAP_DIR = `${CONFIG_PATH.replace("/config.json", "")}/plugin-pids`
const pidFile = `${SESSION_MAP_DIR}/${process.ppid}`
mkdirSync(SESSION_MAP_DIR, { recursive: true })
writeFileSync(pidFile, JSON.stringify({ sessionId, cwd }))

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
      'The meta also includes source_chat_id/source_message_id. For direct @stod-agent requests, chat_id may be a created thread while source_chat_id points to the original message channel.',
      "If the Discord message was a reply, meta includes reply_to_* fields and the notification body includes a [Discord reply context] block. Treat Japanese demonstratives like 「これ」「この件」「それ」 as referring to that reply target unless the user says otherwise.",
      "When a request uses 「これ」「この件」「それ」 and no reply_to context is available, fetch Discord history or ask for clarification before creating tasks, editing external systems, sending messages, or taking other side effects.",
      `As soon as you actually receive a Discord request and start handling it, first call react with emoji "${CLAUDE_ACK_REACTION}" on source_chat_id/source_message_id (fallback: chat_id/message_id). This is the Claude-side receipt marker; the router-side marker is separate.`,
      "Reply with the reply tool — pass chat_id back.",
      "For direct @stod-agent requests, chat_id may already be a task/request thread created from the source message. In that case, keep the answer inside that chat_id thread; reply_to is optional.",
      "",
      "IMPORTANT: After replying to a Discord message, do NOT output any additional text to the terminal. The reply tool already sent the message — no summary or confirmation is needed. Just call reply and stop.",
      "",
      "The post tool sends a message to this session's Discord channel without needing a chat_id. Use it when you want to proactively share something to Discord.",
      "",
      "reply accepts file paths (files: [\"/abs/path.png\"]) for attachments.",
        "Use react to add emoji reactions, and edit_message for interim progress updates.",
      "fetch_messages pulls real Discord history. Pass chat_id from the inbound message; channel is accepted only as a legacy alias.",
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
      description: "Fetch recent messages from a Discord channel. Pass chat_id from the inbound message. The legacy channel alias is still accepted at runtime.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string" },
          channel: { type: "string", description: "Legacy alias for chat_id." },
          limit: { type: "number", description: "Max messages (default 20, max 100)." },
        },
        required: ["chat_id"],
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
        const chatId = args.chat_id ?? args.channel
        if (typeof chatId !== "string" || !/^\d{17,20}$/.test(chatId)) {
          return {
            content: [{ type: "text", text: "fetch_messages requires chat_id (Discord snowflake)." }],
            isError: true,
          }
        }
        const result = await requestWs({
          type: "fetch_messages",
          chatId,
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
  // Lazy start daemon (skipped when an external supervisor owns the daemon
  // lifecycle; connect/retry behavior below is unchanged)
  if (process.env.CDR_EXTERNAL_DAEMON === "1") {
    if (!isDaemonRunning()) {
      process.stderr.write("discord-router-plugin: external daemon mode, not running yet — will retry\n")
    }
  } else if (!isDaemonRunning()) {
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
      sendWs({ type: "register", cwd, sessionId, channelId: pinnedChannelId })
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
  const content = formatInboundContent(msg)
  mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId,
        source_chat_id: msg.sourceChatId ?? msg.chatId,
        source_message_id: msg.sourceMessageId ?? msg.messageId,
        user: msg.user,
        user_id: msg.userId,
        ts: msg.ts,
        ...(msg.replyTo
          ? {
              reply_to_chat_id: msg.replyTo.chatId,
              reply_to_message_id: msg.replyTo.messageId,
              reply_to_user: msg.replyTo.user ?? "",
              reply_to_user_id: msg.replyTo.userId ?? "",
              reply_to_ts: msg.replyTo.ts ?? "",
              reply_to_url: msg.replyTo.url ?? "",
              reply_to_content: (msg.replyTo.content ?? "").slice(0, 1000),
            }
          : {}),
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

function formatInboundContent(msg: InboundMessage): string {
  if (!msg.replyTo) return msg.content

  const ref = msg.replyTo
  const lines = [
    "",
    "[Discord reply context]",
    `reply_to_chat_id=${ref.chatId}`,
    `reply_to_message_id=${ref.messageId}`,
    ref.user || ref.userId ? `reply_to_author=${ref.user ?? "unknown"}${ref.userId ? ` (${ref.userId})` : ""}` : "",
    ref.ts ? `reply_to_ts=${ref.ts}` : "",
    ref.url ? `reply_to_url=${ref.url}` : "",
    typeof ref.content === "string"
      ? `reply_to_content=${ref.content || "(empty message)"}`
      : "reply_to_content=(unavailable; fetch_messages using reply_to_chat_id if needed)",
    ref.attachmentCount ? `reply_to_attachments=${ref.attachments?.join("; ") ?? String(ref.attachmentCount)}` : "",
  ].filter(Boolean)

  return `${msg.content}\n${lines.join("\n")}`
}

function handleResult(msg: ResultMessage): void {
  const pending = pendingRequests.get(msg.requestId)
  if (!pending) return
  pendingRequests.delete(msg.requestId)
  if (msg.success) {
    pending.resolve(msg.data)
  } else {
    const detail = msg.error ?? (typeof msg.data === "string" ? msg.data : undefined) ?? "Unknown error"
    pending.reject(new Error(detail))
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
  try { unlinkSync(pidFile) } catch {}
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendWs({ type: "deregister", sessionId })
  }
  setTimeout(() => process.exit(0), 1000)
}

// In external-daemon pinned session mode, Claude's MCP stdio lifecycle can close
// even while the interactive Claude PTY is still visible. Treating stdin close
// as process shutdown deregisters the Discord session before inbound messages
// arrive. Keep the router plugin alive until the owning scope sends SIGTERM/SIGINT.
if (process.env.CDR_EXTERNAL_DAEMON !== "1") {
  process.stdin.on("end", shutdown)
  process.stdin.on("close", shutdown)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
