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
  PostMessage,
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
  process.stderr.write(`discord-router: [DEBUG] message from ${msg.author.username} in channel ${msg.channelId}: "${msg.content.slice(0, 50)}"\n`)
  if (!router.isAllowed(msg.author.id, config)) {
    process.stderr.write(`discord-router: [DEBUG] user ${msg.author.id} not in allowFrom\n`)
    return
  }

  const session = router.getSessionByChannel(msg.channelId)
  if (!session) {
    process.stderr.write(`discord-router: [DEBUG] no session for channel ${msg.channelId}. Active sessions: ${JSON.stringify(router.getAllActiveSessions().map(s => ({ id: s.sessionId.slice(0, 8), ch: s.channelId, cwd: s.cwd })))}\n`)
    return
  }
  process.stderr.write(`discord-router: [DEBUG] routing to session ${session.sessionId.slice(0, 8)} via channel ${session.channelId}\n`)

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

// Ensure session has a channel, creating or reusing one if needed
async function ensureSessionChannel(sessionId: string): Promise<{ channelId: string; channelName: string }> {
  const session = router.getSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  if (session.channelId) return { channelId: session.channelId, channelName: session.channelName! }

  const { cwd } = session
  await ensureCategory(guild, cwd, config, state)
  const category = state.categories[cwd]

  // Try to reuse the most recent inactive channel for this cwd
  let reused = false
  if (category) {
    const inactiveEntries = Object.entries(category.channels)
      .filter(([, ch]) => !ch.active)
      .sort((a, b) => new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime())

    for (const [oldKey, ch] of inactiveEntries) {
      try {
        await client.channels.fetch(ch.channelId)
        // Channel exists, reuse it
        ch.active = true
        // Re-key under new sessionId if needed
        if (oldKey !== sessionId) {
          category.channels[sessionId] = ch
          delete category.channels[oldKey]
        }
        saveState(state)
        router.assignChannel(sessionId, ch.channelId, ch.channelName)
        process.stderr.write(
          `discord-router: session ${sessionId} reusing -> #${ch.channelName} (${ch.channelId})\n`
        )
        reused = true
        return { channelId: ch.channelId, channelName: ch.channelName }
      } catch {
        // Channel deleted on Discord, skip
        delete category.channels[oldKey]
        saveState(state)
      }
    }
  }

  // No reusable channel, create new one
  const channel = await createSessionChannel(guild, cwd, sessionId, state)
  router.assignChannel(sessionId, channel.channelId, channel.channelName)
  process.stderr.write(
    `discord-router: session ${sessionId} created -> #${channel.channelName} (${channel.channelId})\n`
  )
  return { channelId: channel.channelId, channelName: channel.channelName }
}

async function handleRegister(
  ws: ServerWebSocket<{ sessionId: string }>,
  msg: RegisterMessage,
): Promise<void> {
  const { cwd, sessionId } = msg
  ws.data.sessionId = sessionId

  // Register session without channel (lazy creation)
  router.register({
    sessionId,
    cwd,
    channelId: null,
    channelName: null,
    ws,
  })

  process.stderr.write(
    `discord-router: session ${sessionId} registered (pending channel) for ${cwd}\n`
  )

  ws.send(JSON.stringify({
    type: "registered",
    channelId: null,
    channelName: null,
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

async function handlePost(ws: ServerWebSocket<{ sessionId: string }>, msg: PostMessage): Promise<void> {
  const sessionId = ws.data.sessionId
  const { channelId } = await ensureSessionChannel(sessionId)
  const sentIds = await sendToChannel(client, channelId, msg.text)
  ws.send(JSON.stringify({
    type: "result",
    requestId: msg.requestId,
    success: true,
    data: sentIds.length === 1
      ? `sent (id: ${sentIds[0]})`
      : `sent ${sentIds.length} parts (ids: ${sentIds.join(", ")})`,
  }))
}

async function handleClientMessage(
  ws: ServerWebSocket<{ sessionId: string }>,
  raw: string,
): Promise<void> {
  let msg: ClientMessage
  try {
    msg = JSON.parse(raw) as ClientMessage
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }))
    return
  }
  if (!msg.type) {
    ws.send(JSON.stringify({ type: "error", message: "Missing message type" }))
    return
  }
  try {
    switch (msg.type) {
      case "register":
        await handleRegister(ws, msg)
        break
      case "deregister":
        router.deregister(msg.sessionId, state)
        process.stderr.write(`discord-router: session ${msg.sessionId} deregistered\n`)
        break
      case "post":
        await handlePost(ws, msg)
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
  async fetch(req, server) {
    const url = new URL(req.url)

    // HTTP endpoint for hook-based mirroring
    if (url.pathname === "/mirror" && req.method === "POST") {
      try {
        const body = await req.json() as { cwd: string; text: string; sessionId?: string }
        if (!body.text) {
          return new Response("Missing text", { status: 400 })
        }
        // Find session by sessionId (exact) or fallback to cwd (legacy)
        let session
        if (body.sessionId) {
          session = router.getSession(body.sessionId)
        }
        if (!session && body.cwd) {
          const sessions = router.getAllActiveSessions()
          session = sessions.find(s => s.cwd === body.cwd)
        }
        if (!session) {
          return new Response("No active session found", { status: 404 })
        }
        // Ensure channel exists
        const { channelId } = await ensureSessionChannel(session.sessionId)
        await sendToChannel(client, channelId, body.text)
        return new Response("OK", { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`discord-router: mirror error: ${msg}\n`)
        return new Response(msg, { status: 500 })
      }
    }

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
