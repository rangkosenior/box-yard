// @vitest-environment happy-dom
// A failed task's banner (components/TaskFailure.tsx): plain words, the next step as a button (Retry, the Settings page
// that fixes it), the raw error under Details, and nothing at all for a task that didn't fail.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskFailure } from "../web/src/components/TaskFailure.js"
import { keys } from "../web/src/lib/queries.js"
import type { Identity } from "../shared/identities.js"
import type { Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AUTH = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login'
const SSH = "Couldn't start the agent: can't reach gpu-tower over SSH: connect to host 192.168.1.40 port 22: Connection timed out"

const task = (over: Partial<Task> = {}) =>
  ({
    id: "task_failed0001",
    projectId: "prj_demo01",
    title: "Upgrade the payments SDK",
    prompt: "",
    status: "failed",
    error: AUTH,
    agentCli: "claude",
    boxId: null,
    previews: [],
    question: null,
    summary: null,
    waitReason: null,
    waitFor: [],
    turnCount: 1,
    pendingCount: 0,
    prUrl: null,
    prState: null,
    outcome: null,
    mergeRequest: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as unknown as Task

let root: Root
let host: HTMLElement
let qc: QueryClient
const posts: string[] = []

beforeEach(() => {
  history.replaceState(null, "", "/")
  posts.length = 0
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(url)
    if (url.endsWith("/retry")) return new Response(JSON.stringify(task({ status: "queued", error: null })), { status: 200 })
    return new Promise(() => {})
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (t: Task, identityId = "idn_default") => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(TaskFailure, { task: t, project: { identityId } }))))
const $ = (id: string) => host.querySelector<HTMLElement>(`[data-testid=${id}]`)
const click = (el: HTMLElement | null) => act(() => void el!.dispatchEvent(new MouseEvent("click", { bubbles: true })))

describe("TaskFailure", () => {
  it("shows nothing for a task that didn't fail, or failed without an error", () => {
    render(task({ status: "idle" }))
    expect(host.innerHTML).toBe("")
    render(task({ error: null }))
    expect(host.innerHTML).toBe("")
  })

  it("says what went wrong in plain words, with the fix leading", () => {
    render(task())
    expect($("failure-title")!.textContent).toBe("Claude didn't accept its login")
    expect($("failure-detail")!.textContent).toContain("Sign in again or paste a new key, then retry.")
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent!.trim())
    expect(buttons).toEqual(["Claude login", "Retry", "Continue with…", "Details"])
    // The raw error isn't in the way until asked for.
    expect($("failure-raw")).toBeNull()
  })

  it("tells a task Box Yard holds for a usage limit that it resumes by itself", () => {
    const resets = Date.now() + 3 * 3600_000
    render(task({ error: `You've hit your 5-hour limit|${Math.floor(resets / 1000)}`, limitWait: { kind: "five_hour", resetsAt: resets } }))
    expect($("failure-title")!.textContent).toBe("Waiting for Claude's usage limit to reset")
    expect($("failure-detail")!.textContent).toContain("Box Yard resumes this by itself once the limit clears")
    expect($("failure-retry")!.textContent).toContain("Retry now")
    // Without Box Yard holding it (the setting is off), the banner is the plain failure.
    render(task({ error: `You've hit your 5-hour limit|${Math.floor(resets / 1000)}` }))
    expect($("failure-title")!.textContent).toBe("Claude's usage limit is used up")
  })

  it("opens the Settings page that fixes it", () => {
    render(task())
    click($("failure-settings"))
    expect(new URLSearchParams(location.search).get("settings")).toBe("credentials")
  })

  it("sends a project with its own Claude login to Identities", () => {
    qc.setQueryData<Partial<Identity>[]>(keys.identities, [{ id: "idn_work", claude: { kind: "oauth_token", fingerprint: "ab12", readable: true } } as Partial<Identity>])
    render(task(), "idn_work")
    click($("failure-settings"))
    expect(new URLSearchParams(location.search).get("settings")).toBe("identities")
  })

  it("retries the task, and Retry leads when nothing needs fixing first", async () => {
    render(task({ error: SSH }))
    expect($("failure-title")!.textContent).toBe("Couldn't reach gpu-tower")
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent!.trim())
    expect(buttons).toEqual(["Retry", "Continue with…", "SSH machines", "Details"])
    await act(async () => {
      $("failure-retry")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(posts).toEqual(["/api/tasks/task_failed0001/retry"])
  })

  it("keeps the raw error under Details, with a copy button", () => {
    render(task())
    const toggle = $("failure-details")!
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect($("failure-raw")!.textContent).toBe(AUTH)
    expect(host.querySelector(`#${toggle.getAttribute("aria-controls")}`)).not.toBeNull()
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Copy error")).toBe(true)
    click(toggle)
    expect($("failure-raw")).toBeNull()
  })

  it("offers no Details when the banner already shows the whole error", () => {
    render(task({ error: "claude exited with code 1" }))
    expect($("failure-title")!.textContent).toBe("The last turn failed")
    expect($("failure-detail")!.textContent).toBe("claude exited with code 1")
    expect($("failure-details")).toBeNull()
  })

  it("says Retry now while a usage limit hasn't reset yet", () => {
    render(task({ error: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}` }))
    expect($("failure-retry")!.textContent!.trim()).toBe("Retry now")
  })
})
