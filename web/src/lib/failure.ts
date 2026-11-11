// A failed task's error (Task.error) in plain words: what happened, what to do about it, and the Settings page that
// fixes it. The raw text stays the source of truth; the task banner shows it under Details. Pure, so it is unit tested.
import { isOutOfSpace } from "../../../shared/disk"
import type { AgentCli } from "../../../shared/agentCli"
import type { SettingsSection } from "./settingsNav"

export type FailureKind =
  | "usage_limit"
  | "rate_limited"
  | "out_of_credit"
  | "agent_auth"
  | "github_auth"
  | "unreachable"
  | "disk"
  | "memory"
  | "api_down"
  | "start_timeout"
  | "interrupted"
  | "not_started"
  | "start_failed"
  | "unknown"

export interface Failure {
  kind: FailureKind
  /** One plain line: what went wrong. */
  title: string
  /** What to do about it, in a sentence or two. */
  detail: string
  /** The Settings page that fixes it, and its button's label. */
  settings?: { section: SettingsSection; label: string }
  /** Retry won't help until that's fixed, so the Settings button leads. */
  fixFirst?: boolean
  /** Retry won't help until a reset time (a usage limit that hasn't reset yet), so nothing leads. */
  waitFirst?: boolean
  /** A usage limit: when it resets (ms since epoch), when the error gives a timestamp. */
  resetsAt?: number
  /** A usage limit: when it resets as the error words it ("3pm (America/New_York)", "in 2 days 4 hours"). */
  resetsText?: string
}

export interface FailureContext {
  agentCli?: AgentCli | null
  /** The project's identity has a Claude login of its own (Settings › Identities), not Settings › Credentials' one. */
  ownClaudeLogin?: boolean
  now?: number
  /** The server holds the task for the limit and resumes it by itself (Task.limitWait). */
  resumesItself?: boolean
}

const API_ERROR = /\bAPI Error:\s*(\d{3})/i

