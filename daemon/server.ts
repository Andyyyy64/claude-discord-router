#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync, renameSync } from "fs"
import { join } from "path"
import { spawn } from "child_process"
import { randomUUID } from "crypto"
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js"
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
  InboundMessage,
  State,
} from "../shared/protocol.ts"
import { INBOX_DIR } from "../shared/protocol.ts"
import { loadConfig, loadState, saveState, ensureConfigDir } from "./config.ts"
import { createDiscordClient, ensureCategory, createSessionChannel, sendToChannel, summarizeTopic, renameChannel } from "./discord.ts"
import { Router } from "./router.ts"

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const RENAME_COOLDOWN_MS = 10 * 60 * 1000 // Discord rate limit: 2 per 10 min
const channelRenameTracker = new Map<string, number>() // channelId -> last rename timestamp
const AUTO_DISPATCH_ENABLED = process.env.CDR_AUTODISPATCH !== "0"
const AUTO_DISPATCH_SCRIPT = process.env.CDR_AUTODISPATCH_SCRIPT ?? "/home/andy/stod-agent/scripts/session-supervisor.sh"
const AUTO_DISPATCH_CWD = process.env.CDR_AUTODISPATCH_CWD ?? "/home/andy/stod-agent"
const AUTO_DISPATCH_SESS_DIR = process.env.CDR_AUTODISPATCH_SESS_DIR ?? "/home/andy/stod-agent/sessions"
const OMISSION_STATE_DIR = process.env.CDR_OMISSION_STATE_DIR ?? "/home/andy/stod-agent/omission/state"
const OMISSION_ROUTE_STATUSES = (process.env.CDR_OMISSION_ROUTE_STATUSES ?? "nagged,awaiting_followup,followup_sent")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
const AUTO_DISPATCH_FLUSH_DELAY_MS = Number(process.env.CDR_AUTODISPATCH_FLUSH_DELAY_MS ?? "1500")
const AUTO_DISPATCH_MENTION_IDS = (process.env.CDR_AUTODISPATCH_MENTION_IDS ?? "1490374657918894174")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
const THREAD_ON_AGENT_MENTION = process.env.CDR_THREAD_ON_AGENT_MENTION !== "0"
const THREAD_ON_AGENT_MENTION_ARCHIVE_MINUTES = Number(process.env.CDR_THREAD_ON_AGENT_MENTION_ARCHIVE_MINUTES ?? "10080")
const SMART_ROUTE_ENABLED = process.env.CDR_SMART_ROUTE !== "0"
const AMBIENT_ROUTE_ENABLED = process.env.CDR_AMBIENT_ROUTE !== "0"
const AMBIENT_JUDGE_ENABLED = process.env.CDR_AMBIENT_JUDGE !== "0"
const AMBIENT_ROUTE_DELAY_MS = Number(process.env.CDR_AMBIENT_ROUTE_DELAY_MS ?? "120000")
const AMBIENT_TYPING_GRACE_MS = Number(process.env.CDR_AMBIENT_TYPING_GRACE_MS ?? "15000")
const AMBIENT_JUDGE_TIMEOUT_MS = Number(process.env.CDR_AMBIENT_JUDGE_TIMEOUT_MS ?? "90000")
const AMBIENT_MIN_REPLY_INTERVAL_MS = Number(process.env.CDR_AMBIENT_MIN_REPLY_INTERVAL_MS ?? "900000")
const AMBIENT_COOLDOWN_MS = Number(process.env.CDR_AMBIENT_COOLDOWN_MS ?? "1800000")
const ACK_ONLY_RE = /^(きた[ー\-\s!！。wｗ]*|来た|了解|りょ|おけ|ok|okay|ありがとう|ありがと|助かる|助かった|なるほど|たしかに|確かに|はい|うん|いいね|確認した|見た|読んだ|草|笑)[\s!！。〜~ーwｗ（笑）🙏👍]*$/i
const DIRECT_FOLLOWUP_RE = /[?？]|(っけ|どう|なに|何|どれ|いつ|誰|どこ|なぜ|なんで|教えて|見て|確認|調べ|お願い|頼む|やって|直して|作って|進め|すすめ|まとめ|ログ|エラー|動いて|生きて|いきて|できる|できた|どうな|どこまで|次|続き|返信|返答|対応|レビュー|実装|修正|原因|状況)/
const NEGATIVE_FEEDBACK_RE = /(やかましい|うるさい|黙って|だまって|喋るな|しゃべるな|話すな|返すな|お前の存在|存在を消す|調教|割り込むな|割り込まないで|邪魔|じゃま)/
const pendingByChannel = new Map<string, InboundMessage[]>()
const WORKLOAD_PRIORITY: Record<string, number> = {
  human_followup: 10,
  human_direct: 20,
  resolver_approved: 30,
  resolver: 40,
  background_deadline: 50,
  background: 60,
}
const pendingWorkloadByChannel = new Map<string, { cls: string; priority: number }>()
const queueNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>()
const queueNoticeSent = new Set<string>()
const ambientPendingByChannel = new Map<string, AmbientPending>()
const dispatchingChannels = new Set<string>()
const pendingDispatchAttempts = new Map<string, number>()
const pendingWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()
const agentRequestThreadChannels = new Set<string>()
const typingUntilByChannel = new Map<string, number>()
const lastHumanMessageIdByChannel = new Map<string, string>()
const ambientCooldownUntilByChannel = new Map<string, number>()
const ambientLastReplyAtByChannel = new Map<string, number>()
const ROUTE_ACK_REACTION = process.env.CDR_ROUTE_ACK_REACTION ?? "👀"
const ROUTE_ACK_ENABLED = process.env.CDR_ROUTE_ACK !== "0" && ROUTE_ACK_REACTION.trim().length > 0
const PENDING_SESSION_WATCHDOG_MS = Number(process.env.CDR_PENDING_SESSION_WATCHDOG_MS ?? "120000")
const PENDING_SESSION_MAX_DISPATCH_ATTEMPTS = Number(process.env.CDR_PENDING_SESSION_MAX_DISPATCH_ATTEMPTS ?? "3")
const SESSION_BLOCKED_CHANNEL_IDS = new Set(
  [
    "1500396185372852315",
    ...(process.env.CDR_SESSION_BLOCKED_CHANNEL_IDS ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
  ]
)
const PENDING_FAILURE_NOTIFY_COOLDOWN_MS = Number(process.env.CDR_PENDING_FAILURE_NOTIFY_COOLDOWN_MS ?? "600000")
const pendingFailureNotifiedAtByChannel = new Map<string, number>()
const OUTBOUND_DEDUPE_ENABLED = process.env.CDR_OUTBOUND_DEDUPE !== "0"
const OUTBOUND_DEDUPE_WINDOW_MS = Number(process.env.CDR_OUTBOUND_DEDUPE_WINDOW_MS ?? "600000")
const recentOutboundByChannel = new Map<string, { at: number; key: string }[]>()
const LOCAL_INJECT_ENABLED = process.env.CDR_LOCAL_INJECT !== "0"

function discordErrorCode(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined
  const record = err as Record<string, any>
  return record.code ?? record.rawError?.code
}

function isDiscordUnknownMessageError(err: unknown): boolean {
  if (discordErrorCode(err) === 10008) return true
  const message = err instanceof Error ? err.message : String(err)
  return message.includes("Unknown Message")
}
const OMISSION_ACTIONS_ENABLED = process.env.CDR_OMISSION_ACTIONS !== "0"
const OMISSION_ACTION_SCRIPT = process.env.CDR_OMISSION_ACTION_SCRIPT ?? "/home/andy/stod-agent/scripts/omission-detector.py"
const OMISSION_ACTION_CWD = process.env.CDR_OMISSION_ACTION_CWD ?? "/home/andy/stod-agent"
const OMISSION_ACTION_PYTHON = process.env.CDR_OMISSION_ACTION_PYTHON ?? "python3"
const OMISSION_ACTION_ALLOW_IDS = (process.env.CDR_OMISSION_ACTION_ALLOW_IDS ?? "609009874625495040")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
const OFFICE_REQUESTS_ENABLED = process.env.CDR_OFFICE_REQUESTS !== "0"
const OFFICE_REQUEST_CONFIG_PATH = process.env.CDR_OFFICE_REQUEST_CONFIG ?? "/home/andy/stod-agent/config/office-requests.json"
const OFFICE_REQUEST_SCRIPT = process.env.CDR_OFFICE_REQUEST_SCRIPT ?? "/home/andy/stod-agent/scripts/office-request-ledger.py"
const OFFICE_REQUEST_CWD = process.env.CDR_OFFICE_REQUEST_CWD ?? "/home/andy/stod-agent"
const OFFICE_REQUEST_PYTHON = process.env.CDR_OFFICE_REQUEST_PYTHON ?? "python3"
const OFFICE_FORM_TTL_MS = Number(process.env.CDR_OFFICE_FORM_TTL_MS ?? "900000")
const RESIDENT_AGENT_APPROVALS_ENABLED = process.env.CDR_RESIDENT_AGENT_APPROVALS !== "0"
const RESIDENT_AGENT_APPROVAL_SCRIPT = process.env.CDR_RESIDENT_AGENT_APPROVAL_SCRIPT ?? "/home/andy/stod-agent/scripts/resident-agent-approval.py"
const RESIDENT_AGENT_APPROVAL_CWD = process.env.CDR_RESIDENT_AGENT_APPROVAL_CWD ?? "/home/andy/stod-agent"
const RESIDENT_AGENT_APPROVAL_PYTHON = process.env.CDR_RESIDENT_AGENT_APPROVAL_PYTHON ?? "python3"
const RESIDENT_AGENT_CONFIG_PATH = process.env.CDR_RESIDENT_AGENT_CONFIG ?? "/home/andy/stod-agent/config/resident-agents.json"
const GITTY_SCOUT_ACTIONS_ENABLED = process.env.CDR_GITTY_SCOUT_ACTIONS !== "0"
const GITTY_SCOUT_ACTION_SCRIPT = process.env.CDR_GITTY_SCOUT_ACTION_SCRIPT ?? "/home/andy/stod-agent/scripts/gitty-scout-discord-action.py"
const GITTY_SCOUT_ACTION_CWD = process.env.CDR_GITTY_SCOUT_ACTION_CWD ?? "/home/andy/stod-agent"
const GITTY_SCOUT_ACTION_PYTHON = process.env.CDR_GITTY_SCOUT_ACTION_PYTHON ?? "python3"
const GITTY_SCOUT_ACTION_ALLOW_IDS = (process.env.CDR_GITTY_SCOUT_ACTION_ALLOW_IDS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
const ASANA_INTAKE_ENABLED = process.env.CDR_ASANA_INTAKE !== "0"
const ASANA_INTAKE_SCRIPT = process.env.CDR_ASANA_INTAKE_SCRIPT ?? "/home/andy/stod-agent/scripts/asana-intake.py"
const ASANA_INTAKE_CONFIG_PATH = process.env.CDR_ASANA_INTAKE_CONFIG ?? "/home/andy/stod-agent/config/asana-intake.json"
const ASANA_INTAKE_CWD = process.env.CDR_ASANA_INTAKE_CWD ?? "/home/andy/stod-agent"
const ASANA_INTAKE_PYTHON = process.env.CDR_ASANA_INTAKE_PYTHON ?? "python3"
const ASANA_SLASH_COMMAND_NAME = process.env.CDR_ASANA_SLASH_COMMAND_NAME ?? "asana"
const ASANA_MESSAGE_CONTEXT_NAME = process.env.CDR_ASANA_MESSAGE_CONTEXT_NAME ?? "Asanaにする"

type RouteResult = {
  delivered: boolean
  queued: boolean
  dispatched: boolean
  reason: string
  sessionId?: string
}

type OmissionResultEntry = {
  text: string
  at: number
}

const omissionResults = new Map<string, OmissionResultEntry>()
const OMISSION_RESULT_TTL_MS = Number(process.env.CDR_OMISSION_RESULT_TTL_MS ?? "600000")
const OMISSION_RESULT_RE = /OMISSION_(?:OBSERVER|JUDGE)_RESULT:[A-Za-z0-9_-]+/
const AMBIENT_RESULT_RE = /AMBIENT_ROUTE_RESULT:[A-Za-z0-9_-]+/
const LOCAL_RESULT_RE = /(?:OMISSION_(?:OBSERVER|JUDGE)_RESULT|AMBIENT_ROUTE_RESULT):[A-Za-z0-9_-]+/

type AmbientPending = {
  inbound: InboundMessage
  content: string
  token: string
  timer: ReturnType<typeof setTimeout>
  createdAt: number
}

type AmbientDecision = {
  decision?: string
  confidence?: number
  reason?: string
  cooldown_seconds?: number
}

type OfficeRequestField = {
  name: string
  label?: string
  type?: string
  required?: boolean
  default?: string
  choices?: Array<string | {
    label?: string
    value?: string
    description?: string
  }>
}

type OfficeRequestTemplate = {
  kind: string
  label?: string
  title?: string
  fields?: OfficeRequestField[]
}

type OfficeRequestConfig = {
  enabled?: boolean
  guildId?: string
  commandName?: string
  commandNameLocalizations?: Record<string, string>
  requestChannelId?: string
  officeUserIds?: string[]
  adminUserIds?: string[]
  mentionOfficeUsers?: boolean
  mentionAdminsForKinds?: string[]
  templates?: OfficeRequestTemplate[]
}

type OfficePendingForm = {
  kind: string
  requesterId: string
  requesterName: string
  submittedChannelId?: string
  interactionId: string
  guildId?: string
  attachment?: Record<string, unknown>
  createdAt: number
}

type OfficeLedgerResult = {
  code: number
  output: string
  json?: any
}

type AsanaIntakeResult = {
  code: number
  output: string
  json?: any
}

const officePendingForms = new Map<string, OfficePendingForm>()

function pruneOmissionResults(): void {
  const now = Date.now()
  const ttl = Number.isFinite(OMISSION_RESULT_TTL_MS) ? OMISSION_RESULT_TTL_MS : 600000
  for (const [marker, entry] of omissionResults.entries()) {
    if (now - entry.at > ttl) omissionResults.delete(marker)
  }
}

function captureOmissionResult(text: unknown): string | null {
  if (typeof text !== "string" || text.length === 0) return null
  const match = text.match(LOCAL_RESULT_RE)
  if (!match) return null
  pruneOmissionResults()
  omissionResults.set(match[0], { text, at: Date.now() })
  return match[0]
}

function outboundDedupeKey(text: string): string {
  const normalized = text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\s+/g, " ")
    .trim()
  const firstLine = text
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .find(Boolean)

  if (firstLine && firstLine.length >= 12) return firstLine.slice(0, 240)
  return normalized.slice(0, 500)
}

function recentOutbound(channelId: string): { at: number; key: string }[] {
  const windowMs = Number.isFinite(OUTBOUND_DEDUPE_WINDOW_MS)
    ? OUTBOUND_DEDUPE_WINDOW_MS
    : 600000
  const now = Date.now()
  const recent = (recentOutboundByChannel.get(channelId) ?? [])
    .filter(entry => now - entry.at <= windowMs)
  recentOutboundByChannel.set(channelId, recent)
  return recent
}

function outboundDuplicateSeen(channelId: string, text: string): boolean {
  if (!OUTBOUND_DEDUPE_ENABLED) return false
  const windowMs = Number.isFinite(OUTBOUND_DEDUPE_WINDOW_MS)
    ? OUTBOUND_DEDUPE_WINDOW_MS
    : 600000
  if (windowMs <= 0) return false

  const key = outboundDedupeKey(text)
  if (!key) return false

  return recentOutbound(channelId).some(entry => entry.key === key)
}

function recordOutbound(channelId: string, text: string): void {
  if (!OUTBOUND_DEDUPE_ENABLED) return
  const key = outboundDedupeKey(text)
  if (!key) return
  const recent = recentOutbound(channelId)
  recent.push({ at: Date.now(), key })
  recentOutboundByChannel.set(channelId, recent.slice(-50))
}

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
  handleDiscordMessage(msg).catch(err => {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: messageCreate error: ${errorMsg}\n`)
  })
})

async function handleDiscordMessage(msg: any): Promise<void> {
  const smokeBotNonce = process.env.CDR_SMOKE_BOT_NONCE ?? ""
  const smokeBotMessage =
    process.env.CDR_SMOKE_ALLOW_BOT === "1" &&
    msg.author.id === client.user?.id &&
    smokeBotNonce.length > 0 &&
    msg.content.includes(smokeBotNonce)
  if (msg.author.bot && !smokeBotMessage) return
  process.stderr.write(`discord-router: [DEBUG] message from ${msg.author.username} in channel ${msg.channelId}: "${msg.content.slice(0, 50)}"\n`)
  recordHumanActivity(msg.channelId, msg.id, msg.content)
  if (!smokeBotMessage && !router.isAllowed(msg.author.id, config)) {
    process.stderr.write(`discord-router: [DEBUG] user ${msg.author.id} not in allowFrom\n`)
    return
  }

  // A Discord reply to the bot's own message addresses the agent, but the ping is NOT an
  // <@id> in the content. discord.js carries the replied-to user in `mentions.repliedUser`
  // (from referenced_message.author) — it is NOT reliably in `mentions.users` on the
  // gateway path. Every routing decision here is content-based, so such replies were
  // silently dropped. Detect a reply-to-agent and normalize it into an explicit inline
  // mention so the existing mention path (thread + ack + dispatch) handles it like a
  // direct @stod-agent mention.
  if (!messageMentionsAgent(msg.content ?? "")) {
    const agentId = client.user?.id
    const mentionIds = [agentId, ...AUTO_DISPATCH_MENTION_IDS].filter(Boolean) as string[]
    // Primary signal: author of the replied-to message (covers reply-ping on AND off).
    let repliedAuthorId: string | undefined =
      msg.mentions?.repliedUser?.id ??
      (agentId && msg.mentions?.users?.has?.(agentId) ? agentId : undefined) ??
      AUTO_DISPATCH_MENTION_IDS.find(mid => msg.mentions?.users?.has?.(mid))
    // Fallback: referenced_message author absent from the gateway payload — fetch it.
    if (!repliedAuthorId && msg.reference?.messageId && typeof msg.fetchReference === "function") {
      try {
        const ref = await msg.fetchReference()
        repliedAuthorId = ref?.author?.id
      } catch {
        // Referenced message unavailable (deleted/forward/cross-channel) — skip.
      }
    }
    if (repliedAuthorId && mentionIds.includes(repliedAuthorId)) {
      const prefixId = agentId ?? AUTO_DISPATCH_MENTION_IDS[0]
      if (prefixId) {
        try {
          msg.content = `<@${prefixId}> ${msg.content ?? ""}`.trimEnd()
          process.stderr.write(`discord-router: normalized reply-mention -> inline mention for message ${msg.id} (replied-to ${repliedAuthorId})\n`)
        } catch (err) {
          // Defensive: if msg.content is ever non-writable, fall through unchanged.
          process.stderr.write(`discord-router: failed to normalize reply-mention for ${msg.id}: ${err}\n`)
        }
      }
    }
  }

  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    const name = (att.name ?? att.id).replace(/[\[\]\r\n;]/g, "_")
    atts.push(`${name} (${att.contentType ?? "unknown"}, ${kb}KB)`)
  }
  const replyTo = await referencedMessageForInbound(msg)
  const inbound: InboundMessage = {
    type: "message",
    chatId: msg.channelId,
    messageId: msg.id,
    sourceChatId: msg.channelId,
    sourceMessageId: msg.id,
    ...(replyTo ? { replyTo } : {}),
    user: msg.author.username,
    userId: msg.author.id,
    content: msg.content || (atts.length > 0 ? "(attachment)" : ""),
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachmentCount: atts.length, attachments: atts } : {}),
  }

  const targetChannelId = await routeTargetForMessage(msg)
  const agentRequestThread = targetChannelId !== msg.channelId || isAgentRequestThreadChannel(targetChannelId, msg.channel)
  if (messageMentionsAgent(msg.content ?? "")) {
    void acknowledgeRoutedMessage(msg)
  }
  if (targetChannelId !== msg.channelId) {
    inbound.chatId = targetChannelId
    recordHumanActivity(targetChannelId, msg.id, msg.content)
  }
  const workloadClass = agentRequestThread && targetChannelId === msg.channelId
    ? "human_followup"
    : "human_direct"
  const result = routeInbound(targetChannelId, msg.content, inbound, {
    agentThread: agentRequestThread,
    workloadClass,
    queuePriority: WORKLOAD_PRIORITY[workloadClass],
  })
  if (
    messageMentionsAgent(msg.content ?? "") ||
    (agentRequestThread && shouldRouteAgentThreadFollowup(msg.content ?? ""))
  ) {
    void acknowledgeRoutedRequest(targetChannelId, result)
  }
}

client.on("typingStart", typing => {
  try {
    if (typing.user?.bot) return
    const channelId = typing.channel?.id
    if (!channelId) return
    const until = Date.now() + (Number.isFinite(AMBIENT_TYPING_GRACE_MS) ? AMBIENT_TYPING_GRACE_MS : 15000)
    typingUntilByChannel.set(channelId, until)
    const pending = ambientPendingByChannel.get(channelId)
    if (pending) {
      process.stderr.write(`discord-router: ambient-route delaying for typing in channel ${channelId}\n`)
      scheduleAmbientTimer(channelId, pending, Math.max(1000, until - Date.now() + 500))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: typingStart error: ${msg}\n`)
  }
})

