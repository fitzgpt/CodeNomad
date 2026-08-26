import { promises as fs } from "fs"
import os from "os"
import path from "path"

export type GoalStatus = "active" | "paused" | "blocked" | "budget-limited" | "complete" | "dropped"

export type BoardRowStatus = "pending" | "in-progress" | "done" | "blocked"

export interface BoardRow {
  id: number
  deliverable: string
  status: BoardRowStatus
  evidence: string
}

export interface GoalRecord {
  id: string
  instanceId: string
  sessionID: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  turnsUsed: number
  blockedStreak: number
  auditNote: string
  board: BoardRow[]
  createdAt: number
  updatedAt: number
}

export const MAX_TURNS = 40

export function freshGoal(instanceId: string, sessionID: string, objective: string, tokenBudget: number | null): GoalRecord {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    instanceId,
    sessionID,
    objective,
    status: "active",
    tokenBudget,
    turnsUsed: 0,
    blockedStreak: 0,
    auditNote: "",
    board: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function boardComplete(goal: GoalRecord): boolean {
  return goal.board.length > 0 && goal.board.every((row) => row.status === "done" && row.evidence.trim().length > 0)
}

export function boardRender(goal: GoalRecord): string {
  if (goal.board.length === 0) {
    return "(board empty — parse the objective into 2-6 deliverables with goal tool op:board in your first goal turn)"
  }
  const rows = goal.board.map(
    (row) => `| ${row.id} | ${row.deliverable} | ${row.status} | ${row.evidence.length > 0 ? row.evidence : "—"} |`,
  )
  return ["| # | deliverable | status | evidence |", "|---|---|---|---|", ...rows].join("\n")
}

export function steerPrompt(goal: GoalRecord): string {
  const budgetLine =
    goal.tokenBudget === null
      ? "No token budget set."
      : `Budget: ${goal.tokenBudget} tokens; turn ${goal.turnsUsed}/${MAX_TURNS}.`
  const wrapUp = goal.status === "budget-limited"
  const body = wrapUp
    ? [
        "BUDGET LIMIT REACHED — WRAP-UP MODE. Do NOT start new substantive work.",
        "1. Update the board: mark what is actually done, with evidence (file path or command output).",
        "2. Write a handoff note listing remaining work and blockers.",
        "3. Reply with the handoff note and stop. Budget exhaustion is a success state, not a failure.",
      ].join("\n")
    : [
        "Continue working toward the objective.",
        "This turn: advance one or more board rows. Before finishing, record status + evidence for what you did (evidence = file path or command output, not claims).",
        "Completion is only accepted when every board row is done WITH evidence. If a row is genuinely blocked, mark it blocked and explain why.",
      ].join("\n")
  return [
    "<goal_context>",
    `Objective: ${goal.objective}`,
    budgetLine,
    "",
    "Evidence board:",
    boardRender(goal),
    goal.auditNote ? `Auditor note: ${goal.auditNote}` : "",
    "",
    body,
    "</goal_context>",
  ]
    .filter((line, index) => line.length > 0 || index === 4 || index === 8)
    .join("\n")
}

// --- persistence: one JSON file per session, under ~/.codenomad/goals -------

function goalsDir(): string {
  return path.join(os.homedir(), ".codenomad", "goals")
}

function fileFor(sessionID: string): string {
  // sessionIDs are opaque SDK ids; flatten to a safe filename
  const safe = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")
  return path.join(goalsDir(), `${safe}.json`)
}

export async function saveGoal(goal: GoalRecord): Promise<void> {
  goal.updatedAt = Date.now()
  await fs.mkdir(goalsDir(), { recursive: true })
  await fs.writeFile(fileFor(goal.sessionID), JSON.stringify(goal, null, 2), "utf8")
}

export async function loadGoal(sessionID: string): Promise<GoalRecord | null> {
  try {
    const raw = await fs.readFile(fileFor(sessionID), "utf8")
    return JSON.parse(raw) as GoalRecord
  } catch {
    return null
  }
}

export async function deleteGoal(sessionID: string): Promise<void> {
  await fs.rm(fileFor(sessionID), { force: true }).catch(() => undefined)
}
