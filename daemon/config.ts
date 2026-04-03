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