client.on("interactionCreate", interaction => {
  process.stderr.write(`discord-router: interactionCreate type=${interaction.type} customId=${String((interaction as any).customId || "").slice(0, 160)} user=${interaction.user?.id ?? "unknown"}\n`)
  handleInteraction(interaction).catch(err => {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: interaction error: ${msg}\n`)
  })
})

client.on("raw", packet => {
  if ((packet as any)?.t !== "INTERACTION_CREATE") return
  const data = (packet as any).d ?? {}
  process.stderr.write(`discord-router: raw INTERACTION_CREATE type=${data.type} customId=${String(data.data?.custom_id || data.data?.name || "").slice(0, 160)} user=${data.member?.user?.id || data.user?.id || "unknown"}\n`)
})

client.once("ready", c => {
  process.stderr.write(`discord-router: Discord connected as ${c.user.tag} (resident approvals ${RESIDENT_AGENT_APPROVALS_ENABLED ? "enabled" : "disabled"})\n`)
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
        channelRenameTracker.delete(ch.channelId)
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

  // Externally pinned channel/thread: bypass auto-create AND
  // auto-rename/first-mirror cooldown (an external supervisor owns the
  // channel). Register with the channel pre-assigned + pinned so
  // ensureSessionChannel short-circuits and the rename path is skipped.
  const pinnedChannelId = msg.channelId || sessionRegistryChannelForSession(sessionId)
  if (pinnedChannelId) {
    router.register({
      sessionId,
      cwd,
      channelId: pinnedChannelId,
      channelName: pinnedChannelId,
      pinned: true,
      ws,
    })
    process.stderr.write(
      `discord-router: session ${sessionId} registered (pinned channel ${pinnedChannelId}) for ${cwd}\n`
    )
    ws.send(JSON.stringify({
      type: "registered",
      channelId: pinnedChannelId,
      channelName: pinnedChannelId,
    }))
    touchSessionRegistry(pinnedChannelId)
    schedulePendingFlush(pinnedChannelId)
    return
  }

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

function messageMentionsAgent(content: string): boolean {
  const id = client.user?.id
  if (id && (content.includes(`<@${id}>`) || content.includes(`<@!${id}>`))) return true
  return AUTO_DISPATCH_MENTION_IDS.some(mentionId =>
    content.includes(`<@${mentionId}>`) ||
    content.includes(`<@!${mentionId}>`) ||
    content.includes(`<@&${mentionId}>`)
  )
}

function agentThreadName(content: string, user: string): string {
  const cleaned = content
    .replace(/<@!?\d+>/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const base = cleaned || `${user} request`
  return `[agent] ${base}`.slice(0, 95)
}

function channelIsThread(channel: any): boolean {
  return typeof channel?.isThread === "function" ? Boolean(channel.isThread()) : Boolean(channel?.isThread)
}

function sessionBlockedChannel(channelId: string): boolean {
  return SESSION_BLOCKED_CHANNEL_IDS.has(channelId)
}

function messageUrl(guildId: string | undefined, channelId: string, messageId: string): string | undefined {
  if (!guildId || !/^\d{17,20}$/.test(channelId) || !/^\d{17,20}$/.test(messageId)) return undefined
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

function summarizeAttachments(attachments: any): string[] {
  const values = typeof attachments?.values === "function" ? attachments.values() : Object.values(attachments ?? {})
  const result: string[] = []
  for (const att of values as Iterable<any>) {
    const kb = Number.isFinite(Number(att?.size)) ? (Number(att.size) / 1024).toFixed(0) : "?"
    const name = String(att?.name ?? att?.filename ?? att?.id ?? "attachment").replace(/[\[\]\r\n;]/g, "_")
    result.push(`${name} (${att?.contentType ?? att?.content_type ?? "unknown"}, ${kb}KB)`)
  }
  return result
}

async function referencedMessageForInbound(msg: any): Promise<InboundMessage["replyTo"] | undefined> {
  const refMessageId = msg.reference?.messageId ?? msg.reference?.message_id
  if (!refMessageId) return undefined

  const refChannelId = String(msg.reference?.channelId ?? msg.reference?.channel_id ?? msg.channelId)
  let refMsg = msg.reference?.message ?? msg.referencedMessage ?? null
  if (!refMsg && typeof msg.fetchReference === "function") {
    try {
      refMsg = await msg.fetchReference()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`discord-router: referenced message fetch failed for ${msg.id}: ${errorMsg}\n`)
    }
  }

  const attachments = refMsg ? summarizeAttachments(refMsg.attachments) : []
  const guildId = String(msg.guildId ?? msg.reference?.guildId ?? msg.reference?.guild_id ?? "")
  const url = messageUrl(guildId, refChannelId, String(refMessageId))
  return {
    chatId: refChannelId,
    messageId: String(refMessageId),
    ...(refMsg?.author?.username ? { user: String(refMsg.author.username) } : {}),
    ...(refMsg?.author?.id ? { userId: String(refMsg.author.id) } : {}),
    ...(typeof refMsg?.content === "string" ? { content: refMsg.content } : {}),
    ...(refMsg?.createdAt?.toISOString ? { ts: refMsg.createdAt.toISOString() } : {}),
    ...(url ? { url } : {}),
    ...(attachments.length > 0 ? { attachmentCount: attachments.length, attachments } : {}),
  }
}

async function createThreadForMessage(msg: any, name: string, reason: string): Promise<string> {
  if (channelIsThread(msg.channel)) return msg.channelId
  if (typeof msg.startThread !== "function") return msg.channelId

  try {
    const thread = await msg.startThread({
      name,
      autoArchiveDuration: (Number.isFinite(THREAD_ON_AGENT_MENTION_ARCHIVE_MINUTES)
        ? THREAD_ON_AGENT_MENTION_ARCHIVE_MINUTES
        : 10080) as any,
      reason,
    })
    process.stderr.write(`discord-router: created agent mention thread ${thread.id} from message ${msg.id} in channel ${msg.channelId} (${reason})\n`)
    agentRequestThreadChannels.add(thread.id)
    return thread.id
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: failed to create thread for message ${msg.id}: ${errorMsg}\n`)
    return msg.channelId
  }
}

async function routeTargetForMessage(msg: any): Promise<string> {
  if (!THREAD_ON_AGENT_MENTION) return msg.channelId
  if (sessionBlockedChannel(msg.channelId)) return msg.channelId
  if (!messageMentionsAgent(msg.content ?? "")) return msg.channelId
  if (channelIsThread(msg.channel)) return msg.channelId
  if (typeof msg.startThread !== "function") return msg.channelId

  return createThreadForMessage(
    msg,
    agentThreadName(msg.content ?? "", msg.author?.username ?? "user"),
    "stod-agent direct mention",
  )
}

function isAgentRequestThreadChannel(channelId: string, channel: any): boolean {
  if (agentRequestThreadChannels.has(channelId)) return true
  const name = typeof channel?.name === "string" ? channel.name : ""
  if (name.startsWith("[agent]")) {
    agentRequestThreadChannels.add(channelId)
    return true
  }
  return false
}

async function acknowledgeRoutedMessage(msg: any): Promise<void> {
  if (!ROUTE_ACK_ENABLED) return
  if (typeof msg.react !== "function") return
  try {
    await msg.react(ROUTE_ACK_REACTION)
    process.stderr.write(`discord-router: acknowledged message ${msg.id} with ${ROUTE_ACK_REACTION}\n`)
  } catch (err) {
    if (isDiscordUnknownMessageError(err)) {
      process.stderr.write(`discord-router: skipped acknowledgement; message disappeared channel=${msg.channelId} message=${msg.id}\n`)
      return
    }
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: failed to acknowledge message ${msg.id}: ${errorMsg}\n`)
  }
}

function sessionRegistryExists(channelId: string): boolean {
  return existsSync(join(AUTO_DISPATCH_SESS_DIR, `${channelId}.json`))
}

function sessionRegistryStatus(channelId: string): string {
  const path = join(AUTO_DISPATCH_SESS_DIR, `${channelId}.json`)
  if (!existsSync(path)) return ""
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    return typeof state.status === "string" ? state.status : ""
  } catch {
    return ""
  }
}

function sessionRegistryChannelForSession(sessionId: string): string {
  if (!existsSync(AUTO_DISPATCH_SESS_DIR)) return ""
  try {
    for (const file of readdirSync(AUTO_DISPATCH_SESS_DIR)) {
      if (!file.endsWith(".json")) continue
      try {
        const state = JSON.parse(readFileSync(join(AUTO_DISPATCH_SESS_DIR, file), "utf8")) as Record<string, unknown>
        const threadId = typeof state.thread_id === "string" ? state.thread_id : file.replace(/\.json$/, "")
        if (state.session_uuid === sessionId && /^\d{17,20}$/.test(threadId)) return threadId
      } catch {
        // Ignore one bad registry file; session-supervisor owns validation.
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: failed to scan session registry for ${sessionId}: ${msg}\n`)
  }
  return ""
}

