// A Claude usage-limit failure, read from its error text (docs/usage-limit-resume.md): which limit it was and when it
// resets, so Box Yard can show the work as waiting for the reset and resume it by itself. Pure: no I/O, easy to test.
// The reset time comes in the words Claude Code prints ("your 5-hour limit resets 6:20pm (America/Chicago)",
// "resets Nov 15, 5pm (America/Chicago)", "resets in 2 hours") or as the `|<unix seconds>` stamp some errors end with.

export type UsageLimitKind = "five_hour" | "weekly" | "monthly" | "unknown"

export interface UsageLimitHit {
  kind: UsageLimitKind
  /** Epoch ms when the limit resets, when the text says (a monthly spend limit often doesn't). */
  resetsAt: number | null
}

/** Claude Code's usage-limit wording; the same patterns the web app's failure banner uses (web/src/lib/failure.ts). */
const LIMIT_TEXT = /usage limit|hit your (usage |monthly |weekly |spend )?(spend )?limit|(5-hour|weekly|session|daily|opus|sonnet|monthly) (spend )?limit|limit will reset|out of extra usage/i

/** What kind of limit an error is about, or null when it isn't a usage limit. A rate-limit error (a burst, not a quota) isn't one. */
export function parseUsageLimit(text: string, now = Date.now()): UsageLimitHit | null {
  if (!text || !LIMIT_TEXT.test(text) || /rate_limit_error/i.test(text)) return null
  // A spend limit leads: its message also names the 5-hour window it was reached in, and that reset doesn't lift it.
  const kind: UsageLimitKind = /monthly|spend limit|out of extra usage/i.test(text)
    ? "monthly"
    : /5-hour|five.hour|session/i.test(text)
      ? "five_hour"
      : /weekly|7-day|opus|sonnet/i.test(text)
        ? "weekly"
        : "unknown"
  return { kind, resetsAt: resetTime(text, now) }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }

function resetTime(text: string, now: number): number | null {
  const stamp = /\|(\d{10,13})\b/.exec(text)?.[1]
  if (stamp) return stamp.length === 10 ? Number(stamp) * 1000 : Number(stamp)
  const rel = /\b(?:resets?|try again)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(text)?.[1]
  if (rel) {
    let ms = 0
    for (const m of rel.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) ms += Number(m[1]) * UNIT_MS[m[2]![0]!.toLowerCase()]!
    return ms > 0 ? now + ms : null
  }
  const at = /\bresets?\s+(?:at\s+|on\s+)?(.+?)(?:\s*\(([^)]+)\))?\s*(?:[.·∙•|\n]|$)/im.exec(text)
  const words = at?.[1]?.trim()
  if (!words) return null
  const zone = at?.[2] && validZone(at[2].trim()) ? at[2].trim() : undefined
  const time = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(words)
  const day = /(?:^|\b)([a-z]{3})[a-z]*\.?\s+(\d{1,2})\b/i.exec(words.replace(time?.[0] ?? "", ""))
  let hour: number
  let minute = 0
  if (time) {
    hour = Number(time[1]) % 12 + (time[3]!.toLowerCase() === "p" ? 12 : 0)
    minute = Number(time[2] ?? 0)
  } else {
    const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(words)
    if (!h24) return null
    hour = Number(h24[1])
    minute = Number(h24[2])
  }
  const month = day ? MONTHS.indexOf(day[1]!.toLowerCase()) : -1
  const today = civil(now, zone)
  const base = month >= 0 ? { y: today.y, m: month + 1, d: Number(day![2]) } : today
  let when = zonedEpoch(base.y, base.m, base.d, hour, minute, zone)
  if (month >= 0) {
    // "Jan 3" read in December is next year's.
    if (when < now - 30 * 86_400_000) when = zonedEpoch(base.y + 1, base.m, base.d, hour, minute, zone)
  } else if (when <= now) {
    // A bare time of day is the next one ("6:20pm" said at 7pm is tomorrow's).
    const next = civil(when + 26 * 3_600_000, zone)
    when = zonedEpoch(next.y, next.m, next.d, hour, minute, zone)
  }
  return Number.isFinite(when) ? when : null
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The calendar date at `ms` in `zone` (the computer's own zone when none). */
function civil(ms: number, zone?: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(ms))
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return { y: n("year"), m: n("month"), d: n("day") }
}

/** Epoch ms of a wall-clock time in `zone` (the computer's own zone when none), through the zone's offset at that moment. */
function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, zone?: string): number {
  if (!zone) return new Date(y, mo - 1, d, h, mi).getTime()
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  let guess = wall
  // The offset depends on the instant (daylight saving), so settle it in two passes.
  for (let i = 0; i < 2; i++) guess = wall - zoneOffset(guess, zone)
  return guess
}

/** `zone`'s offset from UTC at `ms`, in ms. */
function zoneOffset(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms))
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ms / 1000) * 1000
}

/** "5-hour", "weekly" or "monthly spend", for a notice's wording. */
export const usageLimitName = (kind: UsageLimitKind): string => ({ five_hour: "5-hour", weekly: "weekly", monthly: "monthly spend", unknown: "usage" })[kind]
