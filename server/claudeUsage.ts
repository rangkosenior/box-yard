// Is this computer's Claude login still at a usage limit? Asks Anthropic's OAuth usage endpoint, the same one Claude
// Code's /usage and the Omarchy usage panel read, with the access token Claude Code keeps in ~/.claude. It costs no model
// tokens. The token goes only into the request's Authorization header: it is never returned, logged or put in an error.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"

/** A window or spend cap that is full. `resetsAt` is epoch ms, null when the endpoint gives none. */
export interface FullLimit {
  kind: "five_hour" | "weekly" | "monthly"
  resetsAt: number | null
}

export type UsageReading =
  | { ok: true; full: FullLimit[] }
  /** The probe couldn't tell: `no_login` (no token), `expired` (the token lapsed; Claude Code renews it when it next runs), `refused`, `rate_limited`, `unreachable` or `bad_answer`. */
  | { ok: false; why: "no_login" | "expired" | "refused" | "rate_limited" | "unreachable" | "bad_answer" }

export interface UsageProbeOptions {
  /** Claude Code's config directory; CLAUDE_CONFIG_DIR, else ~/.claude. */
  claudeDir?: string
  fetchImpl?: typeof fetch
  now?: number
}

const WINDOW_KIND: Record<string, FullLimit["kind"]> = { session: "five_hour", five_hour: "five_hour", weekly_all: "weekly", weekly_scoped: "weekly", weekly: "weekly" }

const at = (v: unknown): number | null => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? ms : null
}

/** What the endpoint's answer says is full. Anything that isn't a number at 100 or more counts as not full. */
export function fullLimits(payload: unknown): FullLimit[] | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as Record<string, any>
  const full: FullLimit[] = []
  if (Array.isArray(p.limits)) {
    for (const l of p.limits) if (l && typeof l.percent === "number" && l.percent >= 100) full.push({ kind: WINDOW_KIND[String(l.kind)] ?? "weekly", resetsAt: at(l.resets_at) })
  } else {
    // An older answer without the `limits` list: the two plan windows.
    for (const [key, kind] of [["five_hour", "five_hour"], ["seven_day", "weekly"]] as const) {
      const w = p[key]
      if (w && typeof w.utilization === "number" && w.utilization >= 100) full.push({ kind, resetsAt: at(w.resets_at) })
    }
  }
  const extra = p.extra_usage
  const spend = p.spend
  if ((extra?.is_enabled === true && extra.spend_limit_reached === true) || (spend?.enabled === true && typeof spend.percent === "number" && spend.percent >= 100)) full.push({ kind: "monthly", resetsAt: null })
  return full
}

/** One look at the limits. Never throws, and never includes the token in what it returns. */
export async function readClaudeUsage(opts: UsageProbeOptions = {}): Promise<UsageReading> {
  const dir = opts.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  let token = ""
  let expiresAt = 0
  try {
    const login = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"))?.claudeAiOauth
    token = typeof login?.accessToken === "string" ? login.accessToken : ""
    expiresAt = typeof login?.expiresAt === "number" ? login.expiresAt : 0
  } catch {}
  if (!token) return { ok: false, why: "no_login" }
  if (expiresAt > 0 && expiresAt <= (opts.now ?? Date.now())) return { ok: false, why: "expired" }
  try {
    const res = await (opts.fetchImpl ?? fetch)(USAGE_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 401 || res.status === 403) return { ok: false, why: "refused" }
    if (res.status === 429) return { ok: false, why: "rate_limited" }
    if (!res.ok) return { ok: false, why: "bad_answer" }
    const full = fullLimits(await res.json())
    return full ? { ok: true, full } : { ok: false, why: "bad_answer" }
  } catch (err) {
    return { ok: false, why: (err as Error)?.name === "SyntaxError" ? "bad_answer" : "unreachable" }
  }
}
