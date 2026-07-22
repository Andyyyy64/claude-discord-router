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
import { readFileSync } from "fs"
import { homedir } from "os"
import type { Config, State, CategoryEntry, ChannelEntry } from "../shared/protocol.ts"
import { saveState } from "./config.ts"

const NO_MENTION_CHANNEL_IDS = new Set(
  (process.env.CDR_NO_MENTION_CHANNEL_IDS ?? "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
)

export function containsDiscordMention(text: string): boolean {
  return /<@!?\d{17,20}>|<@&\d{17,20}>|@(everyone|here)\b/i.test(text)
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageTyping,
      GatewayIntentBits.DirectMessages,
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

export function slugify(text: string): string {
  let s = text.trim()
  if (!s) return "session"
  s = s.replace(/\s+/g, "-")
  s = s.replace(/[^\p{L}\p{N}\-_]/gu, "")
  s = s.replace(/-{2,}/g, "-")
  s = s.replace(/^[-_]+|[-_]+$/g, "")
  return s.toLowerCase() || "session"
}

function loadClaudeOAuthToken(): string | null {
  try {
    const credsPath = `${homedir()}/.claude/.credentials.json`
    const creds = JSON.parse(readFileSync(credsPath, "utf8"))
    const token = creds?.claudeAiOauth?.accessToken
    if (!token) return null
    // Check expiry
    const expiresAt = creds?.claudeAiOauth?.expiresAt
    if (expiresAt && Date.now() > expiresAt) {
      process.stderr.write("discord-router: Claude OAuth token expired\n")
      return null
    }
    return token
  } catch {
    return null
  }
}

export async function summarizeTopic(text: string, apiKey?: string): Promise<string> {
  const key = apiKey || loadClaudeOAuthToken()
  if (!key) return slugify(text.slice(0, 15))

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 30,
        messages: [{
          role: "user",
          content: `Summarize this user prompt as a Discord channel name: 1-3 words in English, lowercase, hyphens between words, no special chars. Only output the channel name, nothing else.\n\nPrompt: ${text.slice(0, 300)}`,
        }],
      }),
    })

    if (!res.ok) {
      process.stderr.write(`discord-router: summarize API error: ${res.status}\n`)
      return slugify(text.slice(0, 15))
    }

    const data = await res.json() as { content: Array<{ text: string }> }
    const summary = data.content?.[0]?.text?.trim() ?? ""
    return slugify(summary) || slugify(text.slice(0, 15))
  } catch (err) {
    process.stderr.write(`discord-router: summarize failed: ${err}\n`)
    return slugify(text.slice(0, 15))
  }
}

export async function renameChannel(
  client: Client,
  channelId: string,
  newName: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId)
  if (channel && "setName" in channel) {
    await (channel as TextChannel).setName(newName)
  }
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
  const noMentions = NO_MENTION_CHANNEL_IDS.has(channelId)
  if (noMentions && containsDiscordMention(text)) {
    throw new Error(
      `Mentions are not allowed in read-only log channel ${channelId}; use an escalation route instead`
    )
  }

  // Discord 2000 char limit - split if needed
  const chunks = chunkText(text, 2000)
  const sentIds: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    const sent = await channel.send({
      content: chunks[i],
      ...(noMentions ? { allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } } : {}),
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
    let cut = newline > limit / 2 ? newline : space > 0 ? space : limit
    if (cut <= 0) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest) out.push(rest)
  return out
}
