import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import { createInstanceClient } from "../workspaces/instance-client"
import {
  MAX_TURNS,
  type GoalRecord,
  boardComplete,
  deleteGoal,
  freshGoal,
  loadGoal,
  saveGoal,
  steerPrompt,
} from "./state"

/**
 * Goal runtime: keeps a session working toward a user-set objective by
 * injecting a synthetic continuation prompt whenever the session goes idle.
 *
 * The evidence board is the completion contract: the loop stops when the
 * assistant marks every deliverable done WITH evidence (file path or command
 * output), when the turn budget runs out (wrap-up mode: handoff note, never
 * a fake "done"), or when the user pauses/drops the goal.
 *
 * State survives UI disconnects: it lives in this server process and in
 * ~/.codenomad/goals/<sessionId>.json.
 */
export interface GoalAuditor {
  (goal: GoalRecord, lastTurn: string): Promise<{ verdict: "working" | "blocked" | "confirm" | "not-done"; note: string }>
}

interface ManagerDeps {
  eventBus: EventBus
  logger: Logger
  workspaceManager?: WorkspaceManager
  workspaceDirectory?: (instanceId: string) => string | undefined
  auditor?: GoalAuditor
  idleDelayMs?: number
  sendPrompt?: (instanceId: string, sessionID: string, text: string) => Promise<void>
}

const DEFAULT_IDLE_DELAY_MS = 2000

export class GoalManager {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private unsubscribe?: () => void
  private lastTurnText = new Map<string, string>()

  constructor(private readonly deps: ManagerDeps) {}

