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
