// ── Client -> Daemon ──

export type RegisterMessage = {
  type: "register"
  cwd: string
  sessionId: string
  channelId?: string | null
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

export type PostMessage = {
  type: "post"
  text: string
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
  | PostMessage

// ── Daemon -> Client ──

export type RegisteredMessage = {
  type: "registered"
  channelId: string | null
  channelName: string | null
}

export type InboundMessage = {
  type: "message"
  chatId: string
  messageId: string
  sourceChatId?: string
  sourceMessageId?: string
  replyTo?: {
    chatId: string
    messageId: string
    user?: string
    userId?: string
    content?: string
    ts?: string
    url?: string
    attachmentCount?: number
    attachments?: string[]
  }
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

import { homedir } from "os"

export const CONFIG_DIR = `${homedir()}/.config/claude-discord-router`
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`
export const STATE_PATH = `${CONFIG_DIR}/state.json`
export const INBOX_DIR = `${CONFIG_DIR}/inbox`
