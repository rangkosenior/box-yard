import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { attributeCompute, buildUsageLedger, computeProvider, isDipBooking, type LedgerClaudeRow, type LedgerInput } from "../server/usageLedger.js"
import { aggregateUsage, modelLabel, NONE, TOKEN_KINDS, type UsageFilter, type UsageGroup, type UsageLedger } from "../shared/usageLedger.js"
import { DAYTONA_RATES } from "../shared/daytona.js"
import { tmpDir } from "./helpers.js"

const H = 3_600_000
const D = 24 * H
const T0 = Date.UTC(2026, 10, 1)
const days = (n: number) => Array.from({ length: n }, (_, i) => T0 + i * D)
const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0)
const rates = { upstashCpuHourUsd: { small: 0.1, medium: 0.2, large: 0.4 }, daytona: { vcpuHour: DAYTONA_RATES.vcpuHour, memoryGibHour: DAYTONA_RATES.memoryGibHour } }

function claudeRow(r: Partial<LedgerClaudeRow>): LedgerClaudeRow {
  return {
    source: "task",
    runKind: "turn",
    projectId: "prj_a",
    taskId: "tsk_1",
    sessionId: null,
    model: "claude-opus-5-5",
    loginId: null,
    startedAt: T0 + H,
    costUsd: 1,
    reportedUsd: 0,
    prevReportedUsd: null,
    costEstimated: false,
    inputTokens: 100,
    cacheCreationInputTokens: 200,
    cacheReadInputTokens: 3000,
    outputTokens: 40,
    ...r,
  }
}

function input(over: Partial<LedgerInput>): LedgerInput {
  return {
    from: T0,
    to: T0 + 3 * D,
    days: days(3),
    claude: [],
    sessionRates: new Map(),
    intervals: [],
    pods: [],
    turns: [],
    names: { projects: { prj_a: "Alpha", prj_b: "Beta" }, tasks: { tsk_1: { title: "One", projectId: "prj_a" }, tsk_2: { title: "Two", projectId: "prj_b" } }, boxes: {}, logins: {} },
    rates,
    ...over,
  }
}

/** A ledger with LLM spend of every role and compute on every kind of provider, over three days. */
function sampleLedger(): UsageLedger {
  return buildUsageLedger(
    input({
      claude: [
        claudeRow({ startedAt: T0 + H, costUsd: 2 }),
        claudeRow({ startedAt: T0 + D + H, costUsd: 3, model: "claude-sonnet-5-5", taskId: "tsk_2", projectId: "prj_b" }),
        claudeRow({ startedAt: T0 + 2 * D, costUsd: 0.5, source: "orchestrator", projectId: null, taskId: null }),
        claudeRow({ startedAt: T0 + 2 * D + H, costUsd: 0.25, source: "captain", projectId: "prj_b", taskId: null, model: "claude-haiku-5-5" }),
        claudeRow({ startedAt: T0 + 2 * D + 2 * H, costUsd: 0.1, source: "orchestrator", runKind: "thread", projectId: null, taskId: null, model: "claude-fable-5-1" }),
        claudeRow({ startedAt: T0 + 2 * D + 3 * H, costUsd: 0.05, model: "gpt-5", costEstimated: true }),
      ],
      intervals: [
        { boxId: "pure-lobster", provider: "upstash", startedAt: T0, endedAt: T0 + 2 * D, costUsd: 4.8, source: "measured" },
        { boxId: "daytona-prj_b", provider: "daytona", startedAt: T0 + D, endedAt: T0 + D + 2 * H, costUsd: 0.6, source: "estimated" },
        { boxId: "docker-prj_a", provider: "docker", startedAt: T0, endedAt: T0 + H, costUsd: 0.1, source: "estimated" },
      ],
      pods: [{ boxId: "runpod-prj_a", provider: "runpod", startedAt: T0 + 2 * D, endedAt: T0 + 2 * D + 3 * H, usdPerHour: 0.5 }],
      turns: [
        { taskId: "tsk_1", projectId: "prj_a", boxId: "pure-lobster", startedAt: T0, endedAt: T0 + 6 * H },
        { taskId: "tsk_2", projectId: "prj_b", boxId: "pure-lobster", startedAt: T0 + 3 * H, endedAt: T0 + 9 * H },
        { taskId: "tsk_1", projectId: "prj_a", boxId: null, startedAt: T0 + 2 * D, endedAt: T0 + 2 * D + H },
      ],
    }),
  )
}