function touchSessionRegistry(channelId: string): void {
  const path = join(AUTO_DISPATCH_SESS_DIR, `${channelId}.json`)
  if (!existsSync(path)) return
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    state.last_activity = Math.floor(Date.now() / 1000)
    const tmp = join(AUTO_DISPATCH_SESS_DIR, `.tmp.${channelId}.${process.pid}.${Date.now()}`)
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: failed to touch session registry ${channelId}: ${msg}\n`)
  }
}

function omissionOpenStateExists(channelId: string): boolean {
  if (!existsSync(OMISSION_STATE_DIR)) return false
  try {
    for (const file of readdirSync(OMISSION_STATE_DIR)) {
      if (!file.endsWith(".json")) continue
      try {
        const state = JSON.parse(readFileSync(join(OMISSION_STATE_DIR, file), "utf8")) as {
          thread_id?: string
          status?: string
        }
        if (state.thread_id === channelId && state.status && OMISSION_ROUTE_STATUSES.includes(state.status)) {
          return true
        }
      } catch {
        // Ignore one bad state file; omission-detector owns validation.
      }
    }
  } catch (err) {
    process.stderr.write(`discord-router: omission state scan failed: ${err}\n`)
  }
  return false
}

function shouldRouteNonMention(content: string): boolean {
  if (!SMART_ROUTE_ENABLED) return true
  const normalized = content.trim()
  if (!normalized) return false
  if (ACK_ONLY_RE.test(normalized)) return false
  return DIRECT_FOLLOWUP_RE.test(normalized)
}

function shouldRouteToSession(content: string): boolean {
  return messageMentionsAgent(content) || shouldRouteNonMention(content)
}

function shouldRouteAgentThreadFollowup(content: string): boolean {
  const normalized = content.trim()
  if (!normalized) return false
  return !ACK_ONLY_RE.test(normalized)
}

function shouldAutoDispatch(channelId: string, content: string): boolean {
  if (!AUTO_DISPATCH_ENABLED) return false
  if (sessionBlockedChannel(channelId)) return false
  return messageMentionsAgent(content) ||
    ((sessionRegistryExists(channelId) || omissionOpenStateExists(channelId)) && shouldRouteNonMention(content))
}

function recordHumanActivity(channelId: string, messageId: string, content: string): void {
  lastHumanMessageIdByChannel.set(channelId, messageId)
  const pending = ambientPendingByChannel.get(channelId)
  if (pending && pending.inbound.messageId !== messageId) {
    clearTimeout(pending.timer)
    ambientPendingByChannel.delete(channelId)
    process.stderr.write(`discord-router: ambient-route canceled for channel ${channelId}: newer human message\n`)
  }
  if (NEGATIVE_FEEDBACK_RE.test(content)) {
    const until = Date.now() + (Number.isFinite(AMBIENT_COOLDOWN_MS) ? AMBIENT_COOLDOWN_MS : 1800000)
    ambientCooldownUntilByChannel.set(channelId, until)
    const active = ambientPendingByChannel.get(channelId)
    if (active) {
      clearTimeout(active.timer)
      ambientPendingByChannel.delete(channelId)
    }
    process.stderr.write(`discord-router: ambient-route cooldown for channel ${channelId} after negative feedback\n`)
  }
}

function isAmbientCoolingDown(channelId: string): boolean {
  const until = ambientCooldownUntilByChannel.get(channelId) ?? 0
  return until > Date.now()
}

function ambientReplyTooRecent(channelId: string): boolean {
  const last = ambientLastReplyAtByChannel.get(channelId) ?? 0
  const interval = Number.isFinite(AMBIENT_MIN_REPLY_INTERVAL_MS) ? AMBIENT_MIN_REPLY_INTERVAL_MS : 900000
  return last > 0 && Date.now() - last < interval
}

function shouldConsiderAmbient(content: string, channelId: string): boolean {
  if (!AMBIENT_ROUTE_ENABLED) return false
  if (messageMentionsAgent(content)) return false
  if (isAmbientCoolingDown(channelId)) return false
  if (ambientReplyTooRecent(channelId)) return false
  return shouldRouteNonMention(content)
}

function scheduleAmbientTimer(channelId: string, pending: AmbientPending, delayMs?: number): void {
  clearTimeout(pending.timer)
  const delay = Math.max(0, delayMs ?? (Number.isFinite(AMBIENT_ROUTE_DELAY_MS) ? AMBIENT_ROUTE_DELAY_MS : 120000))
  pending.timer = setTimeout(() => {
    void processAmbientCandidate(channelId, pending.token)
  }, delay)
  ambientPendingByChannel.set(channelId, pending)
}

function scheduleAmbientCandidate(channelId: string, content: string, inbound: InboundMessage): RouteResult {
  const old = ambientPendingByChannel.get(channelId)
  if (old) clearTimeout(old.timer)
  const token = randomUUID()
  const pending: AmbientPending = {
    inbound,
    content,
    token,
    timer: setTimeout(() => undefined, 0),
    createdAt: Date.now(),
  }
  scheduleAmbientTimer(channelId, pending)
  process.stderr.write(`discord-router: ambient-route scheduled for channel ${channelId} message ${inbound.messageId}\n`)
  return { delivered: false, queued: true, dispatched: false, reason: "ambient_scheduled" }
}

async function processAmbientCandidate(channelId: string, token: string): Promise<void> {
  const pending = ambientPendingByChannel.get(channelId)
  if (!pending || pending.token !== token) return
  if (isAmbientCoolingDown(channelId)) {
    ambientPendingByChannel.delete(channelId)
    process.stderr.write(`discord-router: ambient-route skipped for channel ${channelId}: cooldown\n`)
    return
  }
  if (ambientReplyTooRecent(channelId)) {
    ambientPendingByChannel.delete(channelId)
    process.stderr.write(`discord-router: ambient-route skipped for channel ${channelId}: recent bot reply\n`)
    return
  }
  if (lastHumanMessageIdByChannel.get(channelId) !== pending.inbound.messageId) {
    ambientPendingByChannel.delete(channelId)
    process.stderr.write(`discord-router: ambient-route skipped for channel ${channelId}: conversation moved on\n`)
    return
  }
  const typingUntil = typingUntilByChannel.get(channelId) ?? 0
  if (typingUntil > Date.now()) {
    scheduleAmbientTimer(channelId, pending, Math.max(1000, typingUntil - Date.now() + 500))
    return
  }
  ambientPendingByChannel.delete(channelId)
  if (!AMBIENT_JUDGE_ENABLED) {
    deliverToSession(channelId, pending.inbound, "ambient")
    return
  }
  try {
    const decision = await runAmbientJudge(channelId, pending.inbound)
    const d = String(decision.decision ?? "silent")
    if (decision.cooldown_seconds && Number(decision.cooldown_seconds) > 0) {
      ambientCooldownUntilByChannel.set(channelId, Date.now() + Number(decision.cooldown_seconds) * 1000)
    }
    if (d === "answer_short" || d === "answer_with_context") {
      deliverToSession(channelId, buildAmbientAnswerInbound(pending.inbound, decision), `ambient-${d}`)
      return
    }
    process.stderr.write(`discord-router: ambient-route silent for channel ${channelId}: ${d} ${(decision.reason ?? "").slice(0, 120)}\n`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: ambient-route judge failed for channel ${channelId}: ${msg}\n`)
  }
}

function deliverToSession(
  channelId: string,
  inbound: InboundMessage,
  source: string,
  workloadClass = "background",
  queuePriority = WORKLOAD_PRIORITY.background,
): RouteResult {
  if (sessionBlockedChannel(channelId)) {
    process.stderr.write(`discord-router: skipped ${source} session routing for reserved channel ${channelId}\n`)
    return { delivered: false, queued: false, dispatched: false, reason: `${source}_session_blocked_channel` }
  }
  const session = router.getSessionByChannel(channelId)
  if (!session) {
    enqueuePending(channelId, inbound)
    startAutoDispatch(channelId, workloadClass, queuePriority)
    return { delivered: false, queued: true, dispatched: true, reason: `${source}_queued_for_dispatch` }
  }
  process.stderr.write(`discord-router: [DEBUG] routing ${source} message to session ${session.sessionId.slice(0, 8)} via channel ${session.channelId}\n`)
  router.sendToSession(channelId, inbound)
  touchSessionRegistry(channelId)
  return { delivered: true, queued: false, dispatched: false, reason: "delivered", sessionId: session.sessionId }
}

async function waitForSession(channelId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (router.getSessionByChannel(channelId)) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`session not available for channel ${channelId}`)
}

async function fetchRecentContext(channelId: string): Promise<string> {
  try {
    const channel = await client.channels.fetch(channelId)
    if (!channel?.isTextBased() || !("messages" in channel)) return "(recent messages unavailable)"
    const msgs = await (channel as any).messages.fetch({ limit: 25 })
    const me = client.user?.id
    return [...msgs.values()].reverse().map((m: any) => {
      const who = m.author?.id === me ? "stod-agent" : (m.author?.username ?? m.author?.id ?? "unknown")
      const text = String(m.content ?? "").replace(/[\r\n]+/g, " / ").slice(0, 500)
      return `[${m.createdAt?.toISOString?.() ?? ""}] ${who}: ${text}`
    }).join("\n")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `(recent messages unavailable: ${msg})`
  }
}