/** What a failed task's error means. Never throws; anything it doesn't recognise is "unknown", with its first line. */
export function explainFailure(error: string, ctx: FailureContext = {}): Failure {
  const text = error.trim()
  // A toast doesn't know the task's agent: Codex's errors point at OpenAI, Cursor's at cursor-agent.
  const cli = ctx.agentCli ?? (/\bopencode\b/i.test(text) ? "opencode" : /\bcodex\b|openai|chatgpt/i.test(text) ? "codex" : /cursor-agent|\bcursor\b/i.test(text) ? "cursor" : "claude")
  const agent = cli === "codex" ? "Codex" : cli === "cursor" ? "Cursor" : cli === "opencode" ? "OpenCode" : "Claude"
  const now = ctx.now ?? Date.now()
  const status = Number(API_ERROR.exec(text)?.[1] ?? 0)

  if (/^Stopped before it started\.?$/i.test(text))
    return { kind: "not_started", title: "Stopped before it started", detail: "It never ran. Retry to start it." }

  if (/Starting the agent timed out/i.test(text))
    return { kind: "start_timeout", title: "The agent took too long to start", detail: "Where it runs may have been slow or busy. Retry to start it again." }

  if (/usage limit|hit your (usage )?limit|(5-hour|weekly|session|daily|opus|sonnet) limit|limit will reset|out of extra usage/i.test(text) && !/rate_limit_error/i.test(text)) {
    const reset = resetOf(text)
    const passed = reset.resetsAt !== undefined && reset.resetsAt <= now
    const when = passed
      ? "It has reset since, so a retry should go through."
      : reset.resetsAt !== undefined
        ? `It resets ${atTime(reset.resetsAt, now)} (in ${untilLabel(reset.resetsAt - now)}).`
        : reset.resetsText
          ? `It resets ${reset.resetsText}.`
          : "It resets on its own after a while."
    if (ctx.resumesItself)
      return {
        kind: "usage_limit",
        title: `Waiting for ${agent}'s usage limit to reset`,
        detail: `${passed ? "It has reset since." : when} Box Yard resumes this by itself once the limit clears. Retry now to try sooner.`,
        waitFirst: true,
        ...reset,
      }
    return {
      kind: "usage_limit",
      title: `${agent}'s usage limit is used up`,
      detail: passed ? when : `${when} Retry then, or give this project another ${agent} login.`,
      settings: loginSettings(agent, ctx, `${agent} logins`),
      waitFirst: !passed,
      ...reset,
    }
  }

  if (/credit balance is too low|insufficient[_ ]quota|exceeded your current quota/i.test(text))
    return {
      kind: "out_of_credit",
      title: `The ${agent} API key is out of credit`,
      detail: `Add credit to the account, or switch to another ${agent} login, then retry.`,
      settings: loginSettings(agent, ctx, `${agent} login`),
      fixFirst: true,
    }

  const github = githubAuth(text)
  if (github) return github

  if (status === 401 || status === 403 || /OpenCode.*authentication required|authentication_error|permission_error|invalid (x-)?api[ -]?key|please run \/login|not logged in|oauth token (has )?(expired|been revoked)|invalid bearer token|\bunauthori[sz]ed\b|provided api key is invalid|authentication required\. please run '(cursor-)?agent login'/i.test(text))
    return {
      kind: "agent_auth",
      title: `${agent} didn't accept its login`,
      detail: `The ${agent} login or API key this task uses has expired or was revoked. Sign in again or paste a new key, then retry.`,
      settings: loginSettings(agent, ctx, `${agent} login`),
      fixFirst: true,
    }

  const machine = unreachable(text)
  if (machine) return machine

  if (/ran out of memory|out of memory|\bOOM\b|heap out of memory/i.test(text)) {
    const size = /on its (\w+) box/i.exec(text)?.[1]
    return {
      kind: "memory",
      title: size ? `Ran out of memory on its ${size} box` : "Ran out of memory",
      detail: "The work needed more memory than its box has. Give the project a bigger box size, then retry.",
      settings: { section: "limits", label: "Box sizes" },
    }
  }

  if (isOutOfSpace(text)) {
    const box = /\bbox (\S+) is out of disk space/i.exec(text)?.[1]
    const local = /this computer is out of disk space/i.test(text)
    const free = /out of disk space \(([^)]*\bfree of\b[^)]*)\)/i.exec(text)?.[1]
    return {
      kind: "disk",
      title: local ? "This computer is out of disk space" : box ? `${box} is out of disk space` : "Out of disk space",
      detail: local
        ? "Free some space on this computer, then retry."
        : box
          ? `${free ? `Only ${free}, even` : "Even"} after Box Yard cleaned it up and tried again. Free space on it or add a box, then retry.`
          : "Free some space where it runs, then retry.",
      settings: { section: "limits", label: "Disk settings" },
    }
  }

  if (status === 429 || /rate_limit_error|\b429\b|too many requests/i.test(text))
    return { kind: "rate_limited", title: `${agent} asked it to slow down`, detail: "Too many requests in a short time. Wait a minute, then retry." }

  if ((status >= 500 && status < 600) || /overloaded|internal server error|service unavailable|bad gateway|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|socket hang up|fetch failed|connection error|request timed out/i.test(text))
    return { kind: "api_down", title: `Couldn't get through to ${agent}`, detail: `${agent}'s servers were busy or the connection dropped. That usually passes in a few minutes: retry.` }

  const interrupted = /^Interrupted:\s*(.+)$/is.exec(text)
  if (interrupted)
    return { kind: "interrupted", title: "The turn kept getting cut off", detail: `${sentence(interrupted[1]!)} It was retried a few times before giving up. Retry once that's sorted.` }

  const start = /^Couldn't start the agent:\s*(.+)$/is.exec(text)
  if (start) return { kind: "start_failed", title: "The agent couldn't start", detail: firstLine(start[1]!) }

  return { kind: "unknown", title: "The last turn failed", detail: firstLine(text) || "The agent exited with an error." }
}

/** One line for a card or toast: "Claude's usage limit is used up · resets 3:17 PM", or the error's own first line. */
export function failureSummary(error: string, ctx: FailureContext = {}): string {
  const f = explainFailure(error, ctx)
  if (f.kind === "unknown") return f.detail
  const now = ctx.now ?? Date.now()
  if (f.resetsAt !== undefined && f.resetsAt > now) return `${f.title} · resets ${atTime(f.resetsAt, now)}`
  if (f.resetsText) return `${f.title} · resets ${f.resetsText}`
  return f.title
}

/** The raw error says more than the banner does, so the banner offers it under Details. */
export const failureHasMore = (error: string, f: Failure) => f.kind !== "unknown" || error.trim() !== f.detail

// ------------------------------------------------------------------ pieces

function loginSettings(agent: string, ctx: FailureContext, label: string): Failure["settings"] {
  return { section: agent === "Claude" && ctx.ownClaudeLogin ? "identities" : "credentials", label }
}

