// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { Modal } from "../web/src/components/Modal.js"
import { resetDrafts, setDraftText } from "../web/src/lib/composerDraft.js"
import { buildHarnessTargets, buildRunTargets } from "../shared/runTargets.js"
import { BUILTIN_MODELS } from "../shared/models.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TARGETS = buildRunTargets({
  problems: { local: null, box: null, docker: null, gpu: null },
  machines: [], localLabel: null,
  identityProblem: (runner) => runner === "docker" ? "This project disallows Docker" : null,
  gpu: { default: "runpod", problems: { runpod: null, vast: null, daytona: null }, types: { runpod: ["A40"], vast: ["RTX 4090"], daytona: ["H100"] } },
})
const HARNESSES = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
const SETTINGS = { agentModel: "sonnet", agentEffort: "medium", agentCodexModel: "gpt-6.1-terra", agentCodexEffort: "ultra", agentCursorModel: "auto" }
let host: HTMLElement, root: Root, client: QueryClient
const onSubmit = vi.fn(), outerClose = vi.fn()
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const input = () => document.querySelector("textarea")!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const row = (token: string) => document.querySelector<HTMLButtonElement>(`[role="option"][data-token="${token}"]`)!
const choices = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => el.dataset.token!)
const back = () => document.querySelector<HTMLElement>('button[data-dismiss="back"]')!
const title = () => document.querySelector('[data-testid="run-target-menu-title"]')!.textContent
async function tap(el: HTMLElement) {
  await act(async () => el.click())
  await settle()
}
function key(key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
  act(() => void document.activeElement!.dispatchEvent(event))
  return event
}
async function open(kind: "runsOn" | "agent") {
  await tap(document.querySelector<HTMLElement>(`[data-testid="pick-${kind}"]`)!)
}
function mount(enclosed = false) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const panel = createRef<HTMLElement>()
  const composer = createElement("section", { ref: panel }, createElement(Composer, {
    onSubmit, panelRef: panel, placeholder: "Ask", runTargets: true, draftKey: "coordinator",
  }))
  act(() => root.render(createElement(QueryClientProvider, { client }, enclosed
    ? createElement(Modal, { title: "Outer dialog", onClose: outerClose, children: composer }) : composer)))
}

beforeEach(() => {
  resetDrafts()
  onSubmit.mockReset()
  outerClose.mockReset()
  vi.stubGlobal("fetch", (url: string) => {
    const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } }))
    if (url.startsWith("/api/run-targets")) return json(TARGETS)
    if (url.startsWith("/api/harness-targets")) return json(HARNESSES)
    if (url === "/api/agent-settings") return json({ settings: SETTINGS, sources: {}, defaults: {} })
    if (url === "/api/models") return json({ models: BUILTIN_MODELS, source: "builtin" })
    if (url === "/api/cursor/models") return json({ models: [{ id: "auto", label: "Auto" }, { id: "gpt-6.1-sol-high", label: "GPT 6.1 Sol High" }], source: "cli" })
    return json([])
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); client?.clear(); await frame() })
  host.remove()
  vi.unstubAllGlobals()
})