/** The view adds up: cost series, days and every table to the total; token series and days to the token total. */
function expectReconciles(ledger: UsageLedger, filter: UsageFilter) {
  for (const group of ["project", "task", "model", "provider", "role", "login", "box"] as UsageGroup[]) {
    const v = aggregateUsage(ledger, filter, group)
    const total = v.totals.costUsd
    expect(v.totals.llmUsd + v.totals.computeUsd).toBeCloseTo(total, 9)
    expect(sum(v.cost.map((s) => s.totalUsd)), `${group}: series`).toBeCloseTo(total, 9)
    for (const s of v.cost) expect(sum(s.daily)).toBeCloseTo(s.totalUsd, 9)
    expect(sum(v.costByDay), `${group}: days`).toBeCloseTo(total, 9)
    expect(sum(v.rows.map((r) => r.costUsd)), `${group}: table`).toBeCloseTo(total, 9)
    expect(sum(v.rows.map((r) => r.llmUsd)), `${group}: table LLM`).toBeCloseTo(v.totals.llmUsd, 9)
    expect(sum(v.rows.map((r) => r.computeUsd)), `${group}: table compute`).toBeCloseTo(v.totals.computeUsd, 9)
    expect(sum(v.rows.map((r) => r.tokens)), `${group}: table tokens`).toBe(v.totals.tokens.total)
    expect(sum(v.tokens.map((t) => t.total))).toBe(v.totals.tokens.total)
    expect(sum(v.tokensByDay)).toBe(v.totals.tokens.total)
    for (const k of TOKEN_KINDS) expect(sum(v.tokens.find((t) => t.kind === k)!.daily)).toBe(v.totals.tokens[k])
    expect(v.totals.estimatedUsd).toBeLessThanOrEqual(total + 1e-9)
  }
}