/**
 * When a usage limit resets: Claude's "usage limit reached|1730000000" (seconds), "resets 3pm (America/New_York)",
 * "will reset at 7pm", "resets Oct 9, 2pm", Codex's "try again in 2 days 4 hours". Worded to follow "resets".
 */
function resetOf(text: string): { resetsAt?: number; resetsText?: string } {
  const stamp = /\|(\d{10,13})\b/.exec(text)?.[1]
  if (stamp) return { resetsAt: stamp.length === 10 ? Number(stamp) * 1000 : Number(stamp) }
  const m = /\b(?:resets?|try again)\s+(at\s+|in\s+|on\s+)?([^·∙•|\n]+?)\s*(?:[.·∙•|](?:\s|$)|$)/im.exec(text)
  const words = m?.[2]!.trim().replace(/[.,;:]+$/, "")
  if (!words) return {}
  const prep = m![1]?.trim().toLowerCase()
  return { resetsText: prep === "in" || prep === "on" ? `${prep} ${words}` : /^\d/.test(words) ? `at ${words}` : words }
}

function githubAuth(text: string): Failure | null {
  const hit = /Authentication failed for '?https?:\/\/[^\s']*github|could not read (Username|Password) for '?https?:\/\/[^\s']*github|Repository not found|repository '[^']*' not found|GitHub[^\n]*\b(401|403)\b|GitHub[^\n]*(refused|doesn't accept) the token|Bad credentials|Permission to \S+ denied/i.test(text)
  if (!hit) return null
  const repo = /\b(?:clone|fetch|push) of ([\w.-]+\/[\w.-]+)/i.exec(text)?.[1] ?? /github\.com[/:]([\w.-]+\/[\w-]+(?:\.[\w-]+)*?)(?:\.git)?\/?(?=['"\s]|$)/i.exec(text)?.[1]
  return {
    kind: "github_auth",
    title: repo ? `GitHub wouldn't let it into ${repo}` : "GitHub refused access",
    detail: "Either the repo doesn't exist under that name, or this project's GitHub token can't see it (expired, revoked, or for another account). Check the token, then retry.",
    settings: { section: "identities", label: "GitHub tokens" },
    fixFirst: true,
  }
}

function unreachable(text: string): Failure | null {
  const name = /can't reach (.+?) over SSH/i.exec(text)?.[1] ?? /lost the SSH connection to (\S+?)\.?(?:\s|$)/i.exec(text)?.[1]
  const ssh = name !== undefined || /\bssh\b[^\n]*(refused|timed out|no route to host|could not resolve hostname|network is unreachable)/i.test(text)
  if (!ssh) return null
  const lost = /lost the SSH connection/i.test(text)
  if (/host key (changed|verification failed)|REMOTE HOST IDENTIFICATION/i.test(text))
    return {
      kind: "unreachable",
      title: name ? `${name}'s host key changed` : "The machine's host key changed",
      detail: "Box Yard won't connect, in case it isn't the same machine. If you reinstalled or replaced it, forget the old key in Settings, then retry.",
      settings: { section: "machines", label: "SSH machines" },
      fixFirst: true,
    }
  const why = /over SSH:\s*([^\n]+)/i.exec(text)?.[1]?.trim()
  return {
    kind: "unreachable",
    title: lost ? `Lost the connection to ${name ?? "the machine"}` : `Couldn't reach ${name ?? "the machine"}`,
    detail: `${why ? `SSH said: ${period(why)} ` : ""}Check that it's on, awake and online, then retry. Settings can test the connection.`,
    settings: { section: "machines", label: "SSH machines" },
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
  return line.length > 180 ? `${line.slice(0, 179).trimEnd()}…` : line
}

/** Ending in a full stop. */
const period = (text: string) => (/[.!?…)]$/.test(text) ? text : `${text}.`)

/** Box Yard's own lower-case reason as a sentence: capitalised, ending in a full stop. */
const sentence = (text: string) => period(text.trim().replace(/^./, (c) => c.toUpperCase()))

/** "at 3:17 PM", "on Tue at 3:17 PM" later this week, "on Nov 12 at 3:17 PM" further out. */
function atTime(at: number, now: number): string {
  const d = new Date(at)
  const time = `at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
  if (d.toDateString() === new Date(now).toDateString()) return time
  const day = d.toLocaleDateString(undefined, at - now < 6 * 86_400_000 ? { weekday: "short" } : { month: "short", day: "numeric" })
  return `on ${day} ${time}`
}

/** "2h 17m", "45m", "under a minute". */
function untilLabel(ms: number): string {
  const m = Math.ceil(ms / 60_000)
  if (m <= 1) return "under a minute"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}