function buildAmbientJudgePrompt(marker: string, inbound: InboundMessage, recentContext: string): string {
  return `これは stod-agent router の内部 ambient_intervention_judge です。Discord user への返答ではありません。
目的: 全チャンネルを横で見守る社内文脈アシスタントとして、この非メンション発言に今この場で返答すべきかを判定する。

重要:
- 直接 @stod-agent されていない発言だけが対象。人間同士の会話を奪わない。
- 返答してよいのは、社内事実・日程・資料所在・過去経緯など、stod-agent が人間より速く正確に補完でき、会話が自然に前へ進む時だけ。
- 誰か特定の人の意思決定・感想・担当可否を聞いている時は原則 silent。
- 雑談、相槌、bot への苦情、メタ発言、「やかましい/邪魔/喋るな/調教が必要」系は silent。必要なら cooldown_seconds を入れる。
- 直近文脈に人間の回答が既にある、または誰かが答えそうな流れなら silent。
- answer_short を選ぶ時でも、実際の返答は後続の通常 session に任せる。この判定では絶対に本文回答しない。
- Discord の reply tool を使い、次の marker と JSON だけを reply する。router は marker 付き reply を local capture し Discord には投稿しない。
- post/edit/react tool は使わない。余計な説明は禁止。

${marker}
{"decision":"silent|answer_short|answer_with_context|watch","confidence":0.0,"reason":"短い理由","cooldown_seconds":0}

対象発言:
- channel_id=${inbound.chatId}
- message_id=${inbound.messageId}
- author=${inbound.user} (${inbound.userId})
- content=${inbound.content}

recent messages:
${recentContext}`
}

function parseAmbientDecision(text: string, marker: string): AmbientDecision {
  const idx = text.indexOf(marker)
  const rest = idx >= 0 ? text.slice(idx + marker.length) : text
  const start = rest.indexOf("{")
  const end = rest.lastIndexOf("}")
  if (start < 0 || end < start) return { decision: "silent", confidence: 0, reason: "ambient judge returned no JSON" }
  try {
    return JSON.parse(rest.slice(start, end + 1)) as AmbientDecision
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { decision: "silent", confidence: 0, reason: `ambient judge JSON parse failed: ${msg}` }
  }
}

function buildAmbientAnswerInbound(inbound: InboundMessage, decision: AmbientDecision): InboundMessage {
  const answerMode = decision.decision === "answer_with_context"
    ? "必要なら fetch_messages や社内ツールで追加確認してよいが、発言は短く実務的にまとめる"
    : "原則 1〜3 文で短く答える。余計な提案や長い経緯説明は足さない"
  const confidence = typeof decision.confidence === "number" ? decision.confidence.toFixed(2) : "unknown"
  return {
    ...inbound,
    user: "ambient-router",
    userId: "ambient-router",
    content: `これは stod-agent router からの ambient answer 指示です。Discord にこのまま表示する文章ではありません。

背景:
- 元発言は直接 @stod-agent されていないが、ambient judge が「今なら横から答える価値がある」と判断した。
- judge confidence=${confidence}
- judge reason=${decision.reason ?? ""}

返答ルール:
- Discord reply tool を使い、必ず reply_to="${inbound.messageId}" で元発言に返信する。
- ${answerMode}。
- 人間の意思決定・担当可否・感想を横取りしない。判断が必要なら「確認が必要そう」と短く返す。
- 追加確認して解決済み/不要と分かった場合は、Discord には投稿せず、AMBIENT_ROUTE_RESULT:NOOP {"decision":"silent","reason":"answered by context"} だけを reply tool で返す。
- post tool は使わない。

元発言:
- channel_id=${inbound.chatId}
- message_id=${inbound.messageId}
- author=${inbound.user} (${inbound.userId})
- content=${inbound.content}`,
  }
}

async function waitLocalResult(marker: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    pruneOmissionResults()
    const entry = omissionResults.get(marker)
    if (entry) {
      omissionResults.delete(marker)
      return entry.text
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`local result timeout for ${marker}`)
}

async function runAmbientJudge(channelId: string, inbound: InboundMessage): Promise<AmbientDecision> {
  if (!router.getSessionByChannel(channelId)) {
    startAutoDispatch(channelId)
    await waitForSession(channelId, 45000)
  }
  const marker = `AMBIENT_ROUTE_RESULT:${randomUUID().replace(/-/g, "").slice(0, 12)}`
  const recent = await fetchRecentContext(channelId)
  const prompt = buildAmbientJudgePrompt(marker, inbound, recent)
  const judgeInbound: InboundMessage = {
    type: "message",
    chatId: channelId,
    messageId: `local-ambient-${Date.now()}`,
    user: "ambient-router",
    userId: "ambient-router",
    content: prompt,
    ts: new Date().toISOString(),
  }
  const session = router.getSessionByChannel(channelId)
  if (!session) throw new Error(`session disappeared for channel ${channelId}`)
  router.sendToSession(channelId, judgeInbound)
  const timeout = Number.isFinite(AMBIENT_JUDGE_TIMEOUT_MS) ? AMBIENT_JUDGE_TIMEOUT_MS : 90000
  const text = await waitLocalResult(marker, timeout)
  return parseAmbientDecision(text, marker)
}

function routeInbound(
  channelId: string,
  content: string,
  inbound: InboundMessage,
  opts: {
    forceDispatch?: boolean
    forceRoute?: boolean
    source?: string
    agentThread?: boolean
    workloadClass?: string
    queuePriority?: number
  } = {},
): RouteResult {
  if (sessionBlockedChannel(channelId)) {
    process.stderr.write(`discord-router: skipped inbound session routing for reserved channel ${channelId}\n`)
    return { delivered: false, queued: false, dispatched: false, reason: "session_blocked_channel" }
  }
  const session = router.getSessionByChannel(channelId)
  const mentionsAgent = messageMentionsAgent(content)
  const agentThreadFollowup = Boolean(opts.agentThread) && shouldRouteAgentThreadFollowup(content)
  const workloadClass = opts.workloadClass ?? (mentionsAgent ? "human_direct" : "background")
  const queuePriority = Number.isFinite(opts.queuePriority)
    ? Number(opts.queuePriority)
    : (WORKLOAD_PRIORITY[workloadClass] ?? WORKLOAD_PRIORITY.background)
  if (!session) {
    process.stderr.write(`discord-router: [DEBUG] no session for channel ${channelId}. Active sessions: ${JSON.stringify(router.getAllActiveSessions().map(s => ({ id: s.sessionId.slice(0, 8), ch: s.channelId, cwd: s.cwd })))}\n`)
    if (opts.forceDispatch || mentionsAgent || agentThreadFollowup) {
      enqueuePending(channelId, inbound)
      startAutoDispatch(channelId, workloadClass, queuePriority)
      return { delivered: false, queued: true, dispatched: true, reason: "queued_for_dispatch" }
    }
    if (!opts.forceDispatch && shouldConsiderAmbient(content, channelId)) {
      return scheduleAmbientCandidate(channelId, content, inbound)
    }
    if (!AMBIENT_ROUTE_ENABLED && shouldAutoDispatch(channelId, content)) {
      enqueuePending(channelId, inbound)
      startAutoDispatch(channelId, workloadClass, queuePriority)
      return { delivered: false, queued: true, dispatched: true, reason: "queued_for_dispatch" }
    }
    return { delivered: false, queued: false, dispatched: false, reason: "no_session" }
  }
  if (opts.forceRoute || mentionsAgent || agentThreadFollowup) {
    return deliverToSession(channelId, inbound, opts.source ?? "discord", workloadClass, queuePriority)
  }
  if (!opts.forceRoute && shouldConsiderAmbient(content, channelId)) {
    return scheduleAmbientCandidate(channelId, content, inbound)
  }
  if (!opts.forceRoute && !shouldRouteToSession(content)) {
    process.stderr.write(`discord-router: [DEBUG] smart-route ignored non-addressed message for channel ${channelId}: "${content.slice(0, 50)}"\n`)
    return { delivered: false, queued: false, dispatched: false, reason: "smart_route_ignored", sessionId: session.sessionId }
  }
  if (AMBIENT_ROUTE_ENABLED) {
    process.stderr.write(`discord-router: [DEBUG] ambient-route suppressed message for channel ${channelId}: "${content.slice(0, 50)}"\n`)
    return { delivered: false, queued: false, dispatched: false, reason: "ambient_suppressed", sessionId: session.sessionId }
  }
  return deliverToSession(channelId, inbound, opts.source ?? "discord", workloadClass, queuePriority)
}

function enqueuePending(channelId: string, msg: InboundMessage): void {
  const list = pendingByChannel.get(channelId) ?? []
  list.push(msg)
  // Keep this bounded: one cold-start burst should not become an unbounded inbox.
  if (list.length > 20) list.splice(0, list.length - 20)
  pendingByChannel.set(channelId, list)
  const maxAttempts = maxPendingDispatchAttempts()
  if ((pendingDispatchAttempts.get(channelId) ?? 0) > maxAttempts) {
    pendingDispatchAttempts.delete(channelId)
  }
  process.stderr.write(`discord-router: queued initial message for channel ${channelId} pending=${list.length}\n`)
  schedulePendingWatchdog(channelId)
}

function normalizeWorkload(cls: string, priority: number): { cls: string; priority: number } {
  const normalizedClass = Object.prototype.hasOwnProperty.call(WORKLOAD_PRIORITY, cls) ? cls : "background"
  return {
    cls: normalizedClass,
    priority: Number.isFinite(priority) ? Math.max(0, Math.floor(priority)) : WORKLOAD_PRIORITY[normalizedClass],
  }
}

function startAutoDispatch(
  channelId: string,
  workloadClass = "background",
  queuePriority = WORKLOAD_PRIORITY.background,
): void {
  if (sessionBlockedChannel(channelId)) {
    process.stderr.write(`discord-router: auto-dispatch blocked for reserved channel ${channelId}\n`)
    return
  }
  if (dispatchingChannels.has(channelId)) return
  const workload = normalizeWorkload(workloadClass, queuePriority)
  const previous = pendingWorkloadByChannel.get(channelId)
  if (!previous || workload.priority < previous.priority) {
    pendingWorkloadByChannel.set(channelId, workload)
  }
  const selected = pendingWorkloadByChannel.get(channelId) ?? workload
  dispatchingChannels.add(channelId)
  if (pendingByChannel.has(channelId)) {
    pendingDispatchAttempts.set(channelId, (pendingDispatchAttempts.get(channelId) ?? 0) + 1)
  }
  process.stderr.write(`discord-router: auto-dispatch spawning session for channel ${channelId} class=${selected.cls} priority=${selected.priority}\n`)
  const cls = selected.cls
  const priority = selected.priority
  const child = spawn("bash", [AUTO_DISPATCH_SCRIPT, "dispatch", channelId, AUTO_DISPATCH_CWD, cls, String(priority)], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SESS_DIR: AUTO_DISPATCH_SESS_DIR,
    },
  })
  child.on("exit", code => {
    dispatchingChannels.delete(channelId)
    if (code !== 0) {
      process.stderr.write(`discord-router: auto-dispatch failed for channel ${channelId} rc=${code}\n`)
    }
  })
  child.unref()
}

function pendingWatchdogDelayMs(): number {
  return Number.isFinite(PENDING_SESSION_WATCHDOG_MS) && PENDING_SESSION_WATCHDOG_MS > 0
    ? PENDING_SESSION_WATCHDOG_MS
    : 120000
}

function maxPendingDispatchAttempts(): number {
  return Number.isFinite(PENDING_SESSION_MAX_DISPATCH_ATTEMPTS) && PENDING_SESSION_MAX_DISPATCH_ATTEMPTS > 0
    ? PENDING_SESSION_MAX_DISPATCH_ATTEMPTS
    : 3
}

function clearPendingWatchdog(channelId: string): void {
  const timer = pendingWatchdogs.get(channelId)
  if (timer) clearTimeout(timer)
  pendingWatchdogs.delete(channelId)
}

function schedulePendingWatchdog(channelId: string): void {
  if (!pendingByChannel.has(channelId)) return
  clearPendingWatchdog(channelId)
  const timer = setTimeout(() => {
    void checkPendingDispatch(channelId)
  }, pendingWatchdogDelayMs())
  pendingWatchdogs.set(channelId, timer)
}

