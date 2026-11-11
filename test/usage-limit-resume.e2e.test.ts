import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import type { CaptainMessage, ChatMessage, Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Work a Claude usage limit stops waits for the limit to clear and resumes by itself (docs/usage-limit-resume.md): a
// task shows as waiting (still failed underneath), the Coordinator's and a Captain's turn are kept, and nothing runs
// until the limit is gone. The fake claude fails while FAKE_CLAUDE_LIMIT_FILE exists; deleting it clears the limit.

const running: { yard: BoxYard; server: Server }[] = []
let limitFile = ""
const saved = process.env.FAKE_CLAUDE_LIMIT_FILE

beforeEach(() => {
  limitFile = path.join(tmpDir("usage-limit-"), "limit.txt")
})
afterEach(async () => {
  if (saved === undefined) delete process.env.FAKE_CLAUDE_LIMIT_FILE
  else process.env.FAKE_CLAUDE_LIMIT_FILE = saved
  for (const r of running.splice(0)) {
    await waitFor(() => !r.yard.orchestrator.busy, "the Coordinator to finish").catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

/** Limited until `lift()`: its message says the limit resets in ~2 s (the watch waits 0 s after that, not a minute). */
function limit(secondsToReset = 2) {
  process.env.FAKE_CLAUDE_LIMIT_FILE = limitFile
  fs.writeFileSync(limitFile, `You hit your 5-hour limit|${Math.floor(Date.now() / 1000) + secondsToReset}`)
  return { lift: () => fs.rmSync(limitFile, { force: true }) }
}

async function start(overrides: Parameters<typeof testConfig>[0] = {}) {
  const dir = tmpDir("usage-limit-yard-")
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, ...overrides }), {
    webDir: "/nonexistent",
    provider: new LocalProvider(path.join(dir, "boxes"), FAKE_CLAUDE),
    usageLimitBufferMs: 0,
  })
  yard.captains.tuning.wakeDebounceMs = 100
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const base = `http://127.0.0.1:${port}`
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status}: ${text}`)
    return JSON.parse(text) as T
  }
  const notices = () => yard.store.listChat(200).filter((m) => m.role === "notice").map((m) => m.content)
  return { yard, call, notices }
}

describe("resuming after a usage limit", () => {
  it("shows a limited task as waiting, then runs it again by itself once the limit clears", async () => {
    const lim = limit(3)
    const r = await start()
    const project = await r.call<Project>("POST", "/api/projects", { name: "app" })
    const task = await r.call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Hello", prompt: "Say hi" })
    const waiting = await waitFor(() => {
      const t = r.yard.store.getTask(task.id)
      return t?.status === "failed" && !t.currentTurnId && t
    }, "the task to stop on the limit", 30_000)
    expect(waiting.limitWait).toMatchObject({ kind: "five_hour" })
    expect(waiting.limitWait!.resetsAt).toBeGreaterThan(Date.now())
    // Said once that work paused, and the task's failure wasn't announced.
    expect(r.notices().filter((n) => n.includes("Usage limit"))).toHaveLength(1)
    expect(r.notices().join("\n")).toMatch(/Usage limit\*\* paused work: Claude's 5-hour limit is used up/)
    expect(r.notices().join("\n")).not.toContain("failed:")

    lim.lift()
    await waitFor(() => r.yard.store.getTask(task.id)?.status === "idle", "the task to resume and finish", 30_000)
    expect(r.yard.store.getTask(task.id)!.limitWait).toBeNull()
    expect(r.notices().join("\n")).toMatch(/Usage limit\*\* cleared: 1 task resumed/)
  })

  it("keeps the Coordinator's turn and answers it after the limit clears", async () => {
    const lim = limit(3)
    const r = await start()
    await r.call("POST", "/api/chat", { content: "Hello there" })
    await waitFor(() => r.yard.store.listChat(50).some((m) => m.role === "error"), "the Coordinator's turn to fail", 30_000)
    await waitFor(() => !r.yard.orchestrator.busy, "the Coordinator to rest")
    // A message sent while it waits isn't wasted on a run that would fail the same way.
    await r.call("POST", "/api/chat", { content: "Still there?" })
    await new Promise((res) => setTimeout(res, 300))
    expect(r.yard.store.listChat(50).filter((m) => m.role === "error")).toHaveLength(1)

    lim.lift()
    const reply = await waitFor(() => r.yard.store.listChat(50).find((m: ChatMessage) => m.role === "assistant"), "the Coordinator's answer", 30_000)
    expect(reply.content).toBeTruthy()
    expect(r.notices().join("\n")).toMatch(/Usage limit\*\* cleared: the Coordinator resumed/)
  })

  it("keeps a Captain's turn and answers it after the limit clears", async () => {
    const lim = limit(3)
    const r = await start()
    const project = await r.call<Project>("POST", "/api/projects", { name: "demo" })
    await r.call<CaptainMessage>("POST", `/api/projects/${project.id}/captain/messages`, { id: "chat_limit0001", content: "What's queued here?" })
    await waitFor(() => r.yard.store.listCaptainMessages(project.id).some((m) => m.role === "error"), "the Captain's turn to fail", 30_000)

    lim.lift()
    const reply = await waitFor(() => r.yard.store.listCaptainMessages(project.id).find((m) => m.role === "assistant"), "the Captain's answer", 30_000)
    expect(reply.content).toBeTruthy()
  })

  it("fails as before when the setting is off", async () => {
    limit(3)
    const r = await start()
    r.yard.settings.update({ resumeAfterUsageLimit: false })
    const project = await r.call<Project>("POST", "/api/projects", { name: "app" })
    const task = await r.call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Hello", prompt: "Say hi" })
    const failed = await waitFor(() => {
      const t = r.yard.store.getTask(task.id)
      return t?.status === "failed" && !t.currentTurnId && t
    }, "the task to fail", 30_000)
    expect(failed.limitWait).toBeNull()
    expect(r.notices().join("\n")).toContain("failed:")
  })
})
