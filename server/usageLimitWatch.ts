// Work that stopped on a Claude usage limit waits here and resumes by itself once the limit clears
// (docs/usage-limit-resume.md). Tasks, Captains and the Coordinator report a limit failure with `stall`; at the reset
// time plus a small buffer the watch asks the usage endpoint (server/claudeUsage.ts, no model tokens) whether the limit
// is clear, resumes what stalled in the order it stalled, and otherwise looks again later. Each item may be resumed a
// few times a day at most, so a limit that never clears (or a probe that is wrong) can't loop.
import type { UsageLimitHit, UsageLimitKind } from "../shared/usageLimit.js"
import { usageLimitName } from "../shared/usageLimit.js"
import type { FullLimit, UsageReading } from "./claudeUsage.js"

export type StalledItem =
  | { type: "task"; id: string }
  /** A project's Captain (its project id). */
  | { type: "captain"; id: string }
  | { type: "coordinator"; id: "coordinator" }

interface Entry {
  item: StalledItem
  kind: UsageLimitKind
  /** Epoch ms, from the error text. */
  resetsAt: number | null
  /** When it stalled: the order it resumes in. */
  since: number
  /** Whether the usage endpoint speaks for its login (this computer's own Claude login). Others wait for the reset time. */
  local: boolean
}

interface State {
  entries: Entry[]
  /** Resume attempts per item key, newest last, kept for ATTEMPT_WINDOW_MS. */
  attempts: Record<string, number[]>
  /** When an item was last resumed as a trial (no reset time, no answer from the endpoint): trials are TRIAL_MS apart and don't count toward MAX_ATTEMPTS. */
  trials: Record<string, number>
}

export interface WatchDeps {
  kv: { get(key: string): string | null; set(key: string, value: string | null): void }
  /** Settings › Resume after usage limits. */
  enabled(): boolean
  probe(): Promise<UsageReading>
  /** Resume one item. False: it no longer needs it (retried by hand, deleted, …). */
  resume(item: StalledItem): boolean
  /** A line for the yard's updates: said once when work pauses and once when it resumes. */
  notice(text: string): void
  now?: () => number
  /** Tests: the wait after a reset time before asking (BUFFER_MS). */
  bufferMs?: number
}

export const KV_KEY = "usage_limit_pause"
/** After the reset time, before asking: the reset lands on the minute, the endpoint a little later. */
export const BUFFER_MS = 60_000
/** Looking again when the limit is still full and says no reset time (a monthly spend limit), or can't be asked. */
export const RECHECK_MS = 15 * 60_000
export const MONTHLY_RECHECK_MS = 30 * 60_000
/** Never sleep longer than this between looks, so a raised limit or a clock jump is noticed. */
export const MAX_STEP_MS = 60 * 60_000
/** With no reset time and no answer from the endpoint: one trial resume this often. */
export const TRIAL_MS = 60 * 60_000
export const MAX_ATTEMPTS = 3
export const ATTEMPT_WINDOW_MS = 24 * 3600_000
/** A limit failure this soon after a resume is the same stall again, not news. */
const RESTALL_QUIET_MS = 15 * 60_000

const key = (i: StalledItem) => `${i.type}:${i.id}`

