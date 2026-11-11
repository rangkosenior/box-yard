import { describe, expect, it } from "vitest"
import { badgeStatus, prLabel, prStateOf, prTooltip, type PrTask } from "../web/src/lib/prState.js"

const url = "https://github.com/acme/box-yard/pull/23"
const pr = (over: Partial<PrTask> = {}): PrTask => ({ prUrl: url, prState: "open", prMergedAt: null, prMergedBy: null, ...over })

describe("PR chip labels", () => {
  it("names each state like GitHub does", () => {
    expect(prLabel(pr())).toBe("PR #23")
    expect(prLabel(pr({ prState: "draft" }))).toBe("Draft #23")
    expect(prLabel(pr({ prState: "merged" }))).toBe("Merged #23")
    expect(prLabel(pr({ prState: "closed" }))).toBe("Closed #23")
    expect(prLabel(pr({ prUrl: null }))).toBeNull()
  })
  it("treats a PR the server hasn't checked yet as open", () => {
    expect(prStateOf({ prUrl: url, prState: null })).toBe("open")
    expect(prStateOf({ prUrl: null, prState: "merged" })).toBeNull()
  })
  it("says when and by whom a PR was merged", () => {
    const now = Date.parse("2026-10-22T13:00:00Z")
    expect(prTooltip(pr({ prState: "merged", prMergedAt: now - 12 * 60_000, prMergedBy: "cody" }), now)).toBe(`Merged 12m ago by cody\n${url}`)
    expect(prTooltip(pr({ prState: "merged" }), now)).toBe(`Merged\n${url}`)
    expect(prTooltip(pr({ prState: "closed" }), now)).toBe(`Closed without merging\n${url}`)
  })
})

describe("status pill", () => {
  it("shows Merged for a task that is done because its PR merged", () => {
    expect(badgeStatus({ status: "done", prUrl: url, prState: "merged" })).toBe("merged")
    expect(badgeStatus({ status: "done", prUrl: url, prState: "closed" })).toBe("done")
    expect(badgeStatus({ status: "done", prUrl: null, prState: null })).toBe("done")
    // Still working on a merged PR: the live status wins.
    expect(badgeStatus({ status: "working", prUrl: url, prState: "merged" })).toBe("working")
  })

  it("shows a task failed on a usage limit as waiting for it, not as failed", () => {
    const limitWait = { kind: "five_hour", resetsAt: 1_800_000_000_000 } as const
    expect(badgeStatus({ status: "failed", prUrl: null, prState: null, limitWait })).toBe("limit")
    expect(badgeStatus({ status: "failed", prUrl: null, prState: null, limitWait: null })).toBe("failed")
    // Once retried, it is no longer failed: the live status wins.
    expect(badgeStatus({ status: "queued", prUrl: null, prState: null, limitWait })).toBe("queued")
  })
})