async function checkPendingDispatch(channelId: string): Promise<void> {
  const pending = pendingByChannel.get(channelId)
  if (!pending || pending.length === 0) {
    clearPendingWatchdog(channelId)
    pendingDispatchAttempts.delete(channelId)
    return
  }
  if (sessionBlockedChannel(channelId)) {
    clearPendingWatchdog(channelId)
    pendingDispatchAttempts.delete(channelId)
    pendingByChannel.delete(channelId)
    process.stderr.write(`discord-router: dropped pending messages for reserved channel ${channelId}\n`)
    return
  }
  if (router.getSessionByChannel(channelId)) {
    clearPendingWatchdog(channelId)
    flushPending(channelId)
    return
  }
  if (dispatchingChannels.has(channelId)) {
    schedulePendingWatchdog(channelId)
    return
  }

  const registryStatus = sessionRegistryStatus(channelId)
  if (registryStatus === "queued" || registryStatus === "spawning") {
    process.stderr.write(`discord-router: pending watchdog waiting for channel ${channelId} registry=${registryStatus} pending=${pending.length}\n`)
    const workload = pendingWorkloadByChannel.get(channelId)
    startAutoDispatch(
      channelId,
      workload?.cls ?? "background",
      workload?.priority ?? WORKLOAD_PRIORITY.background,
    )
    schedulePendingWatchdog(channelId)
    return
  }

  const attempts = pendingDispatchAttempts.get(channelId) ?? 0
  const maxAttempts = maxPendingDispatchAttempts()
  if (attempts < maxAttempts) {
    process.stderr.write(`discord-router: pending watchdog retry ${attempts + 1}/${maxAttempts} for channel ${channelId} pending=${pending.length}\n`)
    const workload = pendingWorkloadByChannel.get(channelId)
    startAutoDispatch(
      channelId,
      workload?.cls ?? "background",
      workload?.priority ?? WORKLOAD_PRIORITY.background,
    )
    schedulePendingWatchdog(channelId)
    return
  }

  clearPendingWatchdog(channelId)
  pendingDispatchAttempts.set(channelId, maxAttempts + 1)
  pendingByChannel.delete(channelId)
  pendingWorkloadByChannel.delete(channelId)
  const cooldownMs = Number.isFinite(PENDING_FAILURE_NOTIFY_COOLDOWN_MS)
    ? PENDING_FAILURE_NOTIFY_COOLDOWN_MS
    : 600000
  const lastNotifiedAt = pendingFailureNotifiedAtByChannel.get(channelId) ?? 0
  if (cooldownMs > 0 && lastNotifiedAt > 0 && Date.now() - lastNotifiedAt < cooldownMs) {
    process.stderr.write(`discord-router: pending watchdog notification suppressed for channel ${channelId} by cooldown\n`)
    return
  }
  process.stderr.write(`discord-router: pending watchdog failed for channel ${channelId} after ${attempts} dispatch attempt(s); notifying channel\n`)
  try {
    const sentIds = await sendToChannel(
      client,
      channelId,
      "⚠️ stod-agent の Claude Code session 起動に失敗しました。スレッドは作成済みですが、処理が始まっていません。もう一度メンションしてください。"
    )
    pendingFailureNotifiedAtByChannel.set(channelId, Date.now())
    recordOutbound(channelId, "pending session failed")
    process.stderr.write(`discord-router: pending watchdog notified channel ${channelId} ids=${sentIds.join(",")}\n`)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: pending watchdog notify failed for channel ${channelId}: ${errorMsg}\n`)
  }
}

function schedulePendingFlush(channelId: string): void {
  if (!pendingByChannel.has(channelId)) return
  setTimeout(() => flushPending(channelId), Number.isFinite(AUTO_DISPATCH_FLUSH_DELAY_MS) ? AUTO_DISPATCH_FLUSH_DELAY_MS : 1500)
}

function flushPending(channelId: string): void {
  const pending = pendingByChannel.get(channelId)
  if (!pending || pending.length === 0) return
  const session = router.getSessionByChannel(channelId)
  if (!session) return
  pendingByChannel.delete(channelId)
  pendingWorkloadByChannel.delete(channelId)
  clearPendingWatchdog(channelId)
  pendingDispatchAttempts.delete(channelId)
  process.stderr.write(`discord-router: flushing ${pending.length} pending message(s) to session ${session.sessionId.slice(0, 8)} channel ${channelId}\n`)
  for (const msg of pending) {
    router.sendToSession(channelId, msg)
  }
  const noticeTimer = queueNoticeTimers.get(channelId)
  if (noticeTimer) clearTimeout(noticeTimer)
  queueNoticeTimers.delete(channelId)
  if (queueNoticeSent.delete(channelId)) {
    void sendToChannel(client, channelId, "待機を終え、処理を開始しました。").catch(err => {
      process.stderr.write(`discord-router: queue start notice failed for channel ${channelId}: ${err}\n`)
    })
  }
  touchSessionRegistry(channelId)
}

function queuedPosition(channelId: string): number | null {
  if (!existsSync(AUTO_DISPATCH_SESS_DIR)) return null
  const rows: Array<{ threadId: string; priority: number; queuedAt: number }> = []
  try {
    for (const file of readdirSync(AUTO_DISPATCH_SESS_DIR)) {
      if (!file.endsWith(".json")) continue
      try {
        const state = JSON.parse(readFileSync(join(AUTO_DISPATCH_SESS_DIR, file), "utf8")) as Record<string, unknown>
        if (state.status !== "queued") continue
        rows.push({
          threadId: String(state.thread_id ?? file.replace(/\.json$/, "")),
          priority: Number(state.queue_priority ?? WORKLOAD_PRIORITY.background),
          queuedAt: Number(state.queued_at ?? 0),
        })
      } catch {
        // Ignore one malformed registry entry.
      }
    }
  } catch {
    return null
  }
  rows.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt || a.threadId.localeCompare(b.threadId))
  const index = rows.findIndex(row => row.threadId === channelId)
  return index >= 0 ? index + 1 : null
}

async function acknowledgeRoutedRequest(channelId: string, result: RouteResult): Promise<void> {
  const text = result.delivered
    ? "受け付けました。処理を開始します。"
    : "受け付けました。Claude Code sessionを起動しています。"
  try {
    await sendToChannel(client, channelId, text)
  } catch (err) {
    process.stderr.write(`discord-router: textual acknowledgement failed for channel ${channelId}: ${err}\n`)
    return
  }
  if (!result.queued) return
  const old = queueNoticeTimers.get(channelId)
  if (old) clearTimeout(old)
  const timer = setTimeout(() => {
    queueNoticeTimers.delete(channelId)
    const status = sessionRegistryStatus(channelId)
    if (status === "queued") {
      const position = queuedPosition(channelId)
      const suffix = position ? `${position}番目です。` : "確認中です。"
      queueNoticeSent.add(channelId)
      void sendToChannel(client, channelId, `まだ開始待ちです。現在の待ち順は${suffix}`).catch(err => {
        process.stderr.write(`discord-router: queue position notice failed for channel ${channelId}: ${err}\n`)
      })
    } else if (status === "spawning" && !router.getSessionByChannel(channelId)) {
      queueNoticeSent.add(channelId)
      void sendToChannel(client, channelId, "Claude Code sessionを起動中です。開始まで少しお待ちください。").catch(err => {
        process.stderr.write(`discord-router: startup notice failed for channel ${channelId}: ${err}\n`)
      })
    }
  }, 30000)
  queueNoticeTimers.set(channelId, timer)
}

function loadOfficeRequestConfig(): OfficeRequestConfig | null {
  try {
    const data = JSON.parse(readFileSync(OFFICE_REQUEST_CONFIG_PATH, "utf8"))
    return data && typeof data === "object" ? data as OfficeRequestConfig : null
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: office request config load failed: ${errorMsg}\n`)
    return null
  }
}

function officeRequestEnabled(config: OfficeRequestConfig | null): boolean {
  return OFFICE_REQUESTS_ENABLED && !!config && config.enabled !== false
}

function officeTemplatesByKind(config: OfficeRequestConfig): Map<string, OfficeRequestTemplate> {
  const out = new Map<string, OfficeRequestTemplate>()
  for (const template of config.templates ?? []) {
    if (template?.kind) out.set(String(template.kind), template)
  }
  return out
}

function pruneOfficePendingForms(): void {
  const now = Date.now()
  const ttl = Number.isFinite(OFFICE_FORM_TTL_MS) ? OFFICE_FORM_TTL_MS : 900000
  for (const [nonce, pending] of officePendingForms.entries()) {
    if (now - pending.createdAt > ttl) officePendingForms.delete(nonce)
  }
}

function officeCommandNames(config: OfficeRequestConfig): Set<string> {
  const names = new Set<string>([config.commandName || "office-request"])
  for (const name of Object.values(config.commandNameLocalizations ?? {})) {
    if (name) names.add(name)
  }
  return names
}