describe("usage ledger aggregation", () => {
  it("every series, day and breakdown table sums to the period total, filtered or not", () => {
    const ledger = sampleLedger()
    const filters: UsageFilter[] = [
      {},
      { projectId: "prj_a" },
      { projectId: NONE },
      { taskId: "tsk_1" },
      { taskId: NONE },
      { model: "claude-opus-5-5" },
      { provider: "upstash" },
      { role: "agent" },
      { role: "coordinator" },
      { kind: "compute" },
      { kind: "llm", projectId: "prj_b" },
    ]
    for (const f of filters) expectReconciles(ledger, f)
  })

  it("a table row gathers every ledger row its key covers: all tasks' box time under Task agents, each box's under it", () => {
    const l = sampleLedger()
    const compute = (f: (r: UsageLedger["compute"][number]) => boolean) => sum(l.compute.filter(f).map((r) => r.costUsd))
    const byRole = aggregateUsage(l, {}, "role").rows
    expect(new Set(l.compute.filter((r) => r.taskId).map((r) => r.taskId)).size).toBeGreaterThan(1)
    expect(byRole.find((r) => r.key === "role:agent")!.computeUsd).toBeCloseTo(compute((r) => r.taskId !== null), 9)
    expect(byRole.find((r) => r.key === "role:idle")!.computeUsd).toBeCloseTo(compute((r) => r.taskId === null), 9)
    const byBox = aggregateUsage(l, {}, "box").rows
    for (const boxId of new Set(l.compute.map((r) => r.boxId))) expect(byBox.find((r) => r.key === `box:${boxId}`)!.computeUsd).toBeCloseTo(compute((r) => r.boxId === boxId), 9)
  })

  it("splits the period into LLM by model and compute by provider", () => {
    const v = aggregateUsage(sampleLedger(), {}, "provider")
    expect(v.totals.llmUsd).toBeCloseTo(2 + 3 + 0.5 + 0.25 + 0.1 + 0.05, 9)
    expect(v.totals.computeUsd).toBeCloseTo(4.8 + 0.6 + 1.5, 9)
    // The three dearest models get colours; the rest fold into "Other models". Docker is $0, so it has no series.
    expect(v.cost.map((s) => s.key)).toEqual(["model:claude-sonnet-5-5", "model:claude-opus-5-5", "model:claude-haiku-5-5", "other-models", "provider:upstash", "provider:daytona", "provider:runpod"])
    expect(v.rows.find((r) => r.key === "provider:docker")).toMatchObject({ costUsd: 0, computeHours: 1, detail: "Your own hardware: $0" })
    // Compute priced from size × time, and the run the CLI didn't price, are estimates; Upstash measured CPU at Settings' rates too.
    expect(v.totals.estimatedUsd).toBeCloseTo(4.8 + 0.6 + 1.5 + 0.05, 9)
  })

  it("names each model's spend by its label, Fable 5.2 and Fable 5.1 apart", () => {
    expect(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5-20261001", "my-proxy-model", "unknown"].map(modelLabel)).toEqual(["Fable 5.2", "Fable 5.1", "Opus 5.5", "my-proxy-model", "Unknown model"])
  })

  it("narrows by filter: a model has no compute, a provider has no LLM, a role's compute is its tasks' box time", () => {
    const l = sampleLedger()
    expect(aggregateUsage(l, { model: "claude-opus-5-5" }, "task").totals.computeUsd).toBe(0)
    expect(aggregateUsage(l, { provider: "runpod" }, "task").totals).toMatchObject({ llmUsd: 0, computeUsd: 1.5 })
    const agent = aggregateUsage(l, { role: "agent" }, "task")
    expect(agent.totals.llmUsd).toBeCloseTo(2 + 3 + 0.05, 9)
    expect(agent.rows.map((r) => r.key)).not.toContain("task:idle")
    expect(aggregateUsage(l, { role: "captain" }, "task").totals).toMatchObject({ llmUsd: 0.25, computeUsd: 0 })
  })
})

describe("compute cost estimate", () => {
  it("splits a box's stretch between the turns running on it, equally while they overlap, and the rest is idle", () => {
    // 10 h of an Upstash box at $1/h. Task 1 runs 0–4 h, task 2 runs 2–6 h; 6–10 h nothing runs.
    const rows = attributeCompute({
      from: T0,
      to: T0 + D,
      days: days(1),
      intervals: [{ boxId: "box-a", provider: "upstash", startedAt: T0, endedAt: T0 + 10 * H, costUsd: 10, source: "measured" }],
      pods: [],
      turns: [
        { taskId: "t1", projectId: "p1", boxId: "box-a", startedAt: T0, endedAt: T0 + 4 * H },
        { taskId: "t2", projectId: "p2", boxId: "box-a", startedAt: T0 + 2 * H, endedAt: T0 + 6 * H },
        { taskId: "t3", projectId: "p3", boxId: "box-b", startedAt: T0, endedAt: T0 + 10 * H },
      ],
    })
    const of = (taskId: string | null) => rows.find((r) => r.taskId === taskId)!
    expect(of("t1").costUsd).toBeCloseTo(2 + 1, 9)
    expect(of("t2").costUsd).toBeCloseTo(1 + 2, 9)
    expect(of(null)).toMatchObject({ projectId: null, estimated: true })
    expect(of(null).costUsd).toBeCloseTo(4, 9)
    expect(sum(rows.map((r) => r.hours))).toBeCloseTo(10, 9)
    expect(rows.find((r) => r.taskId === "t3")).toBeUndefined()
  })

  it("splits at day starts, clips to the range, and prices a pod at its $/hr", () => {
    const rows = attributeCompute({
      from: T0,
      to: T0 + 2 * D,
      days: days(2),
      intervals: [],
      // From 2 h before the range to 2 h into its second day, at $0.60/h: 22 h + 2 h in range.
      pods: [{ boxId: "vastai-prj_a", provider: "vast", startedAt: T0 - 2 * H, endedAt: T0 + D + 2 * H, usdPerHour: 0.6 }],
      turns: [],
    })
    expect(rows.map((r) => [r.day, r.provider, r.projectId, r.taskId])).toEqual([
      [0, "vast", "prj_a", null],
      [1, "vast", "prj_a", null],
    ])
    expect(rows[0]!.costUsd).toBeCloseTo(0.6 * 24, 9)
    expect(rows[1]!.costUsd).toBeCloseTo(0.6 * 2, 9)
    expect(rows.every((r) => r.estimated)).toBe(true)
  })

  it("gives a GPU or Docker box's unrecorded turns to its project's tasks, and costs Cody's own hardware nothing", () => {
    const rows = attributeCompute({
      from: T0,
      to: T0 + D,
      days: days(1),
      intervals: [
        { boxId: "daytona-prj_a", provider: "daytona", startedAt: T0, endedAt: T0 + 2 * H, costUsd: 0.4, source: "estimated" },
        { boxId: "local-1", provider: "local", startedAt: T0, endedAt: T0 + 2 * H, costUsd: 0.4, source: "estimated" },
        { boxId: "ssh-m1", provider: "ssh", startedAt: T0, endedAt: T0 + 2 * H, costUsd: 0.4, source: "estimated" },
      ],
      pods: [],
      turns: [{ taskId: "t1", projectId: "prj_a", boxId: null, startedAt: T0, endedAt: T0 + 2 * H }],
    })
    expect(rows.find((r) => r.boxId === "daytona-prj_a")).toMatchObject({ provider: "daytona", taskId: "t1", projectId: "prj_a", costUsd: 0.4, estimated: true })
    expect(rows.find((r) => r.boxId === "local-1")).toMatchObject({ provider: "local", taskId: null, costUsd: 0, estimated: false })
    expect(rows.find((r) => r.boxId === "ssh-m1")).toMatchObject({ provider: "ssh", costUsd: 0 })
  })

  it("knows where a box ran from its id and provider", () => {
    expect(computeProvider("pure-lobster", "upstash")).toBe("upstash")
    expect(computeProvider("runpod-prj_a-2", "runpod")).toBe("runpod")
    expect(computeProvider("vastai-prj_a", "vast")).toBe("vast")
    expect(computeProvider("docker-prj_a", "docker")).toBe("docker")
    expect(computeProvider("ssh-m1", "local")).toBe("ssh")
    expect(computeProvider("local-abc", "local")).toBe("local")
  })
})

describe("the runCost dip guard", () => {
  it("recognises a dip booking, never a real reset, a normal step or a compaction", () => {
    expect(isDipBooking({ reportedUsd: 74.54, prevReportedUsd: 82, costUsd: 74.54 })).toBe(true)
    expect(isDipBooking({ reportedUsd: 30, prevReportedUsd: 82, costUsd: 30 })).toBe(false) // a real reset
    expect(isDipBooking({ reportedUsd: 90, prevReportedUsd: 82, costUsd: 8 })).toBe(false) // the usual step
    expect(isDipBooking({ reportedUsd: 74.54, prevReportedUsd: 82, costUsd: 74.54, costEstimated: true })).toBe(false) // already priced from tokens
    expect(isDipBooking({ reportedUsd: 0.3, prevReportedUsd: null, costUsd: 0.3 })).toBe(false)
  })

  it("charges a dip booking its tokens at its session's own rate and says so", () => {
    const ledger = buildUsageLedger(
      input({
        claude: [claudeRow({ source: "orchestrator", projectId: null, taskId: null, sessionId: "s1", reportedUsd: 74.54, prevReportedUsd: 82, costUsd: 74.54 })],
        sessionRates: new Map([["s1", 1e-5]]),
      }),
    )
    const tokens = 100 + 200 + 3000 + 40
    expect(ledger.llm[0]!.costUsd).toBeCloseTo(tokens * 1e-5, 9)
    expect(ledger.llm[0]!.estimatedUsd).toBeCloseTo(tokens * 1e-5, 9)
    expect(ledger.repriced).toMatchObject({ runs: 1, bookedUsd: 74.54 })
  })

  it("the store reprices the dip from the session's other runs and leaves everything else as booked", () => {
    const store = memStore()
    const t = T0 + H
    const run = (i: number, reported: number, tokens: number, runKind = "turn") =>
      store.recordClaudeUsage({ source: "orchestrator", runKind, sessionId: "s1", model: "claude-opus-5-5", startedAt: t + i * 1000, endedAt: t + i * 1000, usage: { input_tokens: tokens }, costUsd: reported })
    run(1, 10, 100_000) // $10 for 100k tokens: $0.0001 a token
    run(2, 12, 20_000) // +$2
    run(3, 11.5, 1000) // dipped: runCost books the whole $11.50
    run(4, 0.3, 0, "compact") // a real reset (under half): its own cost
    const ledger = store.usageLedger(T0, T0 + D, days(1), new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" }).get().costRates)
    expect(ledger.repriced).toMatchObject({ runs: 1, bookedUsd: 11.5 })
    expect(ledger.repriced.chargedUsd).toBeCloseTo(1000 * (12 / 120_000), 9)
    expect(sum(ledger.llm.map((r) => r.costUsd))).toBeCloseTo(10 + 2 + 0.1 + 0.3, 9)
  })
})

describe("Store.usageLedger compute", () => {
  it("reads box intervals, RunPod pods from the box history and turns' boxes", () => {
    const store = memStore()
    const settings = new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" })
    const db = (store as unknown as { db: import("../server/db.js").DB }).db
    const p = store.createProject({ name: "Alpha" })
    const task = store.createTask({ projectId: p.id, title: "One", prompt: "x" })
    store.startTaskTurn({ id: "turn_1", taskId: task.id, turnIndex: 1, model: null, effort: null, routingRule: null, routingReason: null, boxId: "pure-lobster" })
    db.prepare("UPDATE task_turns SET started_at = ?, finished_at = ? WHERE id = 'turn_1'").run(T0 + H, T0 + 3 * H)
    store.recordBoxUsageInterval({ boxId: "pure-lobster", provider: "upstash", size: "small", keepAlive: false, startedAt: T0, endedAt: T0 + 4 * H, activeMs: 4 * H, uptimeMs: 4 * H, source: "measured" })
    db.prepare("INSERT INTO box_events (at, box_id, type, actor, detail, projects_json, task_ids_json) VALUES (?, ?, 'created', 'scheduler', ?, '[]', '[]')").run(T0 + 5 * H, `runpod-${p.id}`, "A5000 in EU-RO-1 at $0.27/hr")
    db.prepare("INSERT INTO box_events (at, box_id, type, actor, detail, projects_json, task_ids_json) VALUES (?, ?, 'deleted', 'janitor', 'pod terminated', '[]', '[]')").run(T0 + 7 * H, `runpod-${p.id}`)
    const ledger = store.usageLedger(T0, T0 + D, days(1), settings.get().costRates)
    const upstash = ledger.compute.filter((r) => r.provider === "upstash")
    // 4 CPU-hours on a small box at $0.10, half of it while the task's turn ran.
    expect(sum(upstash.map((r) => r.costUsd))).toBeCloseTo(0.4, 9)
    expect(upstash.find((r) => r.taskId === task.id)!.costUsd).toBeCloseTo(0.2, 9)
    const pod = ledger.compute.find((r) => r.provider === "runpod")!
    expect(pod).toMatchObject({ projectId: p.id, taskId: null, estimated: true })
    expect(pod.costUsd).toBeCloseTo(0.27 * 2, 9)
    expect(ledger.tasks[task.id]).toEqual({ title: "One", projectId: p.id })
  })
})
