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
