// A failed task's raw error (Task.error) in plain words with its next step (web/src/lib/failure.ts). The strings are
// the ones the runner and server really write: Claude/Codex CLI results, git and ssh stderr, Box Yard's own wording.
import { describe, expect, it } from "vitest"
import { explainFailure, failureHasMore, failureSummary } from "../web/src/lib/failure.js"

const NOW = new Date(2026, 10, 4, 13, 0).getTime()
const at = (h: number, m = 0, day = 4) => new Date(2026, 10, day, h, m).getTime()
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

describe("explainFailure: usage limits", () => {
  it("reads Claude's reset timestamp and says when, and how long until", () => {
    const resets = at(15, 17)
    const f = explainFailure(`Claude AI usage limit reached|${resets / 1000}`, { now: NOW })
    expect(f.kind).toBe("usage_limit")
    expect(f.title).toBe("Claude's usage limit is used up")
    expect(f.resetsAt).toBe(resets)
    expect(f.detail).toBe(`It resets at ${time(resets)} (in 2h 17m). Retry then, or give this project another Claude login.`)
    expect(f.waitFirst).toBe(true)
    expect(f.settings).toEqual({ section: "credentials", label: "Claude logins" })
  })

  it("says Box Yard resumes it by itself when the server holds the task for the limit", () => {
    const resets = at(15, 17)
    const f = explainFailure(`You've hit your monthly spend limit · your 5-hour limit resets 3:17pm|${resets / 1000}`, { now: NOW, resumesItself: true })
    expect(f).toMatchObject({ kind: "usage_limit", title: "Waiting for Claude's usage limit to reset", waitFirst: true, resetsAt: resets })
    expect(f.detail).toBe(`It resets at ${time(resets)} (in 2h 17m). Box Yard resumes this by itself once the limit clears. Retry now to try sooner.`)
    expect(f.detail).not.toContain("login")
    // Once it has reset, the check is about to run.
    expect(explainFailure(`Claude AI usage limit reached|${at(12) / 1000}`, { now: NOW, resumesItself: true }).detail).toMatch(/^It has reset since\. Box Yard resumes this by itself/)
  })

  it("says a retry should go through once the reset time has passed", () => {
    const f = explainFailure(`Claude AI usage limit reached|${at(12) / 1000}`, { now: NOW })
    expect(f.detail).toBe("It has reset since, so a retry should go through.")
    expect(f.waitFirst).toBe(false)
  })

  it("names the day when the reset isn't today", () => {
    const f = explainFailure(`Claude AI usage limit reached|${at(9, 0, 6) / 1000}`, { now: NOW })
    const day = new Date(at(9, 0, 6)).toLocaleDateString(undefined, { weekday: "short" })
    expect(f.detail).toContain(`It resets on ${day} at ${time(at(9, 0, 6))} (in 1d 20h).`)
  })

  it.each([
    ["You've hit your limit · resets 3pm (America/New_York)", "at 3pm (America/New_York)"],
    ["5-hour limit reached ∙ resets 2pm", "at 2pm"],
    ["Claude usage limit reached. Your limit will reset at 7pm (America/Los_Angeles).", "at 7pm (America/Los_Angeles)"],
    ["Weekly limit reached ∙ resets Oct 9, 2pm", "Oct 9, 2pm"],
  ])("keeps the CLI's own reset wording: %s", (error, when) => {
    const f = explainFailure(error, { now: NOW })
    expect(f.kind).toBe("usage_limit")
    expect(f.resetsText).toBe(when)
    expect(f.detail).toBe(`It resets ${when}. Retry then, or give this project another Claude login.`)
  })

  it("speaks of Codex for a Codex task", () => {
    const f = explainFailure("You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 days 4 hours.", { agentCli: "codex", now: NOW })
    expect(f.title).toBe("Codex's usage limit is used up")
    expect(f.resetsText).toBe("in 2 days 4 hours")
    expect(f.settings).toEqual({ section: "credentials", label: "Codex logins" })
  })

  it("knows a Codex error without being told the agent", () => {
    expect(explainFailure("You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at 3:05 PM.").title).toBe("Codex's usage limit is used up")
  })

  it("sends a project with its own Claude login to Identities", () => {
    expect(explainFailure("Claude AI usage limit reached|1", { ownClaudeLogin: true }).settings?.section).toBe("identities")
  })

  it("says it resets on its own when the error doesn't say when", () => {
    expect(explainFailure("Claude usage limit reached.", { now: NOW }).detail).toBe("It resets on its own after a while. Retry then, or give this project another Claude login.")
  })
})

describe("explainFailure: logins and keys", () => {
  it("turns a Claude 401 into a login problem that Settings fixes first", () => {
    const f = explainFailure(
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."},"request_id":"req_011CUj7y"} · Please run /login',
    )
    expect(f).toMatchObject({ kind: "agent_auth", title: "Claude didn't accept its login", fixFirst: true, settings: { section: "credentials", label: "Claude login" } })
  })

  it.each(["Invalid API key · Please run /login", "Not logged in · Please run /login", "API Error: 403 permission_error"])("recognises %s", (error) => {
    expect(explainFailure(error).kind).toBe("agent_auth")
  })

  it("tells an empty API key account apart from a bad login", () => {
    expect(explainFailure("Credit balance is too low").kind).toBe("out_of_credit")
  })

  it("blames GitHub, not Claude, for a clone the token can't see, and names the repo", () => {
    const f = explainFailure(
      "Couldn't start the agent: git clone of acme/demo failed: remote: Repository not found.\nfatal: repository 'https://github.com/acme/demo.git/' not found\n",
    )
    expect(f).toMatchObject({ kind: "github_auth", title: "GitHub wouldn't let it into acme/demo", fixFirst: true, settings: { section: "identities", label: "GitHub tokens" } })
  })

  it("finds the repo in a git URL when there's no 'clone of'", () => {
    expect(explainFailure("fatal: Authentication failed for 'https://github.com/acme/web-app.git/'").title).toBe("GitHub wouldn't let it into acme/web-app")
  })
})