  start(): void {
    const onInstanceEvent = (event: { instanceId?: string; event?: { type?: string; properties?: Record<string, unknown> } }) => {
      const instanceId = event?.instanceId
      const type = event?.event?.type
      if (!instanceId) return
      if (type === "session.idle") {
        const sessionID = typeof event.event?.properties?.sessionID === "string" ? (event.event.properties.sessionID as string) : undefined
        if (sessionID) this.scheduleContinuation(instanceId, sessionID)
      } else if (type === "session.updated" || type === "message.updated" || type === "message.part.updated") {
        const sessionID = typeof event.event?.properties?.sessionID === "string" ? (event.event.properties.sessionID as string) : undefined
        if (sessionID) this.clearTimer(sessionID)
        const text = typeof event.event?.properties?.text === "string" ? (event.event.properties.text as string) : undefined
        if (sessionID && text) this.lastTurnText.set(sessionID, text)
      }
    }
    const onStopped = (event: { workspaceId?: string }) => this.clearInstance(event?.workspaceId)
    const onError = (event: { workspace?: { id?: string } }) => this.clearInstance(event?.workspace?.id)

    this.deps.eventBus.on("instance.event", onInstanceEvent)
    this.deps.eventBus.on("workspace.stopped", onStopped)
    this.deps.eventBus.on("workspace.error", onError)
    this.unsubscribe = () => {
      this.deps.eventBus.off("instance.event", onInstanceEvent)
      this.deps.eventBus.off("workspace.stopped", onStopped)
      this.deps.eventBus.off("workspace.error", onError)
    }
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  async set(instanceId: string, sessionID: string, objective: string, tokenBudget: number | null): Promise<GoalRecord> {
    const goal = freshGoal(instanceId, sessionID, objective, tokenBudget)
    await saveGoal(goal)
    return goal
  }

  async get(sessionID: string): Promise<GoalRecord | null> {
    return loadGoal(sessionID)
  }

  async pause(sessionID: string): Promise<GoalRecord | null> {
    return this.transition(sessionID, (goal) => {
      if (goal.status === "active" || goal.status === "budget-limited") goal.status = "paused"
    })
  }

  async resume(sessionID: string): Promise<GoalRecord | null> {
    return this.transition(sessionID, (goal) => {
      if (goal.status === "paused") {
        goal.status = "active"
      }
    })
  }

  async drop(sessionID: string): Promise<void> {
    this.clearTimer(sessionID)
    await deleteGoal(sessionID)
  }

  async noteCompletionClaim(sessionID: string): Promise<{ accepted: boolean; reason?: string }> {
    const goal = await loadGoal(sessionID)
    if (!goal) return { accepted: false, reason: "No active goal." }
    if (goal.status !== "active") return { accepted: false, reason: `Goal is ${goal.status}, not active.` }

    if (!boardComplete(goal)) {
      return {
        accepted: false,
        reason:
          "REJECTED — board incomplete. Every row needs status done AND an evidence link (file path or command output). Mark unreachable rows blocked with a reason, then retry.",
      }
    }

    const auditor = this.deps.auditor
    if (auditor) {
      const verdict = await auditor(goal, this.lastTurnText.get(sessionID) ?? "")
      if (verdict.verdict === "not-done") {
        goal.auditNote = verdict.note
        goal.status = "active"
        await saveGoal(goal)
        await this.sendSteer(instanceIdOf(goal), goal, `Auditor rejected completion: ${verdict.note}`)
        return { accepted: false, reason: `Auditor rejected completion: ${verdict.note}` }
      }
      if (verdict.verdict === "blocked") {
        goal.blockedStreak += 1
        goal.status = goal.blockedStreak >= 2 ? "blocked" : "active"
        await saveGoal(goal)
        return { accepted: false, reason: `Auditor says blocked: ${verdict.note}` }
      }
    }

    goal.status = "complete"
    await saveGoal(goal)
    return { accepted: true }
  }

  // --- internals ------------------------------------------------------------

  private scheduleContinuation(instanceId: string, sessionID: string): void {
    this.clearTimer(sessionID)
    const timer = setTimeout(() => {
      this.timers.delete(sessionID)
      void this.onIdle(instanceId, sessionID)
    }, this.deps.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS)
    this.timers.set(sessionID, timer)
  }

  private clearTimer(sessionID: string): void {
    const timer = this.timers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionID)
    }
  }

  private clearInstance(instanceId: string | undefined): void {
    if (!instanceId) return
    // Goal state is per session on disk; running timers clean themselves up
    // when they fire and find no active goal. Nothing instance-wide to drop.
  }

  private async onIdle(instanceId: string, sessionID: string): Promise<void> {
    try {
      const goal = await loadGoal(sessionID)
      if (!goal || goal.status !== "active") return

      goal.turnsUsed += 1
      if (goal.tokenBudget !== null && goal.turnsUsed >= goal.tokenBudget) {
        goal.status = "budget-limited"
      } else if (goal.turnsUsed >= MAX_TURNS) {
        goal.status = "budget-limited"
      }
      await saveGoal(goal)
      if (goal.status !== "active" && goal.status !== "budget-limited") return

      await this.sendSteer(instanceId, goal)
    } catch (error) {
      this.deps.logger.warn({ sessionID, error }, "session-goal continuation failed")
    }
  }

  private async sendSteer(instanceId: string, goal: GoalRecord, extra?: string): Promise<void> {
    const text = extra ? `${steerPrompt(goal)}\n\n${extra}` : steerPrompt(goal)
    const send = this.deps.sendPrompt ?? this.defaultSend.bind(this)
    await send(instanceId, goal.sessionID, text)
  }

  private async defaultSend(instanceId: string, sessionID: string, text: string): Promise<void> {
    const workspaceManager = this.deps.workspaceManager
    if (!workspaceManager) throw new Error("workspaceManager is required to send goal continuations")
    const client = createInstanceClient(workspaceManager, instanceId, {
      directory: this.deps.workspaceDirectory?.(instanceId),
    })
    if (!client) throw new Error("Workspace instance is not ready")
    await client.session.promptAsync(
      {
        sessionID,
        parts: [{ type: "text", text, synthetic: true }],
      },
      { throwOnError: true },
    )
  }

  private async transition(sessionID: string, mutate: (goal: GoalRecord) => void): Promise<GoalRecord | null> {
    const goal = await loadGoal(sessionID)
    if (!goal) return null
    mutate(goal)
    await saveGoal(goal)
    return goal
  }
}

function instanceIdOf(goal: GoalRecord): string {
  return goal.instanceId
}
