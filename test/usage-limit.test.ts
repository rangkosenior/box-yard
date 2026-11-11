import { describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { parseUsageLimit } from "../shared/usageLimit.js"
import { fullLimits, readClaudeUsage, USAGE_ENDPOINT, type UsageReading } from "../server/claudeUsage.js"
import { ATTEMPT_WINDOW_MS, BUFFER_MS, MAX_ATTEMPTS, MONTHLY_RECHECK_MS, RECHECK_MS, TRIAL_MS, UsageLimitWatch, type StalledItem } from "../server/usageLimitWatch.js"
import { tmpDir } from "./helpers.js"

describe("parseUsageLimit", () => {
  // 2:00 pm in Chicago (UTC-6 in November).
  const now = Date.parse("2026-11-10T20:00:00Z")

  it("reads a monthly spend limit with the 5-hour reset time and its time zone", () => {
    const hit = parseUsageLimit("You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your 5-hour limit resets 6:20pm (America/Chicago)", now)
    expect(hit).toEqual({ kind: "monthly", resetsAt: Date.parse("2026-11-11T00:20:00Z") })
  })

  it("moves a time of day that has passed to tomorrow, and reads a date", () => {
    expect(parseUsageLimit("5-hour limit reached ∙ resets 1pm (America/Chicago)", now)).toEqual({ kind: "five_hour", resetsAt: Date.parse("2026-11-11T19:00:00Z") })
    expect(parseUsageLimit("Weekly limit reached ∙ resets Nov 15, 5pm (America/Chicago)", now)).toEqual({ kind: "weekly", resetsAt: Date.parse("2026-11-15T23:00:00Z") })
  })

  it("follows daylight saving in the named zone", () => {
    const july = Date.parse("2026-07-10T20:00:00Z")
    expect(parseUsageLimit("Your 5-hour limit resets 6:20pm (America/Chicago)", july)?.resetsAt).toBe(Date.parse("2026-07-10T23:20:00Z"))
  })

  it("reads a unix stamp and a relative time", () => {
    expect(parseUsageLimit("Claude AI usage limit reached|1794400000", now)).toEqual({ kind: "unknown", resetsAt: 1794400000_000 })
    expect(parseUsageLimit("5-hour limit reached ∙ resets in 2 hours 15 minutes", now)?.resetsAt).toBe(now + 2 * 3600_000 + 15 * 60_000)
  })

  it("has no reset time when the text gives none", () => {
    expect(parseUsageLimit("You've hit your monthly spend limit", now)).toEqual({ kind: "monthly", resetsAt: null })
  })

  it("ignores other failures, including a rate-limit burst", () => {
    expect(parseUsageLimit("API Error: 429 rate_limit_error: usage limit", now)).toBeNull()
    expect(parseUsageLimit("The agent exited with an error.", now)).toBeNull()
    expect(parseUsageLimit("", now)).toBeNull()
  })
})

describe("the usage probe", () => {
  const fiveHour = (percent: number) => ({ kind: "session", percent, resets_at: "2026-11-11T05:30:00+00:00" })

  it("reads which windows are full from the endpoint's answer", () => {
    expect(fullLimits({ limits: [fiveHour(24), { kind: "weekly_all", percent: 33, resets_at: "2026-11-15T17:00:00+00:00" }] })).toEqual([])
    expect(fullLimits({ limits: [fiveHour(100), { kind: "weekly_all", percent: 100, resets_at: "2026-11-15T17:00:00+00:00" }] })).toEqual([
      { kind: "five_hour", resetsAt: Date.parse("2026-11-11T05:30:00Z") },
      { kind: "weekly", resetsAt: Date.parse("2026-11-15T17:00:00Z") },
    ])
    expect(fullLimits({ five_hour: { utilization: 100, resets_at: "2026-11-11T05:30:00+00:00" }, seven_day: { utilization: 5 } })).toEqual([{ kind: "five_hour", resetsAt: Date.parse("2026-11-11T05:30:00Z") }])
    expect(fullLimits({ limits: [], extra_usage: { is_enabled: true, spend_limit_reached: true } })).toEqual([{ kind: "monthly", resetsAt: null }])
    // A spend cap that is switched off isn't a limit.
    expect(fullLimits({ limits: [], extra_usage: { is_enabled: false, spend_limit_reached: true }, spend: { enabled: false, percent: 100 } })).toEqual([])
    expect(fullLimits("nope")).toBeNull()
  })

  function login(creds: unknown) {
    const dir = tmpDir("claude-home-")
    if (creds !== undefined) fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify(creds))
    return dir
  }
  const reply = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

  it("asks the endpoint with the saved token, and never gives the token back", async () => {
    const claudeDir = login({ claudeAiOauth: { accessToken: "sk-ant-oat-secret-token", expiresAt: Date.now() + 3600_000 } })
    const fetchImpl = reply(200, { limits: [fiveHour(100)] })
    const reading = await readClaudeUsage({ claudeDir, fetchImpl })
    expect(reading).toEqual({ ok: true, full: [{ kind: "five_hour", resetsAt: Date.parse("2026-11-11T05:30:00Z") }] })
    expect(JSON.stringify(reading)).not.toContain("secret")
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(USAGE_ENDPOINT)
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ant-oat-secret-token")
  })

  it("says why it can't tell, without asking when there is no usable token", async () => {
    const never = reply(200)
    expect(await readClaudeUsage({ claudeDir: login(undefined), fetchImpl: never })).toEqual({ ok: false, why: "no_login" })
    expect(await readClaudeUsage({ claudeDir: login({ claudeAiOauth: { accessToken: "t", expiresAt: 1000 } }), fetchImpl: never, now: 5000 })).toEqual({ ok: false, why: "expired" })
    expect(never).not.toHaveBeenCalled()
    const ok = login({ claudeAiOauth: { accessToken: "t" } })
    expect(await readClaudeUsage({ claudeDir: ok, fetchImpl: reply(401) })).toEqual({ ok: false, why: "refused" })
    expect(await readClaudeUsage({ claudeDir: ok, fetchImpl: reply(429) })).toEqual({ ok: false, why: "rate_limited" })
    expect(await readClaudeUsage({ claudeDir: ok, fetchImpl: reply(500) })).toEqual({ ok: false, why: "bad_answer" })
    expect(await readClaudeUsage({ claudeDir: ok, fetchImpl: vi.fn(async () => { throw new Error("down: sk-ant-oat-t") }) })).toEqual({ ok: false, why: "unreachable" })
  })
})