describe("Composer button picker panels", () => {
  it("drills into box sizes, uses Back and Esc one level at a time, and colours and sends the chosen token", async () => {
    setDraftText("coordinator", "Build the feature")
    mount()
    await settle()
    await open("runsOn")
    expect(dialog()?.getAttribute("aria-modal")).toBe("true")
    expect(document.activeElement).toBe(row("local"))
    expect(input().getAttribute("aria-expanded")).toBe("false")
    await tap(row("box"))
    expect(choices()).toEqual(["box", "box:small", "box:medium", "box:large"])
    expect(row("box").textContent).toContain("Default size")
    expect(document.activeElement).toBe(row("box"))
    expect(document.querySelector('[data-dismiss="close"]')).toBeNull()
    await tap(back())
    expect(choices()).toContain("local")
    await tap(row("box"))
    key("Escape")
    expect(choices()).toContain("local")
    expect(dialog()).not.toBeNull()
    await tap(row("box"))
    await tap(row("box:medium"))
    expect(dialog()).toBeNull()
    expect(input().value).toBe("Build the feature @box:medium ")
    expect(document.querySelector('[data-tag="runsOn"]')?.textContent).toBe("@box:medium")
    expect(document.activeElement).toBe(input())
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("Build the feature @box:medium", [], { runsOn: expect.objectContaining({ value: "box:medium", token: "box:medium" }) })
  })

  it.each(["daytona", "gpu:runpod", "gpu:vast"])("offers the shared %s provider choices with the default first", async (provider) => {
    mount()
    await settle()
    await open("runsOn")
    await tap(row(provider))
    expect(choices()[0]).toBe(provider)
    expect(back()).not.toBeNull()
    const child = TARGETS.find((t) => t.under === provider)!
    expect(child).toBeDefined()
    await tap(row(child.token))
    expect(dialog()).toBeNull()
    expect(input().value).toBe(`@${child.token} `)
    key("Enter")
    expect(onSubmit.mock.calls[0]![2].runsOn.value).toBe(child.value)
  })

  it.each([
    ["claude", "sonnet[1m]", "high"],
    ["codex", "gpt-6.1-sol", "xhigh"],
  ])("drills from %s to a model to effort, then replaces the full existing pick on reopening", async (harness, model, effort) => {
    mount()
    await settle()
    await open("agent")
    await tap(row(harness!))
    expect(choices()[0]).toBe(harness)
    expect(row(harness!).textContent).toContain("Settings default")
    expect(row(harness!).textContent).toContain(harness === "claude" ? "sonnet · Medium effort" : "gpt-6.1-terra · Ultra effort")
    expect(title()).toMatch(/Harness/)
    await tap(row(`${harness}:${model}`))
    expect(title()).toMatch(/Harness/)
    expect(choices()[0]).toBe(`${harness}:${model}`)
    expect(row(`${harness}:${model}`).textContent).toContain("Default effort")
    key("Escape")
    expect(title()).toMatch(/Harness/)
    expect(choices()[0]).toBe(harness)
    await tap(row(`${harness}:${model}`))
    await tap(row(`${harness}:${model}:${effort}`))
    expect(input().value).toBe(`!${harness}:${model}:${effort} `)
    expect(document.querySelector('[data-tag="agent"]')?.textContent).toBe(`!${harness}:${model}:${effort}`)
    await open("agent")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    await tap(row("cursor"))
    await tap(row("cursor:gpt-6.1-sol-high"))
    expect(dialog()).toBeNull()
    expect(input().value).toBe("!cursor:gpt-6.1-sol-high ")
    key("Enter")
    expect(onSubmit.mock.calls[0]![2].agent).toMatchObject({ value: "cursor", model: "gpt-6.1-sol-high" })
  })

  it("can finish on the Settings default, a model's default effort, or a model with no effort level", async () => {
    mount()
    await settle()
    await open("agent")
    await tap(row("codex"))
    await tap(row("codex"))
    expect(input().value).toBe("!codex ")
    await open("agent")
    await tap(row("codex"))
    await tap(row("codex:gpt-6.1-sol"))
    await tap(row("codex:gpt-6.1-sol"))
    expect(input().value).toBe("!codex:gpt-6.1-sol ")
    await open("agent")
    await tap(row("claude"))
    expect(choices().slice(1, 3)).toEqual(["claude:claude-fable-5-2", "claude:claude-opus-5-5"])
    expect(choices()).toContain("claude:claude-fable-5-1")
    await tap(row("claude:claude-opus-4-5"))
    expect(dialog()).toBeNull()
    expect(input().value).toBe("!claude:claude-opus-4-5 ")
  })

  it("uses arrows, Home, End, Enter and Space; Tab stays inside and disabled locations are skipped", async () => {
    mount()
    await settle()
    await open("runsOn")
    expect(row("docker").disabled).toBe(true)
    key("ArrowDown")
    expect(document.activeElement).toBe(row("box"))
    key("ArrowDown")
    expect(document.activeElement?.getAttribute("data-token")).not.toBe("docker")
    key("End")
    expect(document.activeElement).toBe(row(choices().at(-1)!))
    key("Home")
    expect(document.activeElement).toBe(row("local"))
    key("ArrowUp")
    expect(document.activeElement).toBe(row(choices().at(-1)!))
    key("Home")
    // The active option is the last Tab stop (the others use roving tabindex).
    expect(key("Tab").defaultPrevented).toBe(true)
    expect(document.activeElement?.getAttribute("data-dismiss")).toBe("close")
    key("Tab", true)
    expect(document.activeElement).toBe(row("local"))
    key("ArrowDown")
    key("Enter")
    expect(choices()[0]).toBe("box")
    key("ArrowDown")
    key(" ")
    expect(input().value).toBe("@box:small ")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("type-to-filter in the sheet narrows options; Esc clears the filter before backing out", async () => {
    mount()
    await settle()
    await open("agent")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    key("c")
    key("u")
    key("r")
    expect(title()).toMatch(/cur/)
    expect(choices()).toEqual(["cursor"])
    expect(document.activeElement).toBe(row("cursor"))
    key("Escape")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    expect(dialog()).not.toBeNull()
    key("c")
    key("u")
    key("r")
    key("Enter")
    expect(choices()[0]).toBe("cursor")
    expect(input().value).toBe("!cursor:")
    // Nested filter: type deep after drilling into Cursor.
    key("d")
    key("e")
    key("e")
    key("p")
    // No DeepSeek in the stub catalog — filter shows no matches, Esc clears it.
    expect(choices()).toEqual([])
    key("Escape")
    // Filter cleared; still drilled into Cursor's models.
    expect(choices()).toEqual(["cursor", "cursor:auto", "cursor:gpt-6.1-sol-high"])
    expect(input().value).toBe("!cursor:")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("Esc unwinds effort, model and picker before an enclosing dialog; focus returns to the opening button", async () => {
    mount(true)
    await settle()
    const button = document.querySelector<HTMLElement>('[data-testid="pick-agent"]')!
    act(() => button.focus())
    await tap(button)
    await tap(row("codex"))
    await tap(row("codex:gpt-6.1-sol"))
    key("Escape")
    expect(title()).toMatch(/Harness/)
    expect(choices()[0]).toBe("codex")
    key("Escape")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    key("Escape")
    expect(document.querySelector('[data-testid="run-target-menu"]')).toBeNull()
    expect(outerClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
    key("Escape")
    expect(outerClose).toHaveBeenCalledOnce()
  })

  it("opens the same panels from the folded More lines", async () => {
    mount()
    await settle()
    await tap(document.querySelector<HTMLElement>('[data-testid="composer-more"]')!)
    await tap(document.querySelector<HTMLElement>('[data-testid="more-pick-agent"]')!)
    expect(document.querySelector('[data-testid="composer-more-menu"]')).toBeNull()
    expect(dialog()).not.toBeNull()
    await tap(row("cursor"))
    await tap(row("cursor:auto"))
    expect(input().value).toBe("!cursor:auto ")
  })
})