function runAsanaIntake(args: string[], input?: string): Promise<AsanaIntakeResult> {
  return new Promise(resolve => {
    const child = spawn(ASANA_INTAKE_PYTHON, [ASANA_INTAKE_SCRIPT, ...args], {
      cwd: ASANA_INTAKE_CWD,
      env: {
        ...process.env,
        ASANA_INTAKE_CONFIG: ASANA_INTAKE_CONFIG_PATH,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout?.on("data", data => { out += String(data) })
    child.stderr?.on("data", data => { err += String(data) })
    child.on("error", e => resolve({ code: 127, output: e.message }))
    child.on("close", code => {
      const output = (out + err).trim()
      let parsed: any
      try {
        parsed = out.trim() ? JSON.parse(out) : undefined
      } catch {
        parsed = undefined
      }
      resolve({ code: code ?? 1, output, json: parsed })
    })
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

function extractDiscordMentionIds(content: string): string[] {
  return [...String(content || "").matchAll(/<@!?(\d+)>/g)]
    .map(match => match[1])
    .filter((id): id is string => !!id)
}

function attachmentUrls(attachments: any): string[] {
  const values = typeof attachments?.values === "function" ? attachments.values() : Object.values(attachments ?? {})
  const out: string[] = []
  for (const att of values as Iterable<any>) {
    const url = att?.url ?? att?.proxyURL ?? att?.proxy_url
    if (typeof url === "string" && url.length > 0) out.push(url)
  }
  return out
}

function userTag(user: any): string | null {
  if (!user) return null
  const name = user.globalName ?? user.global_name ?? user.username ?? user.id
  return `${name} (${user.id})`
}

function formatAsanaIntakeReply(result: AsanaIntakeResult): string {
  if (result.code !== 0 || !result.json?.ok) {
    const msg = result.json?.error ?? result.output.slice(0, 1200) ?? "unknown error"
    return `Asanaタスク作成に失敗しました。\n${String(msg).slice(0, 1500)}`
  }
  const data = result.json
  const lines = [
    data.duplicate ? "Asanaタスクは既に作成済みです。" : "Asanaタスクを作成しました。",
    `タスク: ${data.parsedData?.taskName ?? data.taskGid}`,
    data.taskUrl ? `URL: ${data.taskUrl}` : undefined,
    data.agentMessageId ? `agent-trigger: ${data.agentMessageId}` : undefined,
    data.projectFallback?.usedProjectName
      ? `project fallback: ${data.projectFallback.reason} -> ${data.projectFallback.usedProjectName}`
      : undefined,
  ].filter((line): line is string => Boolean(line))
  return lines.join("\n").slice(0, 1900)
}

async function handleAsanaSlashCommand(interaction: any): Promise<boolean> {
  if (!interaction.isChatInputCommand?.()) return false
  if (interaction.commandName !== ASANA_SLASH_COMMAND_NAME) return false
  if (!ASANA_INTAKE_ENABLED) {
    await interaction.reply({ content: "Asana intake は無効化されています。", ephemeral: true })
    return true
  }
  const content = String(interaction.options?.getString?.("content", true) ?? "").trim()
  if (!content) {
    await interaction.reply({ content: "content が空です。", ephemeral: true })
    return true
  }
  await interaction.deferReply({ ephemeral: true })
  const assigneeUser = interaction.options?.getUser?.("assignee", false)
  const dueDate = interaction.options?.getString?.("due", false) ?? null
  const projectName = interaction.options?.getString?.("project", false) ?? null
  const mentioned = assigneeUser?.id ? [String(assigneeUser.id)] : extractDiscordMentionIds(content)
  const payload = {
    message: content,
    mentionedUserIds: mentioned,
    assigneeDiscordId: assigneeUser?.id ?? mentioned[0] ?? null,
    dueDate,
    projectName,
    source: "discord-command",
    authorTag: userTag(interaction.user),
    discordInteractionId: interaction.id,
    discordUserId: interaction.user?.id ?? null,
    context: {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      interactionId: interaction.id,
      commandName: interaction.commandName,
    },
  }
  const result = await runAsanaIntake(["create", "--payload-file", "-"], JSON.stringify(payload))
  await interaction.editReply(formatAsanaIntakeReply(result))
  process.stderr.write(`discord-router: asana slash command by ${interaction.user?.id ?? "unknown"} rc=${result.code}\n`)
  return true
}

async function handleAsanaMessageContext(interaction: any): Promise<boolean> {
  if (!interaction.isMessageContextMenuCommand?.()) return false
  if (interaction.commandName !== ASANA_MESSAGE_CONTEXT_NAME) return false
  if (!ASANA_INTAKE_ENABLED) {
    await interaction.reply({ content: "Asana intake は無効化されています。", ephemeral: true })
    return true
  }
  await interaction.deferReply({ ephemeral: true })
  const target = interaction.targetMessage
  const urls = attachmentUrls(target?.attachments)
  const content = [
    String(target?.content ?? "").trim(),
    urls.length > 0 ? `添付:\n${urls.join("\n")}` : "",
  ].filter(Boolean).join("\n\n")
  if (!target || !content) {
    await interaction.editReply("対象メッセージの本文または添付URLを取得できませんでした。")
    return true
  }
  const mentioned = target?.mentions?.users?.keys
    ? [...target.mentions.users.keys()].map(String)
    : extractDiscordMentionIds(String(target.content ?? ""))
  const payload = {
    message: content,
    mentionedUserIds: mentioned,
    assigneeDiscordId: mentioned[0] ?? interaction.user?.id ?? null,
    source: "message-context",
    authorTag: userTag(interaction.user),
    discordInteractionId: interaction.id,
    discordUserId: interaction.user?.id ?? null,
    context: {
      sourceMessageId: target.id,
      sourceChannelId: target.channelId ?? interaction.channelId,
      sourceAuthorId: target.author?.id,
      sourceAuthorName: target.author?.globalName ?? target.author?.username,
      attachmentUrls: urls,
      guildId: interaction.guildId,
    },
  }
  const result = await runAsanaIntake(["create", "--payload-file", "-"], JSON.stringify(payload))
  await interaction.editReply(formatAsanaIntakeReply(result))
  process.stderr.write(`discord-router: asana message context by ${interaction.user?.id ?? "unknown"} rc=${result.code}\n`)
  return true
}

async function handleAsanaInteraction(interaction: any): Promise<boolean> {
  if (await handleAsanaSlashCommand(interaction)) return true
  if (await handleAsanaMessageContext(interaction)) return true
  return false
}

function textInputStyle(field: OfficeRequestField): TextInputStyle {
  if (field.name === "address" || field.name === "notes") return TextInputStyle.Paragraph
  return TextInputStyle.Short
}

function officeFieldChoices(field: OfficeRequestField): { label: string; value: string; description?: string }[] {
  return (field.choices ?? [])
    .map(choice => {
      if (typeof choice === "string") return { label: choice, value: choice }
      const value = String(choice.value ?? choice.label ?? "").trim()
      const label = String(choice.label ?? choice.value ?? "").trim()
      if (!value || !label) return null
      return {
        label,
        value,
        description: choice.description ? String(choice.description).slice(0, 100) : undefined,
      }
    })
    .filter((choice): choice is { label: string; value: string; description?: string } => !!choice)
    .slice(0, 25)
}

function officeModalComponent(field: OfficeRequestField): LabelBuilder {
  const label = (field.label || field.name).slice(0, 45)
  if (field.type === "choice") {
    const select = new StringSelectMenuBuilder()
      .setCustomId(field.name)
      .setPlaceholder(label.slice(0, 100))
      .setRequired(!!field.required)
      .setMinValues(field.required ? 1 : 0)
      .setMaxValues(1)
      .addOptions(officeFieldChoices(field).map(choice => ({
        label: choice.label.slice(0, 100),
        value: choice.value.slice(0, 100),
        description: choice.description,
        default: field.default !== undefined && choice.value === String(field.default),
      })))
    return new LabelBuilder().setLabel(label).setStringSelectMenuComponent(select)
  }

  const input = new TextInputBuilder()
    .setCustomId(field.name)
    .setStyle(textInputStyle(field))
    .setRequired(!!field.required)
  if (field.default !== undefined) input.setValue(String(field.default).slice(0, 4000))
  return new LabelBuilder().setLabel(label).setTextInputComponent(input)
}

function officeModalFieldValue(interaction: any, field: OfficeRequestField): string | null {
  if (field.type === "choice") {
    const values = interaction.fields.getStringSelectValues(field.name)
    return values?.[0] ? String(values[0]) : null
  }
  return interaction.fields.getTextInputValue(field.name)
}

function showableOfficeFields(template: OfficeRequestTemplate): OfficeRequestField[] {
  const fields = (template.fields ?? []).filter(field => field?.name)
  const required = fields.filter(field => field.required)
  const optional = fields.filter(field => !field.required && field.name !== "notes")
  return [...required, ...optional].slice(0, 5)
}

function officePendingAttachment(raw: any): Record<string, unknown> | undefined {
  if (!raw) return undefined
  return {
    id: raw.id,
    name: raw.name,
    filename: raw.name,
    url: raw.url,
    contentType: raw.contentType,
    size: raw.size,
  }
}

async function handleOfficeSlashCommand(interaction: any, config: OfficeRequestConfig): Promise<boolean> {
  if (!interaction.isChatInputCommand?.()) return false
  if (!officeCommandNames(config).has(interaction.commandName)) return false
  if (!officeRequestEnabled(config)) {
    await interaction.reply({ content: "事務依頼コマンドはまだ無効化されています。", ephemeral: true })
    return true
  }

  pruneOfficePendingForms()
  const kind = interaction.options?.getString?.("kind", true)
  const templates = officeTemplatesByKind(config)
  const template = templates.get(String(kind))
  if (!template) {
    await interaction.reply({ content: `未知の依頼テンプレートです: ${kind}`, ephemeral: true })
    return true
  }

  const nonce = randomUUID().replace(/-/g, "").slice(0, 16)
  const attachment = officePendingAttachment(interaction.options?.getAttachment?.("pdf", false))
  officePendingForms.set(nonce, {
    kind: String(kind),
    requesterId: interaction.user.id,
    requesterName: interaction.user.username ?? "",
    submittedChannelId: interaction.channelId,
    interactionId: interaction.id,
    guildId: interaction.guildId,
    attachment,
    createdAt: Date.now(),
  })

  const modal = new ModalBuilder()
    .setCustomId(`office-request:create:${nonce}`)
    .setTitle((template.label || template.kind).slice(0, 45))

  const rows = showableOfficeFields(template).map(officeModalComponent)
  if (rows.length === 0) {
    await interaction.reply({ content: "この依頼テンプレートには入力項目がありません。", ephemeral: true })
    return true
  }
  modal.addComponents(...rows)
  await interaction.showModal(modal)
  return true
}

function runOfficeLedger(args: string[], input?: string): Promise<OfficeLedgerResult> {
  return new Promise(resolve => {
    const child = spawn(OFFICE_REQUEST_PYTHON, [OFFICE_REQUEST_SCRIPT, ...args], {
      cwd: OFFICE_REQUEST_CWD,
      env: {
        ...process.env,
        OFFICE_REQUEST_CONFIG: OFFICE_REQUEST_CONFIG_PATH,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout?.on("data", data => { out += String(data) })
    child.stderr?.on("data", data => { err += String(data) })
    child.on("error", e => resolve({ code: 127, output: e.message }))
    child.on("close", code => {
      const output = (out + err).trim()
      let parsed: any
      try {
        parsed = out.trim() ? JSON.parse(out) : undefined
      } catch {
        parsed = undefined
      }
      resolve({ code: code ?? 1, output, json: parsed })
    })
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

function runResidentAgentApproval(args: string[], input?: string): Promise<OfficeLedgerResult> {
  return new Promise(resolve => {
    const child = spawn(RESIDENT_AGENT_APPROVAL_PYTHON, [RESIDENT_AGENT_APPROVAL_SCRIPT, ...args], {
      cwd: RESIDENT_AGENT_APPROVAL_CWD,
      env: {
        ...process.env,
        RESIDENT_AGENTS_CONFIG: RESIDENT_AGENT_CONFIG_PATH,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout?.on("data", data => { out += String(data) })
    child.stderr?.on("data", data => { err += String(data) })
    child.on("error", e => resolve({ code: 127, output: e.message }))
    child.on("close", code => {
      const output = (out + err).trim()
      let parsed: any
      try {
        parsed = out.trim() ? JSON.parse(out) : undefined
      } catch {
        parsed = undefined
      }
      resolve({ code: code ?? 1, output, json: parsed })
    })
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

function gittyScoutActionAllowed(userId: string): boolean {
  return GITTY_SCOUT_ACTION_ALLOW_IDS.includes("*") || GITTY_SCOUT_ACTION_ALLOW_IDS.includes(userId)
}

function runGittyScoutAction(args: string[]): Promise<OfficeLedgerResult> {
  return new Promise(resolve => {
    const child = spawn(GITTY_SCOUT_ACTION_PYTHON, [GITTY_SCOUT_ACTION_SCRIPT, ...args], {
      cwd: GITTY_SCOUT_ACTION_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout?.on("data", data => { out += String(data) })
    child.stderr?.on("data", data => { err += String(data) })
    child.on("error", e => resolve({ code: 127, output: e.message }))
    child.on("close", code => {
      const output = (out + err).trim()
      let parsed: any
      try {
        parsed = out.trim() ? JSON.parse(out) : undefined
      } catch {
        parsed = undefined
      }
      resolve({ code: code ?? 1, output, json: parsed })
    })
  })
}

function officeMentionPrefix(config: OfficeRequestConfig, kind: string): string {
  const mentions = new Set<string>()
  if (config.mentionOfficeUsers !== false) {
    for (const id of config.officeUserIds ?? []) if (id) mentions.add(id)
  }
  if ((config.mentionAdminsForKinds ?? []).includes(kind)) {
    for (const id of config.adminUserIds ?? []) if (id) mentions.add(id)
  }
  return [...mentions].map(id => `<@${id}>`).join(" ")
}

function officeStatusComponents(requestId: string, status: string): ActionRowBuilder<ButtonBuilder>[] {
  const terminal = ["completed", "cancelled", "rejected"].includes(status)
  const received = status === "received"
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`office-request:status:${requestId}:received`)
        .setLabel("受領")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(terminal || received),
      new ButtonBuilder()
        .setCustomId(`office-request:status:${requestId}:completed`)
        .setLabel("完了")
        .setStyle(ButtonStyle.Success)
        .setDisabled(terminal),
    ),
  ]
}

function officeApprovalComponents(requestId: string, approvalId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`office-request:approval:${requestId}:${approvalId}:approved`)
        .setLabel("レビューOK（送信なし）")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`office-request:approval:${requestId}:${approvalId}:rejected`)
        .setLabel("差し戻し")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ]
}

function residentAgentApprovalComponents(agentId: string, proposalId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`resident-agent:proposal:${agentId}:${proposalId}:approved`)
        .setLabel("承認して実行")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`resident-agent:proposal:${agentId}:${proposalId}:rejected`)
        .setLabel("却下")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ]
}

function officeAgentPrompt(request: any, threadId: string, requestUrl: string): string {
  const safeRequest = JSON.stringify(request, null, 2)
  return `OFFICE_REQUEST_AUTORUN

あなたは stod-agent の事務依頼自走セッションです。この依頼を、このスレッド上で最後まで進めてください。

Request URL: ${requestUrl || "(unknown)"}
Request thread/channel: ${threadId}
Ledger ID: ${request.id}

依頼JSON:
\`\`\`json
${safeRequest}
\`\`\`

必須:
- まず \`python3 scripts/office-request-ledger.py update-status --id ${request.id} --status running --actor-id stod-agent\` で状態を running にする。
- 次に \`python3 scripts/office-request-artifacts.py --id ${request.id} --attach-ledger --create-approval-gate --pretty\` でローカルのreview artifactと承認ゲートを生成する。これは契約書成果物ではなく検証用の補助資料。
- intern_contract / NDA など Driveテンプレが登録されている依頼では、Google Drive MCPでKazuha提供テンプレートをDrive上にコピーし、intern_contract は安全項目（契約日/乙区分/ランク/成約インセンティブ）だけを差し込んだDrive上の未送付DOCXを成果物にする。乙氏名/乙住所/乙メール/署名欄はGMO Signの相手入力枠を置けるよう空白にする。コピー/差し込み後は \`python3 scripts/office-request-ledger.py attach-result --id ${request.id} --adapter google_drive --mode live --action drive_template_copy_created --result-status prepared --summary "Kazuha提供テンプレートをDrive上で複製し、安全項目を差し込み済み。契約送付前の未送付ドラフト。" --confirmation-id <drive_file_id> --evidence-path <drive_url> --actor-id stod-agent\` でledgerへ記録する。Drive MCPが未接続/未認証の場合はMarkdownで代替せず、このスレッドに「Drive MCP未接続/未認証のためテンプレ複製が未実行」と明示して止める。診断が必要な時だけ \`python3 scripts/office-request-drive-template-copy.py --id ${request.id} --dry-run --pretty\` で登録テンプレ/出力名/フォルダ/差し込み可否を確認する。
- 続けて \`python3 scripts/office-request-worker.py --id ${request.id}\` を実行し、その出力をこのスレッドに投稿する。
- 承認待ちがある場合は \`python3 scripts/office-request-approval-message.py --id ${request.id} --post --pretty\` で、このスレッドに承認ボタンを投稿する。
- このスレッドに「着手したこと」と「進め方」を短く投稿する。
- Notion / Drive / Discord / Asana / Gmail / Calendar / GitHub / Web など、必要な一次情報を実際に確認する。
- 名刺印刷・GMO Sign・freee・メール送信・契約送付・外部投稿・発注・支払い・金券配布など外部副作用がある操作は、実行前にこのスレッドへプレビューを出して明示承認を待つ。
- 承認待ちで止まる場合は ledger を \`draft\` または \`action_required\` にする。
- 完了したら ledger を \`done\` にし、このスレッドに成果物・実行内容・残リスクを投稿する。

テンプレ別の期待:
- business_card_print: PDF確認、ラクスル注文に必要な情報整理。注文実行は承認待ち。
- ai_dev_contract / gitty_contract / nda / intern_contract: 契約情報の整合性確認、既存テンプレ/手順確認、送付ドラフト作成。GMO Sign送信は承認待ち。
- finance_admin: 請求/freee/支払の証跡・不足情報・承認者を整理。freee書込/請求書送付/支払いは承認待ち。
- subsidy_admin: 制度URL・期限・必要書類・証跡を整理。申請/報告/公的機関への送付は承認待ち。
- vendor_access: 外部サービス/営業リストの目的・所有者・重複リスクを整理。認証情報は再掲せず、ログイン/購入/CRM取込は承認待ち。
- mail_intake: 郵送物/住所/スキャン要否を整理。物理作業や外部送付は人間対応。
- legal_research: 調査・論点整理まで。最終法務判断/外部利用/出願は人間レビュー必須。
- reward_distribution: 配布対象と文面のチェックまで。金券購入/コード露出/配布は承認待ち。
- procurement: 購買理由・候補URL・数量・補助金絡み証跡を整理。発注/支払いは承認待ち。

サイレント終了禁止。必ずこのスレッドに進捗または結果を投稿してください。`
}

function dispatchOfficeAgent(threadId: string, request: any, requestUrl: string): RouteResult {
  const inbound: InboundMessage = {
    type: "message",
    chatId: threadId,
    messageId: `office-request-${request.id}-${Date.now()}`,
    sourceChatId: String(request.discord?.requestChannelId ?? threadId),
    sourceMessageId: String(request.discord?.messageId ?? ""),
    user: "office-request",
    userId: "office-request",
    content: officeAgentPrompt(request, threadId, requestUrl),
    ts: new Date().toISOString(),
  }
  return routeInbound(threadId, inbound.content, inbound, {
    forceDispatch: true,
    forceRoute: true,
    source: "office-request",
    workloadClass: "human_direct",
    queuePriority: WORKLOAD_PRIORITY.human_direct,
  })
}

function officeActionAllowed(config: OfficeRequestConfig, userId: string): boolean {
  const allowed = new Set([...(config.officeUserIds ?? []), ...(config.adminUserIds ?? [])])
  return allowed.has(userId)
}

async function postOfficeRequest(config: OfficeRequestConfig, result: any): Promise<void> {
  const channelId = config.requestChannelId
  if (!channelId) throw new Error("office requestChannelId is not configured")
  const channel = await client.channels.fetch(channelId)
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`office request channel ${channelId} not found or not sendable`)
  }

  const request = result.request
  const prefix = officeMentionPrefix(config, String(request.kind))
  const content = [prefix, result.messageText].filter(Boolean).join("\n")
  const sent = await channel.send({
    content: content.slice(0, 2000),
  })

  let threadId = ""
  try {
    const thread = await sent.startThread({
      name: `[office] ${String(request.kind).slice(0, 40)} ${String(request.id).slice(-6)}`,
      autoArchiveDuration: 10080,
    })
    threadId = thread.id
    await thread.send("stod-agentがこの依頼を自律処理します。補足・標準外条件・添付追加があればこのスレッドに追記してください。")
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: office request thread create failed: ${errorMsg}\n`)
  }

  const guildId = String(request.source?.guildId || config["guildId"] || "")
  const url = guildId ? `https://discord.com/channels/${guildId}/${channelId}/${sent.id}` : ""
  const attachResult = await runOfficeLedger([
    "attach-discord",
    "--id", String(request.id),
    "--requestChannelId", channelId,
    "--messageId", sent.id,
    ...(threadId ? ["--threadId", threadId] : []),
    ...(url ? ["--url", url] : []),
    "--actor-id", String(request.requesterId),
  ])
  const attachedRequest = attachResult.json?.request ?? request
  const targetThreadId = threadId || channelId
  const dispatch = dispatchOfficeAgent(targetThreadId, attachedRequest, url)
  process.stderr.write(`discord-router: office request ${request.id} dispatched to agent thread=${targetThreadId} reason=${dispatch.reason}\n`)
}

async function handleOfficeModalSubmit(interaction: any, config: OfficeRequestConfig): Promise<boolean> {
  if (!interaction.isModalSubmit?.()) return false
  const parts = String(interaction.customId || "").split(":")
  if (parts[0] !== "office-request" || parts[1] !== "create" || !parts[2]) return false
  if (!officeRequestEnabled(config)) {
    await interaction.reply({ content: "事務依頼コマンドは無効化されています。", ephemeral: true })
    return true
  }

  const nonce = parts[2]
  const pending = officePendingForms.get(nonce)
  officePendingForms.delete(nonce)
  if (!pending) {
    await interaction.reply({ content: "入力フォームの有効期限が切れました。もう一度コマンドから作成してください。", ephemeral: true })
    return true
  }
  await interaction.deferReply({ ephemeral: true })

  const template = officeTemplatesByKind(config).get(pending.kind)
  const payload: Record<string, string> = {}
  for (const field of showableOfficeFields(template ?? { kind: pending.kind })) {
    try {
      const value = officeModalFieldValue(interaction, field)
      if (value !== null) payload[field.name] = value
    } catch {
      // Missing optional field.
    }
  }
  const input = {
    kind: pending.kind,
    requesterId: pending.requesterId,
    requesterName: pending.requesterName,
    source: {
      interactionId: pending.interactionId,
      guildId: pending.guildId,
      submittedChannelId: pending.submittedChannelId,
      modalInteractionId: interaction.id,
    },
    payload,
    attachments: pending.attachment ? [pending.attachment] : [],
  }

  const result = await runOfficeLedger(["create", "--payload-file", "-"], JSON.stringify(input))
  if (result.code !== 0 || !result.json?.ok) {
    const errors = result.json?.errors?.join("\n") || result.output.slice(0, 1200) || "unknown error"
    await interaction.editReply(`❌ 事務依頼の作成に失敗しました。\n${errors}`)
    process.stderr.write(`discord-router: office request create failed rc=${result.code}: ${result.output.slice(0, 300)}\n`)
    return true
  }

  try {
    await postOfficeRequest(config, result.json)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await interaction.editReply(`⚠️ 台帳には作成しましたが、事務チャンネルへの投稿に失敗しました。\nRequest ID: \`${result.json.request.id}\`\n${errorMsg.slice(0, 1000)}`)
    process.stderr.write(`discord-router: office request post failed: ${errorMsg}\n`)
    return true
  }

  const status = result.json.request.status === "needs_info" ? "（不足情報あり）" : ""
  await interaction.editReply(`✅ 事務依頼を作成しました${status}: \`${result.json.request.id}\``)
  process.stderr.write(`discord-router: office request created ${result.json.request.id} by ${pending.requesterId}\n`)
  return true
}

async function handleOfficeStatusButton(interaction: any, config: OfficeRequestConfig): Promise<boolean> {
  if (!interaction.isButton?.()) return false
  const parts = String(interaction.customId || "").split(":")
  if (parts[0] !== "office-request" || parts[1] !== "status" || parts.length < 4) return false
  if (!officeRequestEnabled(config)) {
    await interaction.reply({ content: "事務依頼アクションは無効化されています。", ephemeral: true })
    return true
  }
  if (!officeActionAllowed(config, interaction.user.id)) {
    await interaction.reply({ content: "この操作は事務担当または管理者のみ実行できます。", ephemeral: true })
    return true
  }

  const requestId = parts[2]
  const status = parts[3]
  await interaction.deferReply({ ephemeral: true })
  const result = await runOfficeLedger([
    "update-status",
    "--id", requestId,
    "--status", status,
    "--actor-id", interaction.user.id,
  ])
  if (result.code !== 0 || !result.json?.ok) {
    await interaction.editReply(`❌ 状態更新に失敗しました: \`${requestId}\`\n${result.output.slice(0, 1200)}`)
    process.stderr.write(`discord-router: office status update failed rc=${result.code}: ${result.output.slice(0, 300)}\n`)
    return true
  }
  try {
    await interaction.message.edit({
      content: result.json.messageText.slice(0, 2000),
      components: officeStatusComponents(requestId, String(result.json.request.status)),
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: office message edit failed: ${errorMsg}\n`)
  }
  await interaction.editReply(`✅ \`${requestId}\` を \`${result.json.request.status}\` に更新しました。`)
  return true
}

async function handleOfficeApprovalButton(interaction: any, config: OfficeRequestConfig): Promise<boolean> {
  if (!interaction.isButton?.()) return false
  const parts = String(interaction.customId || "").split(":")
  if (parts[0] !== "office-request" || parts[1] !== "approval" || parts.length < 5) return false
  if (!officeRequestEnabled(config)) {
    await interaction.reply({ content: "事務依頼アクションは無効化されています。", ephemeral: true })
    return true
  }
  if (!officeActionAllowed(config, interaction.user.id)) {
    await interaction.reply({ content: "この承認操作は事務担当または管理者のみ実行できます。", ephemeral: true })
    return true
  }

  const requestId = parts[2]
  const approvalId = parts[3]
  const decision = parts[4]
  if (decision !== "approved" && decision !== "rejected") {
    await interaction.reply({ content: "不明な承認操作です。", ephemeral: true })
    return true
  }
  await interaction.deferReply({ ephemeral: true })
  const result = await runOfficeLedger([
    "decide-approval",
    "--id", requestId,
    "--approval-id", approvalId,
    "--decision", decision,
    "--actor-id", interaction.user.id,
    "--message", `Discord approval button: ${decision}`,
  ])
  if (result.code !== 0 || !result.json?.ok) {
    await interaction.editReply(`❌ 承認状態の更新に失敗しました: \`${requestId}\`\n${result.output.slice(0, 1200)}`)
    process.stderr.write(`discord-router: office approval update failed rc=${result.code}: ${result.output.slice(0, 300)}\n`)
    return true
  }
  try {
    await interaction.message.edit({
      content: `${interaction.message.content}\n\n状態: \`${decision}\` by <@${interaction.user.id}>`,
      components: officeApprovalComponents(requestId, approvalId, true),
      allowedMentions: { parse: [] },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: office approval message edit failed: ${errorMsg}\n`)
  }
  if (decision === "approved") {
    await interaction.editReply(`✅ \`${requestId}\` のレビューOKを記録しました。本番送信・発注・支払い・freee書込は実行していません。`)
  } else {
    await interaction.editReply(`✅ \`${requestId}\` を差し戻しとして記録しました。`)
  }
  return true
}

async function handleOfficeInteraction(interaction: any): Promise<boolean> {
  const config = loadOfficeRequestConfig()
  if (!config) return false
  if (await handleOfficeSlashCommand(interaction, config)) return true
  if (await handleOfficeModalSubmit(interaction, config)) return true
  if (await handleOfficeApprovalButton(interaction, config)) return true
  if (await handleOfficeStatusButton(interaction, config)) return true
  return false
}

async function handleGittyScoutInteraction(interaction: any): Promise<boolean> {
  if (!interaction.isButton?.()) return false
  const customId = String(interaction.customId || "")
  if (!customId.startsWith("gitty-scout:")) return false
  if (!GITTY_SCOUT_ACTIONS_ENABLED) {
    await interaction.reply({ content: "Gitty scout action は無効化されています。", ephemeral: true })
    return true
  }
  if (!gittyScoutActionAllowed(interaction.user.id)) {
    await interaction.reply({ content: "このGitty scout操作は許可されていません。", ephemeral: true })
    return true
  }
  await interaction.deferReply({ ephemeral: true })
  const result = await runGittyScoutAction([
    "--custom-id", customId,
    "--actor-id", interaction.user.id,
    "--message-id", interaction.message?.id ?? "",
    "--message-url", interaction.message?.url ?? "",
  ])
  const content = String(result.json?.content || result.output || "Gitty scout action failed").slice(0, 1800)
  if (result.code !== 0 || !result.json?.ok) {
    await interaction.editReply(`❌ ${content}`)
    process.stderr.write(`discord-router: gitty scout action failed rc=${result.code}: ${result.output.slice(0, 300)}\n`)
    return true
  }
  if (result.json?.disableComponents) {
    try {
      await interaction.message.edit({
        content: `${interaction.message.content}\n\n状態: 実行済み by <@${interaction.user.id}>`,
        components: [],
        allowedMentions: { parse: [] },
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`discord-router: gitty scout message edit failed: ${errorMsg}\n`)
    }
  }
  await interaction.editReply(`✅ ${content}`)
  return true
}

// ── WebSocket Server ──
async function handleResidentAgentApprovalButton(interaction: any): Promise<boolean> {
  if (!interaction.isButton?.()) return false
  const parts = String(interaction.customId || "").split(":")
  if (parts[0] !== "resident-agent" || parts[1] !== "proposal" || parts.length < 5) return false

  if (!RESIDENT_AGENT_APPROVALS_ENABLED) {
    await interaction.reply({ content: "Resident Agent承認操作は無効化されています。", ephemeral: true })
    return true
  }

  const agentId = parts[2]
  const proposalId = parts[3]
  const decision = parts[4]
  process.stderr.write(`discord-router: resident agent approval button received agent=${agentId} proposal=${proposalId} decision=${decision} user=${interaction.user?.id ?? "unknown"}\n`)

  if (decision !== "approved" && decision !== "rejected") {
    await interaction.reply({ content: "不明なResident Agent承認操作です。", ephemeral: true })
    return true
  }

  await interaction.deferReply({ ephemeral: true })

  const decide = await runResidentAgentApproval([
    "decide",
    "--agent", agentId,
    "--proposal-id", proposalId,
    "--decision", decision,
    "--actor-id", interaction.user.id,
    "--message", `Discord resident-agent approval button: ${decision}`,
  ])
  if (decide.code !== 0 || !decide.json?.ok) {
    await interaction.editReply(`❌ Resident Agent proposal の承認更新に失敗しました: \`${proposalId}\`\n${decide.output.slice(0, 1200)}`)
    process.stderr.write(`discord-router: resident agent approval decide failed rc=${decide.code}: ${decide.output.slice(0, 300)}\n`)
    return true
  }

  let published = false
  let targetChannelId = ""
  if (decision === "approved") {
    const publish = await runResidentAgentApproval([
      "publish",
      "--agent", agentId,
      "--proposal-id", proposalId,
    ])
    if (publish.code !== 0 || !publish.json?.ok) {
      await interaction.editReply(`❌ Resident Agent proposal の投稿準備に失敗しました: \`${proposalId}\`\n${publish.output.slice(0, 1200)}`)
      process.stderr.write(`discord-router: resident agent approval publish failed rc=${publish.code}: ${publish.output.slice(0, 300)}\n`)
      return true
    }

    targetChannelId = String(publish.json.targetChannelId || "")
    const payload = publish.json.payload
    if (!targetChannelId || !payload) {
      await interaction.editReply(`❌ 投稿先または投稿本文が空です: \`${proposalId}\``)
      process.stderr.write(`discord-router: resident agent approval publish missing payload proposal=${proposalId}\n`)
      return true
    }

    const channel = await client.channels.fetch(targetChannelId)
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      await interaction.editReply(`❌ 投稿先チャンネルが見つからないか送信できません: \`${targetChannelId}\``)
      process.stderr.write(`discord-router: resident agent approval target channel not sendable ${targetChannelId}\n`)
      return true
    }

    const sent = await channel.send(payload)
    const guildId = String(interaction.guildId || config.guildId || "")
    const url = guildId ? `https://discord.com/channels/${guildId}/${targetChannelId}/${sent.id}` : ""
    process.stderr.write(`discord-router: resident agent proposal ${proposalId} sent to ${targetChannelId} message=${sent.id}; applying marker/actions\n`)

    const mark = await runResidentAgentApproval([
      "mark-published",
      "--agent", agentId,
      "--proposal-id", proposalId,
      "--channel-id", targetChannelId,
      "--message-id", sent.id,
      ...(url ? ["--url", url] : []),
      "--actor-id", interaction.user.id,
      "--apply-sot-actions",
      "--force",
    ])
    if (mark.code !== 0 || !mark.json?.ok) {
      process.stderr.write(`discord-router: resident agent approval mark-published failed rc=${mark.code}: ${mark.output.slice(0, 500)}\n`)
      await interaction.editReply(`⚠️ 投稿は完了しましたが、ledger更新/SOT actionでエラーが出ました。\n投稿: <#${targetChannelId}> / \`${sent.id}\`\n${mark.output.slice(0, 900)}`)
      published = true
    } else {
      await interaction.editReply(`✅ \`${proposalId}\` を承認し、<#${targetChannelId}> に投稿しました。`)
      published = true
    }
  } else {
    await interaction.editReply(`✅ \`${proposalId}\` を却下しました。`)
  }

  try {
    await interaction.message.edit({
      content: `${interaction.message.content}\n\n状態: \`${decision}\` by <@${interaction.user.id}>${published ? ` / posted to <#${targetChannelId}>` : ""}`,
      components: residentAgentApprovalComponents(agentId, proposalId, true),
      allowedMentions: { parse: [] },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`discord-router: resident agent approval message edit failed: ${errorMsg}\n`)
  }

  return true
}

function omissionActionArgs(customId: string): string[] | null {
  const parts = customId.split(":")
  if (parts[0] !== "omission" || parts.length < 3) return null
  const action = parts[1]
  const requestId = parts[2]
  if (!/^[0-9a-f]{12}$/.test(requestId)) return null
  if (action === "approve") return ["approve", requestId]
  if (action === "resolve") return ["resolve", requestId]
  if (action === "ignore") return ["ignore", requestId]
  if (action === "snooze") {
    const days = parts[3] ?? "3"
    if (!/^\d{1,3}$/.test(days)) return null
    return ["snooze", requestId, "--days", days]
  }
  return null
}

function omissionActionAllowed(userId: string): boolean {
  return OMISSION_ACTION_ALLOW_IDS.includes("*") || OMISSION_ACTION_ALLOW_IDS.includes(userId)
}

function runOmissionAction(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const child = spawn(OMISSION_ACTION_PYTHON, [OMISSION_ACTION_SCRIPT, ...args], {
      cwd: OMISSION_ACTION_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout?.on("data", data => { out += String(data) })
    child.stderr?.on("data", data => { err += String(data) })
    child.on("error", e => resolve({ code: 127, output: e.message }))
    child.on("close", code => resolve({ code: code ?? 1, output: (out + err).trim() }))
  })
}

function actionLabel(action: string): string {
  if (action === "approve") return "承認"
  if (action === "resolve") return "解決済み"
  if (action === "ignore") return "誤検知クローズ"
  if (action === "snooze") return "保留"
  return action
}

async function handleInteraction(interaction: any): Promise<void> {
  if (await handleAsanaInteraction(interaction)) return
  if (await handleOfficeInteraction(interaction)) return
  if (await handleGittyScoutInteraction(interaction)) return
  if (await handleResidentAgentApprovalButton(interaction)) return
  if (!interaction.isButton?.()) return
  const args = omissionActionArgs(interaction.customId)
  if (!args) {
    process.stderr.write(`discord-router: unhandled button interaction customId=${String(interaction.customId || "").slice(0, 160)} user=${interaction.user?.id ?? "unknown"}\n`)
    return
  }
  if (!OMISSION_ACTIONS_ENABLED) {
    await interaction.reply({ content: "omission action は無効化されています。", ephemeral: true })
    return
  }
  if (!omissionActionAllowed(interaction.user.id)) {
    await interaction.reply({ content: "この操作は許可されていません。", ephemeral: true })
    return
  }
  await interaction.deferReply({ ephemeral: true })
  const result = await runOmissionAction(args)
  const label = actionLabel(args[0])
  if (result.code === 0) {
    await interaction.editReply(`✅ ${label} を実行しました: \`${args[1]}\``)
    process.stderr.write(`discord-router: omission ${args[0]} ${args[1]} by ${interaction.user.id}\n`)
  } else {
    await interaction.editReply(`❌ ${label} に失敗しました: \`${args[1]}\`\n${result.output.slice(0, 1200)}`)
    process.stderr.write(`discord-router: omission ${args[0]} ${args[1]} failed rc=${result.code}: ${result.output.slice(0, 300)}\n`)
  }
}

async function handleReply(msg: ReplyMessage): Promise<void> {
  if (typeof msg.text !== "string" || msg.text.length === 0) {
    const session = router.getSessionByChannel(msg.chatId)
    if (session) {
      session.ws.send(JSON.stringify({
        type: "result",
        requestId: msg.requestId,
        success: false,
        error: "reply requires non-empty text",
      }))
    }
    return
  }
  const omissionMarker = captureOmissionResult(msg.text)
  if (omissionMarker) {
    process.stderr.write(`discord-router: captured ${omissionMarker} from reply tool locally (not posted to Discord)\n`)
    touchSessionRegistry(msg.chatId)
    const session = router.getSessionByChannel(msg.chatId)
    if (session) {
      session.ws.send(JSON.stringify({
        type: "result",
        requestId: msg.requestId,
        success: true,
        data: `captured locally (${omissionMarker})`,
      }))
    }
    return
  }
  if (outboundDuplicateSeen(msg.chatId, msg.text)) {
    process.stderr.write(`discord-router: suppressed duplicate outbound post in channel ${msg.chatId}\n`)
    touchSessionRegistry(msg.chatId)
    const session = router.getSessionByChannel(msg.chatId)
    if (session) {
      session.ws.send(JSON.stringify({
        type: "result",
        requestId: msg.requestId,
        success: true,
        data: "suppressed duplicate outbound post",
      }))
    }
    return
  }
  const sentIds = await sendToChannel(client, msg.chatId, msg.text, {
    replyTo: msg.replyTo,
    files: msg.files,
  })
  recordOutbound(msg.chatId, msg.text)
  touchSessionRegistry(msg.chatId)
  ambientLastReplyAtByChannel.set(msg.chatId, Date.now())
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
  touchSessionRegistry(msg.chatId)
  const session = router.getSessionByChannel(msg.chatId)
  try {
    const channel = await client.channels.fetch(msg.chatId)
    if (!channel?.isTextBased()) throw new Error("Channel not found")
    const discordMsg = await channel.messages.fetch(msg.messageId)
    await discordMsg.react(msg.emoji)
  } catch (err) {
    if (!isDiscordUnknownMessageError(err)) throw err
    process.stderr.write(`discord-router: skipped react; target message disappeared channel=${msg.chatId} message=${msg.messageId}\n`)
    if (session) {
      session.ws.send(JSON.stringify({
        type: "result",
        requestId: msg.requestId,
        success: true,
        data: "reaction skipped: target message disappeared",
      }))
    }
    return
  }
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
  touchSessionRegistry(msg.chatId)
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
  touchSessionRegistry(msg.chatId)
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
    touchSessionRegistry(msg.chatId)
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
  touchSessionRegistry(msg.chatId)
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
  if (typeof msg.text !== "string" || msg.text.length === 0) {
    ws.send(JSON.stringify({
      type: "result",
      requestId: msg.requestId,
      success: false,
      error: "post requires non-empty text",
    }))
    return
  }
  const omissionMarker = captureOmissionResult(msg.text)
  if (omissionMarker) {
    process.stderr.write(`discord-router: captured ${omissionMarker} from post tool locally (not posted to Discord)\n`)
    const sessionId = ws.data.sessionId
    const session = router.getSession(sessionId)
    if (session?.channelId) touchSessionRegistry(session.channelId)
    ws.send(JSON.stringify({
      type: "result",
      requestId: msg.requestId,
      success: true,
      data: `captured locally (${omissionMarker})`,
    }))
    return
  }
  const sessionId = ws.data.sessionId
  const { channelId } = await ensureSessionChannel(sessionId)
  if (outboundDuplicateSeen(channelId, msg.text)) {
    process.stderr.write(`discord-router: suppressed duplicate outbound post in channel ${channelId}\n`)
    touchSessionRegistry(channelId)
    ws.send(JSON.stringify({
      type: "result",
      requestId: msg.requestId,
      success: true,
      data: "suppressed duplicate outbound post",
    }))
    return
  }
  const sentIds = await sendToChannel(client, channelId, msg.text)
  recordOutbound(channelId, msg.text)
  touchSessionRegistry(channelId)
  ambientLastReplyAtByChannel.set(channelId, Date.now())
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
        const omissionMarker = captureOmissionResult(body.text)
        if (omissionMarker) {
          process.stderr.write(`discord-router: captured ${omissionMarker} locally (not posted to Discord)\n`)
          if (session.channelId) touchSessionRegistry(session.channelId)
          return Response.json({ ok: true, captured: omissionMarker })
        }
        // Ensure channel exists
        const { channelId } = await ensureSessionChannel(session.sessionId)
        if (outboundDuplicateSeen(channelId, body.text)) {
          process.stderr.write(`discord-router: suppressed duplicate outbound mirror in channel ${channelId}\n`)
          touchSessionRegistry(channelId)
          return Response.json({ ok: true, suppressed: true })
        }
        await sendToChannel(client, channelId, body.text)
        recordOutbound(channelId, body.text)
        touchSessionRegistry(channelId)

        // Auto-rename channel based on user prompt topic
        if (body.text.startsWith("**User:**")) {
          const userMsg = body.text.replace(/^\*\*User:\*\*\s*/, "")
          const now = Date.now()
          const lastRename = channelRenameTracker.get(channelId)
          const canRename = !lastRename || (now - lastRename > RENAME_COOLDOWN_MS)

          if (canRename && userMsg.trim() && !session.pinned) {
            const category = state.categories[session.cwd]
            const chEntry = category
              ? Object.values(category.channels).find(ch => ch.channelId === channelId)
              : null
            // Extract channel number from current name
            const numMatch = chEntry?.channelName.match(/(\d+)/)
            const num = numMatch ? numMatch[1] : "1"
            // Fire-and-forget rename (don't block mirror response)
            summarizeTopic(userMsg)
              .then(async topic => {
                const newName = `${num}-${topic}`
                await renameChannel(client, channelId, newName)
                channelRenameTracker.set(channelId, now)
                if (chEntry) {
                  chEntry.channelName = newName
                  saveState(state)
                }
                router.assignChannel(session!.sessionId, channelId, newName)
                process.stderr.write(`discord-router: channel renamed to #${newName}\n`)
              })
              .catch(err => {
                process.stderr.write(`discord-router: rename failed: ${err}\n`)
              })
          }
        }

        return new Response("OK", { status: 200 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`discord-router: mirror error: ${msg}\n`)
        return new Response(msg, { status: 500 })
      }
    }

    if (url.pathname === "/omission-result" && req.method === "GET") {
      try {
        const marker = String(url.searchParams.get("marker") ?? "")
        if (!OMISSION_RESULT_RE.test(marker)) {
          return new Response("Invalid marker", { status: 400 })
        }
        pruneOmissionResults()
        const entry = omissionResults.get(marker)
        if (!entry) {
          return Response.json({ found: false })
        }
        omissionResults.delete(marker)
        return Response.json({ found: true, marker, text: entry.text, ageMs: Date.now() - entry.at })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`discord-router: omission-result error: ${msg}\n`)
        return new Response(msg, { status: 500 })
      }
    }

    if (url.pathname === "/inject" && req.method === "POST") {
      try {
        if (!LOCAL_INJECT_ENABLED) {
          return new Response("Local inject disabled", { status: 403 })
        }
        const body = await req.json() as {
          channelId?: string
          messageId?: string
          sourceChatId?: string
          sourceMessageId?: string
          user?: string
          userId?: string
          content?: string
          ts?: string
          forceDispatch?: boolean
          forceRoute?: boolean
          workloadClass?: string
          queuePriority?: number
        }
        const channelId = String(body.channelId ?? "")
        const content = String(body.content ?? "")
        if (!/^\d{17,20}$/.test(channelId)) {
          return new Response("Invalid channelId", { status: 400 })
        }
        if (!content.trim()) {
          return new Response("Missing content", { status: 400 })
        }
        const inbound: InboundMessage = {
          type: "message",
          chatId: channelId,
          messageId: String(body.messageId ?? `local-${Date.now()}`),
          sourceChatId: String(body.sourceChatId ?? body.channelId ?? ""),
          sourceMessageId: String(body.sourceMessageId ?? body.messageId ?? ""),
          user: String(body.user ?? "local-inject"),
          userId: String(body.userId ?? "local-inject"),
          content,
          ts: String(body.ts ?? new Date().toISOString()),
        }
        const result = routeInbound(channelId, content, inbound, {
          forceDispatch: body.forceDispatch !== false,
          forceRoute: body.forceRoute !== false,
          source: "local-inject",
          workloadClass: body.workloadClass ?? "background",
          queuePriority: body.queuePriority,
        })
        return Response.json(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`discord-router: inject error: ${msg}\n`)
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