/** "6:20 PM", or with the day when it isn't today. */
function when(ms: number, now: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`
}

export class UsageLimitWatch {
  private state: State = { entries: [], attempts: {}, trials: {} }
  private timer: NodeJS.Timeout | null = null
  private checking = false
  private stopped = false

  private readonly buffer: number

  constructor(private readonly d: WatchDeps) {
    this.buffer = d.bufferMs ?? BUFFER_MS
  }

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  /** Reload what was waiting when Box Yard last stopped, and carry on watching. */
  start() {
    try {
      const saved = JSON.parse(this.d.kv.get(KV_KEY) ?? "null") as State | null
      if (saved && Array.isArray(saved.entries)) this.state = { entries: saved.entries, attempts: saved.attempts ?? {}, trials: saved.trials ?? {} }
    } catch {}
    this.arm()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Whether `item` is waiting on a limit now. */
  has(item: StalledItem): boolean {
    return this.state.entries.some((e) => key(e.item) === key(item))
  }

  /**
   * Work stopped on a usage limit. True: it waits here and resumes by itself. False: the caller treats it as a plain
   * failure (the feature is off, or this item already used its resumes).
   */
  stall(item: StalledItem, hit: UsageLimitHit, local = true): boolean {
    if (this.stopped || !this.d.enabled()) return false
    const now = this.now()
    const recent = (this.state.attempts[key(item)] ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS)
    if (recent.length >= MAX_ATTEMPTS) return false
    const first = !this.state.entries.length
    const lastTry = Math.max(recent.at(-1) ?? 0, this.state.trials[key(item)] ?? 0)
    const again = lastTry > 0 && now - lastTry < RESTALL_QUIET_MS
    this.state.entries = this.state.entries.filter((e) => key(e.item) !== key(item))
    this.state.entries.push({ item, kind: hit.kind, resetsAt: hit.resetsAt, since: now, local })
    this.save()
    if (first && !again) {
      const until = hit.resetsAt ? ` It resets ${when(hit.resetsAt, now)}.` : " It has no reset time, so Box Yard checks now and then."
      this.d.notice(`⚠ **Usage limit** paused work: Claude's ${usageLimitName(hit.kind)} limit is used up.${until} Work that stopped on it resumes by itself once it clears.`)
    }
    this.arm()
    return true
  }

  /** When to look next: the soonest reset plus the buffer, else a recheck; never beyond MAX_STEP_MS. */
  private nextLook(now: number): number {
    let next = now + MAX_STEP_MS
    for (const e of this.state.entries) {
      const tried = this.state.trials[key(e.item)]
      next = Math.min(next, e.resetsAt !== null ? e.resetsAt + this.buffer : tried ? tried + TRIAL_MS : now + (e.kind === "monthly" ? MONTHLY_RECHECK_MS : RECHECK_MS))
    }
    return Math.max(next, now + 1000)
  }

  private arm(at?: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.stopped || !this.state.entries.length) return
    const now = this.now()
    const wait = Math.max(1000, (at ?? this.nextLook(now)) - now)
    this.timer = setTimeout(() => void this.check(), wait)
    this.timer.unref?.()
  }

  private save() {
    this.d.kv.set(KV_KEY, this.state.entries.length || Object.keys(this.state.attempts).length || Object.keys(this.state.trials).length ? JSON.stringify(this.state) : null)
  }

  /** One look: resume what is clear (in the order it stalled), schedule the next look for the rest. Public for tests. */
  async check(): Promise<void> {
    if (this.checking || this.stopped) return
    this.checking = true
    try {
      if (!this.d.enabled()) {
        // Turned off while waiting: nothing resumes by itself. The work stays as it stopped, for a manual retry.
        if (this.state.entries.length) this.d.notice("⚠ **Usage limit** auto-resume is off: work that stopped on the limit stays stopped until you retry it.")
        this.state.entries = []
        this.save()
        return
      }
      // Asked only once something is due: a reset time not yet reached needs no look.
      const due = (e: Entry) => e.resetsAt === null || e.resetsAt + this.buffer <= this.now()
      const reading: UsageReading | null = this.state.entries.some((e) => e.local && due(e)) ? await this.d.probe() : null
      const now = this.now()
      const blockers = reading?.ok ? reading.full : null
      const ready: Entry[] = []
      const waiting: Entry[] = []
      let next = now + MAX_STEP_MS
      for (const e of [...this.state.entries].sort((a, b) => a.since - b.since)) {
        let wait: number | null
        if (e.local && blockers) {
          const full: FullLimit[] = e.kind === "monthly" ? blockers : blockers.filter((b) => b.kind !== "monthly")
          if (!full.length) wait = null
          else {
            const resets = full.map((b) => b.resetsAt).filter((t): t is number => t !== null && t + this.buffer > now)
            wait = resets.length === full.length ? Math.max(...resets) + this.buffer : now + (e.kind === "monthly" ? MONTHLY_RECHECK_MS : RECHECK_MS)
          }
        } else if (e.resetsAt !== null) wait = e.resetsAt + this.buffer > now ? e.resetsAt + this.buffer : null
        else {
          const tried = this.state.trials[key(e.item)]
          wait = tried && tried + TRIAL_MS > now ? tried + TRIAL_MS : null
        }
        if (wait === null) ready.push(e)
        else {
          waiting.push(e)
          next = Math.min(next, wait)
        }
      }
      this.state.entries = waiting
      const resumed: Entry[] = []
      let verified = false
      for (const e of ready) {
        const trial = e.resetsAt === null && !blockers
        if (trial) this.state.trials[key(e.item)] = now
        else {
          const list = (this.state.attempts[key(e.item)] ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS)
          list.push(now)
          this.state.attempts[key(e.item)] = list
        }
        let ok = false
        try {
          ok = this.d.resume(e.item)
        } catch (err) {
          console.warn(`[box-yard] couldn't resume ${key(e.item)} after a usage limit: ${(err as Error).message}`)
        }
        if (ok) {
          resumed.push(e)
          // A trial isn't news until it sticks.
          if (!trial) verified = true
        }
      }
      for (const [k, v] of Object.entries(this.state.attempts)) {
        const fresh = v.filter((t) => now - t < ATTEMPT_WINDOW_MS)
        if (fresh.length) this.state.attempts[k] = fresh
        else delete this.state.attempts[k]
      }
      for (const [k, t] of Object.entries(this.state.trials)) if (now - t > ATTEMPT_WINDOW_MS) delete this.state.trials[k]
      this.save()
      if (resumed.length && verified) this.d.notice(`▶ **Usage limit** cleared: ${describe(resumed)}${waiting.length ? ` resumed; ${waiting.length} more still waiting.` : " resumed."}`)
      this.arm(waiting.length ? next : undefined)
    } finally {
      this.checking = false
    }
  }
}

/** "2 tasks and the Coordinator". */
function describe(entries: Entry[]): string {
  const tasks = entries.filter((e) => e.item.type === "task").length
  const captains = entries.filter((e) => e.item.type === "captain").length
  const parts = [
    tasks ? `${tasks} task${tasks === 1 ? "" : "s"}` : "",
    captains ? `${captains} Captain${captains === 1 ? "" : "s"}` : "",
    entries.some((e) => e.item.type === "coordinator") ? "the Coordinator" : "",
  ].filter(Boolean)
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "work")
}