describe("explainFailure: where it runs", () => {
  it("names the SSH machine it couldn't reach and quotes ssh", () => {
    const f = explainFailure("Couldn't start the agent: can't reach gpu-tower over SSH: connect to host 192.168.1.40 port 22: Connection timed out")
    expect(f.kind).toBe("unreachable")
    expect(f.title).toBe("Couldn't reach gpu-tower")
    expect(f.detail).toBe("SSH said: connect to host 192.168.1.40 port 22: Connection timed out. Check that it's on, awake and online, then retry. Settings can test the connection.")
    expect(f.settings).toEqual({ section: "machines", label: "SSH machines" })
    expect(f.fixFirst).toBeUndefined()
  })

  it("says the connection was lost mid-turn", () => {
    expect(explainFailure("lost the SSH connection to old-laptop").title).toBe("Lost the connection to old-laptop")
  })

  it("asks to forget a changed host key before retrying", () => {
    const f = explainFailure("can't reach gpu-tower over SSH: its host key changed since Box Yard first connected (Forget host key in Settings › Machines if you expected that)")
    expect(f).toMatchObject({ title: "gpu-tower's host key changed", fixFirst: true })
  })

  it("names the full box and keeps the cleanup it already tried", () => {
    const f = explainFailure(
      "Couldn't start the agent: box box-7 is out of disk space (412 MB free of 20 GB), even after cleaning it up and retrying. Free space on it or add a box, then retry. tar: write error: No space left on device",
    )
    expect(f).toMatchObject({ kind: "disk", title: "box-7 is out of disk space", settings: { section: "limits" } })
    expect(f.detail).toBe("Only 412 MB free of 20 GB, even after Box Yard cleaned it up and tried again. Free space on it or add a box, then retry.")
  })

  it("says this computer when it's the local disk", () => {
    expect(explainFailure("Couldn't start the agent: this computer is out of disk space. Free some space on it, then retry. ENOSPC").title).toBe("This computer is out of disk space")
  })

  it("explains running out of memory with the box size", () => {
    const f = explainFailure("It ran out of memory on its medium box, and isn't retried on a bigger one: auto-resize is off. The agent exited with an error.")
    expect(f).toMatchObject({ kind: "memory", title: "Ran out of memory on its medium box", settings: { section: "limits", label: "Box sizes" } })
  })
})

describe("explainFailure: passing trouble and the rest", () => {
  it.each([
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "API Error: 500 Internal server error",
    "API Error: Connection error.",
    "Request timed out.",
  ])("calls %s a hiccup worth a retry", (error) => {
    const f = explainFailure(error)
    expect(f.kind).toBe("api_down")
    expect(f.settings).toBeUndefined()
  })

  it("doesn't take any limit for a usage limit", () => {
    expect(explainFailure("Error: max turns limit reached").kind).toBe("unknown")
  })

  it("tells a rate limit from a usage limit", () => {
    expect(explainFailure('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}').kind).toBe("rate_limited")
  })

  it("says why a turn kept getting interrupted", () => {
    const f = explainFailure("Interrupted: its Docker container stopped")
    expect(f.kind).toBe("interrupted")
    expect(f.detail).toBe("Its Docker container stopped. It was retried a few times before giving up. Retry once that's sorted.")
  })

  it("keeps the first line of a start failure it doesn't know", () => {
    expect(explainFailure("Couldn't start the agent: npm ci exited 1\nlots of npm output")).toMatchObject({ kind: "start_failed", title: "The agent couldn't start", detail: "npm ci exited 1" })
  })

  it.each([
    ["Starting the agent timed out.", "start_timeout"],
    ["Stopped before it started.", "not_started"],
  ])("knows Box Yard's own %s", (error, kind) => {
    expect(explainFailure(error).kind).toBe(kind)
  })

  it("falls back to the error's first line, shortened", () => {
    const f = explainFailure(`claude exited with code 1\n${"x".repeat(300)}`)
    expect(f).toMatchObject({ kind: "unknown", title: "The last turn failed", detail: "claude exited with code 1" })
    expect(explainFailure("y".repeat(400)).detail.length).toBeLessThanOrEqual(182)
  })
})

describe("failureSummary and failureHasMore", () => {
  it("is the title with the reset time for a card or toast", () => {
    expect(failureSummary(`Claude AI usage limit reached|${at(15, 17) / 1000}`, { now: NOW })).toBe(`Claude's usage limit is used up · resets at ${time(at(15, 17))}`)
    expect(failureSummary("You've hit your limit · resets 3pm (America/New_York)")).toBe("Claude's usage limit is used up · resets at 3pm (America/New_York)")
    expect(failureSummary("lost the SSH connection to old-laptop")).toBe("Lost the connection to old-laptop")
  })

  it("is the error's own first line when it isn't recognised", () => {
    expect(failureSummary("claude exited with code 1")).toBe("claude exited with code 1")
  })

  it("offers Details only when the raw error says more than the banner", () => {
    const one = "claude exited with code 1"
    expect(failureHasMore(one, explainFailure(one))).toBe(false)
    const two = `${one}\nstack trace`
    expect(failureHasMore(two, explainFailure(two))).toBe(true)
    const ssh = "lost the SSH connection to old-laptop"
    expect(failureHasMore(ssh, explainFailure(ssh))).toBe(true)
  })
})
