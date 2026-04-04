#!/usr/bin/env bun
/**
 * One-off script: rename all existing channels using LLM-based topic summarization.
 * Usage: bun run scripts/rename-all.ts
 */
import { loadConfig, loadState, saveState, ensureConfigDir } from "../daemon/config.ts"
import { createDiscordClient, summarizeTopic } from "../daemon/discord.ts"
import type { TextChannel } from "discord.js"

ensureConfigDir()
const config = loadConfig()
const state = loadState()

const client = createDiscordClient()

client.once("ready", async () => {
  console.log(`Connected as ${client.user?.tag}`)

  for (const [cwd, category] of Object.entries(state.categories)) {
    for (const [sessionId, ch] of Object.entries(category.channels)) {
      try {
        const channel = await client.channels.fetch(ch.channelId) as TextChannel | null
        if (!channel || !channel.isTextBased() || !("messages" in channel)) {
          console.log(`  SKIP ${ch.channelName} - not found`)
          continue
        }

        // Fetch oldest messages (up to 50)
        const msgs = await channel.messages.fetch({ limit: 50 })
        const sorted = [...msgs.values()].reverse()

        // Find first user message (mirrored format: "**User:** ...")
        const firstUserMsg = sorted.find(m =>
          m.author.id === client.user?.id && m.content.startsWith("**User:**")
        )

        if (!firstUserMsg) {
          console.log(`  SKIP #${ch.channelName} - no user message found`)
          continue
        }

        const userText = firstUserMsg.content.replace(/^\*\*User:\*\*\s*/, "")
        const numMatch = ch.channelName.match(/(\d+)/)
        const num = numMatch ? numMatch[1] : "1"

        const topic = await summarizeTopic(userText)
        const newName = `${num}-${topic}`

        if (newName === ch.channelName) {
          console.log(`  SKIP #${ch.channelName} - already named`)
          continue
        }

        await channel.setName(newName)
        console.log(`  RENAMED #${ch.channelName} -> #${newName}`)
        ch.channelName = newName

        // Delay to respect rate limits
        await new Promise(r => setTimeout(r, 2000))
      } catch (err) {
        console.log(`  ERROR ${ch.channelName}: ${err}`)
      }
    }
  }

  saveState(state)
  console.log("Done. State saved.")
  client.destroy()
  process.exit(0)
})

await client.login(config.discordBotToken)