describe("UsageLimitWatch", () => {
  const T0 = Date.parse("2026-11-10T20:00:00Z")
  const task = (id: string): StalledItem => ({ type: "task", id })

  function setup(over: { probe?: () => Promise<UsageReading>; enabled?: boolean; resume?: (i: StalledItem) => boolean } = {}) {
    let now = T0
    const kv = new Map<string, string>()
    const resumed: string[] = []
    const notices: string[] = []
    const enabled = { on: over.enabled ?? true }
    let reading: UsageReading = over.probe ? { ok: false, why: "unreachable" } : { ok: true, full: [] }
    const probe = vi.fn(over.probe ?? (async () => reading))
    const watch = new UsageLimitWatch({
      kv: { get: (k) => kv.get(k) ?? null, set: (k, v) => void (v === null ? kv.delete(k) : kv.set(k, v)) },
      enabled: () => enabled.on,
      probe,
      resume: (i) => {
        const ok = over.resume ? over.resume(i) : true
        if (ok) resumed.push(`${i.type}:${i.id}`)
        return ok
      },
      notice: (t) => void notices.push(t),
      now: () => now,
    })
    return { watch, kv, resumed, notices, probe, enabled, advance: (ms: number) => void (now += ms), setReading: (r: UsageReading) => void (reading = r), at: () => now }
  }

  it("says work paused once, and resumes in the order it stalled once the limit is clear", async () => {
    const s = setup()
    s.watch.stall(task("b"), { kind: "five_hour", resetsAt: T0 + 3600_000 })
    s.advance(1000)
    s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 + 3600_000 })
    s.watch.stall({ type: "coordinator", id: "coordinator" }, { kind: "five_hour", resetsAt: T0 + 3600_000 })
    expect(s.notices).toHaveLength(1)
    expect(s.notices[0]).toMatch(/^⚠ \*\*Usage limit\*\* paused work: Claude's 5-hour limit is used up\. It resets .*Work that stopped on it resumes by itself/)

    // Before the reset time nothing is asked and nothing resumes.
    s.advance(60_000)
    await s.watch.check()
    expect(s.probe).not.toHaveBeenCalled()
    expect(s.resumed).toEqual([])

    s.advance(3600_000)
    await s.watch.check()
    expect(s.probe).toHaveBeenCalledTimes(1)
    expect(s.resumed).toEqual(["task:b", "task:a", "coordinator:coordinator"])
    expect(s.notices[1]).toBe("▶ **Usage limit** cleared: 2 tasks and the Coordinator resumed.")
    expect(s.kv.get("usage_limit_pause")).toBeTruthy()
    s.watch.stop()
  })

  it("waits the buffer after the reset time before asking", async () => {
    const s = setup()
    s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 + 1000 })
    s.advance(1000 + BUFFER_MS - 1)
    await s.watch.check()
    expect(s.probe).not.toHaveBeenCalled()
    s.advance(1)
    await s.watch.check()
    expect(s.resumed).toEqual(["task:a"])
    s.watch.stop()
  })

  it("keeps waiting while the limit is still full, until the window the endpoint names resets", async () => {
    const s = setup()
    s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 })
    s.setReading({ ok: true, full: [{ kind: "five_hour", resetsAt: T0 + 2 * 3600_000 }] })
    s.advance(BUFFER_MS)
    await s.watch.check()
    expect(s.resumed).toEqual([])
    s.advance(30 * 60_000)
    await s.watch.check()
    expect(s.resumed).toEqual([])
    s.advance(2 * 3600_000)
    s.setReading({ ok: true, full: [] })
    await s.watch.check()
    expect(s.resumed).toEqual(["task:a"])
    s.watch.stop()
  })

  it("keeps checking a monthly limit with no reset time until it clears, which also covers it being raised", async () => {
    const s = setup()
    s.watch.stall(task("a"), { kind: "monthly", resetsAt: null })
    s.setReading({ ok: true, full: [{ kind: "monthly", resetsAt: null }] })
    for (let i = 0; i < 3; i++) {
      s.advance(MONTHLY_RECHECK_MS)
      await s.watch.check()
    }
    expect(s.probe).toHaveBeenCalledTimes(3)
    expect(s.resumed).toEqual([])
    s.setReading({ ok: true, full: [] })
    s.advance(MONTHLY_RECHECK_MS)
    await s.watch.check()
    expect(s.resumed).toEqual(["task:a"])
    s.watch.stop()
  })

  it("lets a 5-hour stall resume when only the spend cap is full, but not a monthly one", async () => {
    const s = setup()
    s.watch.stall(task("five"), { kind: "five_hour", resetsAt: T0 })
    s.watch.stall(task("month"), { kind: "monthly", resetsAt: T0 })
    s.setReading({ ok: true, full: [{ kind: "monthly", resetsAt: null }] })
    s.advance(BUFFER_MS)
    await s.watch.check()
    expect(s.resumed).toEqual(["task:five"])
    s.watch.stop()
  })

  it("goes by the reset time alone when the endpoint can't answer, and for a login it doesn't speak for", async () => {
    const s = setup({ probe: async () => ({ ok: false, why: "expired" }) })
    s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 + 1000 })
    s.watch.stall(task("other"), { kind: "five_hour", resetsAt: T0 + 1000 }, false)
    s.advance(1000 + BUFFER_MS)
    await s.watch.check()
    expect(s.resumed).toEqual(["task:a", "task:other"])
    s.watch.stop()
  })

  it("makes one quiet trial an hour when there is no reset time and no answer", async () => {
    const s = setup({ probe: async () => ({ ok: false, why: "expired" }) })
    s.watch.stall(task("a"), { kind: "monthly", resetsAt: null })
    s.advance(RECHECK_MS)
    await s.watch.check()
    expect(s.resumed).toEqual(["task:a"])
    // It failed again (a new stall): no second "paused" notice, and no trial for an hour.
    s.watch.stall(task("a"), { kind: "monthly", resetsAt: null })
    expect(s.notices.filter((n) => n.includes("paused"))).toHaveLength(1)
    s.advance(RECHECK_MS)
    await s.watch.check()
    expect(s.resumed).toEqual(["task:a"])
    s.advance(TRIAL_MS)
    await s.watch.check()
    expect(s.resumed).toEqual(["task:a", "task:a"])
    // Trials never said "cleared", and don't use up the resumes.
    expect(s.notices.filter((n) => n.includes("cleared"))).toHaveLength(0)
    expect(s.watch.stall(task("a"), { kind: "monthly", resetsAt: null })).toBe(true)
    s.watch.stop()
  })

  it("stops resuming an item after a few resumes in a day, so it can't loop", async () => {
    const s = setup()
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 })).toBe(true)
      s.advance(BUFFER_MS)
      await s.watch.check()
      s.advance(20 * 60_000)
    }
    expect(s.resumed).toHaveLength(MAX_ATTEMPTS)
    expect(s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 })).toBe(false)
    expect(s.watch.has(task("a"))).toBe(false)
    // Another item is unaffected, and a day later the first one may be paused again.
    expect(s.watch.stall(task("b"), { kind: "five_hour", resetsAt: T0 })).toBe(true)
    s.advance(ATTEMPT_WINDOW_MS)
    expect(s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 })).toBe(true)
    s.watch.stop()
  })

  it("drops what no longer needs resuming, without saying it resumed", async () => {
    const s = setup({ resume: () => false })
    s.watch.stall(task("gone"), { kind: "five_hour", resetsAt: T0 })
    s.advance(BUFFER_MS)
    await s.watch.check()
    expect(s.watch.has(task("gone"))).toBe(false)
    expect(s.notices.filter((n) => n.includes("cleared"))).toHaveLength(0)
    s.watch.stop()
  })

  it("doesn't pause when the setting is off, and lets go of waiting work when it is turned off", async () => {
    const off = setup({ enabled: false })
    expect(off.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 })).toBe(false)
    expect(off.notices).toEqual([])
    off.watch.stop()

    const s = setup()
    s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 })
    s.enabled.on = false
    s.advance(BUFFER_MS)
    await s.watch.check()
    expect(s.resumed).toEqual([])
    expect(s.notices.at(-1)).toMatch(/auto-resume is off/)
    s.watch.stop()
  })

  it("carries what it waits on across a restart", async () => {
    const s = setup()
    s.watch.stall(task("a"), { kind: "five_hour", resetsAt: T0 + 3600_000 })
    s.watch.stop()
    const again = new UsageLimitWatch({ kv: { get: (k) => s.kv.get(k) ?? null, set: (k, v) => void (v === null ? s.kv.delete(k) : s.kv.set(k, v)) }, enabled: () => true, probe: async () => ({ ok: true, full: [] }), resume: () => true, notice: () => {}, now: () => T0 })
    again.start()
    expect(again.has(task("a"))).toBe(true)
    again.stop()
  })
})
