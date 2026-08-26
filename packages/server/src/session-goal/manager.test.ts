import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { EventEmitter } from "events"
import { GoalManager, type GoalAuditor } from "./manager"
import { boardComplete, freshGoal, loadGoal, saveGoal, steerPrompt } from "./state"

// state.ts writes under ~/.codenomad/goals; redirect HOME for the test run
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-goal-test-"))
process.env.HOME = fakeHome

class FakeBus extends EventEmitter {}

const fakeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => fakeLogger,
}

interface Sent {
  instanceId: string
  sessionID: string
  text: string
}

function makeManager(overrides: { auditor?: GoalAuditor; sendPrompt?: (i: string, s: string, t: string) => Promise<void> }) {
  const sent: Sent[] = []
  const manager = new GoalManager({
    eventBus: new FakeBus() as never,
    logger: fakeLogger as never,
    idleDelayMs: 5,
    sendPrompt:
      overrides.sendPrompt ??
      (async (instanceId, sessionID, text) => {
        sent.push({ instanceId, sessionID, text })
      }),
    auditor: overrides.auditor,
  })
  return { manager, sent }
}

afterEach(async () => {
  await fs.rm(path.join(fakeHome, ".codenomad", "goals"), { recursive: true, force: true }).catch(() => undefined)
})

describe("goal state", () => {
  it("board is incomplete without evidence on every row", () => {
    const goal = freshGoal("inst", "ses", "objective", null)
    goal.board = [
      { id: 1, deliverable: "a", status: "done", evidence: "src/a.ts:10" },
      { id: 2, deliverable: "b", status: "done", evidence: "" },
    ]
    assert.equal(boardComplete(goal), false)
    goal.board[1].evidence = "test output: 2 passed"
    assert.equal(boardComplete(goal), true)
  })

  it("steer embeds the board and objective", () => {
    const goal = freshGoal("inst", "ses", "ship the login page", null)
    goal.board = [{ id: 1, deliverable: "login form", status: "in-progress", evidence: "" }]
    const prompt = steerPrompt(goal)
    assert.ok(prompt.includes("<goal_context>"))
    assert.ok(prompt.includes("ship the login page"))
    assert.ok(prompt.includes("| 1 | login form | in-progress | — |"))
  })

  it("wrap-up steer forbids new work", () => {
    const goal = freshGoal("inst", "ses", "objective", null)
    goal.status = "budget-limited"
    const prompt = steerPrompt(goal)
    assert.ok(prompt.includes("WRAP-UP MODE"))
    assert.ok(prompt.includes("Do NOT start new substantive work"))
  })
})

describe("GoalManager", () => {
  it("set/get round-trips through disk", async () => {
    const { manager } = makeManager({})
    await manager.set("inst-1", "ses-1", "write the tests", null)
    const goal = await manager.get("ses-1")
    assert.equal(goal?.objective, "write the tests")
    assert.equal(goal?.status, "active")
  })

  it("pause/resume transitions", async () => {
    const { manager } = makeManager({})
    await manager.set("inst-1", "ses-1", "objective", null)
    const paused = await manager.pause("ses-1")
    assert.equal(paused?.status, "paused")
    const resumed = await manager.resume("ses-1")
    assert.equal(resumed?.status, "active")
  })

  it("completion claim is rejected when the board lacks evidence", async () => {
    const { manager } = makeManager({})
    await manager.set("inst-1", "ses-1", "objective", null)
    const result = await manager.noteCompletionClaim("ses-1")
    assert.equal(result.accepted, false)
    assert.ok(result.reason?.includes("board incomplete"))
  })

  it("completion claim is accepted when every row is evidenced", async () => {
    const { manager } = makeManager({})
    await manager.set("inst-1", "ses-1", "objective", null)
    const goal = await loadGoal("ses-1")
    if (!goal) throw new Error("goal missing")
    goal.board = [{ id: 1, deliverable: "a", status: "done", evidence: "src/a.ts" }]
    await saveGoal(goal)

    const result = await manager.noteCompletionClaim("ses-1")
    assert.equal(result.accepted, true)
    const after = await manager.get("ses-1")
    assert.equal(after?.status, "complete")
  })

  it("auditor veto forces a repair steer and keeps the goal active", async () => {
    const sent: Array<{ text: string }> = []
    const auditor: GoalAuditor = async () => ({ verdict: "not-done", note: "row 1 evidence is a claim, not a path" })
    const { manager } = makeManager({
      auditor,
      sendPrompt: async (_i, _s, text) => {
        sent.push({ text })
      },
    })
    await manager.set("inst-1", "ses-1", "objective", null)
    const goal = await loadGoal("ses-1")
    if (!goal) throw new Error("goal missing")
    goal.board = [{ id: 1, deliverable: "a", status: "done", evidence: "looks done" }]
    await saveGoal(goal)

    const result = await manager.noteCompletionClaim("ses-1")
    assert.equal(result.accepted, false)
    assert.ok(result.reason?.includes("row 1 evidence is a claim"))
    const after = await manager.get("ses-1")
    assert.equal(after?.status, "active")
    assert.ok(sent.some((entry) => entry.text.includes("Auditor rejected completion")))
  })

  it("turn budget state math flips to wrap-up", async () => {
    const { manager } = makeManager({})
    await manager.set("inst-1", "ses-1", "objective", 1)
    const goal = await loadGoal("ses-1")
    if (!goal) throw new Error("goal missing")
    goal.turnsUsed = 1
    await saveGoal(goal)
    assert.ok(goal.turnsUsed >= (goal.tokenBudget ?? 0))
  })

  it("drop clears persisted state", async () => {
    const { manager } = makeManager({})
    await manager.set("inst-1", "ses-1", "objective", null)
    await manager.drop("ses-1")
    const goal = await manager.get("ses-1")
    assert.equal(goal, null)
  })
})
