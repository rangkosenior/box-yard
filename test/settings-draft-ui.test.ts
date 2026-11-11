// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import { getVoiceSettings } from "../web/src/lib/speech.js"
import { VOICE_KEY } from "../web/src/lib/voice.js"
import { setTheme, THEME_KEY } from "../web/src/lib/theme"
import { draftChanges } from "../web/src/lib/settingsDraft.js"
import type { SettingsSection } from "../web/src/lib/settingsNav.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { TTS_DEFAULTS, type TtsInfo } from "../shared/tts.js"
import type { Settings, SettingsInfo } from "../shared/types"
import { CREDENTIAL_KEYS, type SetupStatus } from "../shared/setup"
import { DEFAULT_RUNPOD_SETTINGS } from "../shared/runpod"
import { DEFAULT_VAST_SETTINGS } from "../shared/vast"
import { DEFAULT_DAYTONA_SETTINGS, type DaytonaStatus } from "../shared/daytona"
import { DEFAULT_DOCKER_SETTINGS } from "../shared/docker"
import type { HookWithLastRun } from "../shared/hooks"

// Cody's rule for Settings: no control saves on change. Every control (radios, checkboxes, switches, browser-only
// voice choices) edits a draft; Save lights up while something differs and writes it all; Discard reverts.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})
const ttsInfo = (provider: TtsInfo["settings"]["provider"] = "browser"): TtsInfo => ({
  settings: { ...TTS_DEFAULTS, provider },
  sources: { provider: "ui", elevenlabs: "default", openai: "default" },
  keys: { elevenlabs: { state: "set", source: "ui" }, openai: { state: "unset", source: "default" } },
  defaults: TTS_DEFAULTS,
})
const hook = (id: string, enabled: boolean) =>
  ({ id, name: `Hook ${id}`, enabled, trigger: "task.pr_ready", action: "send_to_task", prompt: "merge it", filters: {}, projectId: null, lastRun: null }) as unknown as HookWithLastRun

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: unknown }[]
let section: SettingsSection
let closed: number
let spoken: string[]
let played: number

function render() {
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(SettingsDialog, {
          section,
          onSection: (s: SettingsSection) => {
            section = s
            render()
          },
          onClose: () => closed++,
        }),
      ),
    ),
  )
}

beforeEach(() => {
  requests = []
  closed = 0
  spoken = []
  played = 0
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
    played++
    return Promise.resolve()
  })
  localStorage.clear()
  // A browser with speech, so the Voice controls are enabled.
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(readonly text = "") {}
    },
  )
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { speak: (u: { text?: string }) => void spoken.push(u.text ?? ""), cancel() {}, pause() {}, resume() {}, speaking: false, paused: false, getVoices: () => [], addEventListener() {}, removeEventListener() {} },
  })
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, settingsInfo())
  qc.setQueryData(keys.health, { provider: "local" })
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "/tmp/agents" })
  qc.setQueryData(keys.tts, ttsInfo())
  qc.setQueryData(keys.hooks("global"), [hook("hk_one", false), hook("hk_two", true)])
  qc.setQueryData(keys.hookRuns("global"), [])
  qc.setQueryData(keys.hookTemplates, [])
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
    if (method === "PUT" && url === "/api/setup/runner") {
      const setup = qc.getQueryData<SetupStatus>(keys.setup)!
      const own = body.runner === "daytona" || body.runner === "ssh"
      return json({ ...setup, runner: { choice: own ? setup.runner.choice : body.runner, provider: body.runner, default: body.runner === "daytona" ? "gpu" : body.runner } })
    }
    if (method === "PUT" && url === "/api/daytona/settings") {
      const daytona = qc.getQueryData<DaytonaStatus>(keys.daytona)!
      return json({ ...daytona, settings: { ...daytona.settings, ...body } })
    }
    if (method === "PUT" && url === "/api/setup/credentials") {
      const setup = qc.getQueryData<SetupStatus>(keys.setup)!
      return json({ ...setup, credentials: { ...setup.credentials, ...Object.fromEntries(Object.keys(body).map((key) => [key, { state: "set", source: "saved" }])) } })
    }
    if (method === "PUT" && url === "/api/tts/settings") return json({ ...ttsInfo(body.provider ?? "browser") })
    if (method === "PUT" && url === "/api/agent-settings") return json(settingsInfo(body))
    if (method === "PATCH" && url.startsWith("/api/hooks/")) return json({ ...hook(url.split("/").at(-1)!, body.enabled) })
    return new Promise(() => {})
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  while (currentConfirm()) settleConfirm(currentConfirm()!.id, false)
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)
// happy-dom misreads a range input's step (0.1) as a step mismatch, which would block the form's submit.
const saveButton = () => {
  for (const f of document.querySelectorAll("form")) f.noValidate = true
  return button("Save")!
}
const unsaved = () => document.querySelector("[data-testid=unsaved-count]")?.textContent ?? null
const radio = (p: string) => document.querySelector<HTMLButtonElement>(`[data-provider="${p}"]`)!
const navDot = (s: SettingsSection) => Boolean(document.querySelector(`[data-section=${s}] [title="Unsaved changes"]`))
const checkbox = (label: string) => [...document.querySelectorAll("label")].find((l) => l.textContent?.trim() === label)!.querySelector("input")!
const writes = () => requests.filter((r) => r.method !== "GET")
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click())
  await settle()
}

describe("Settings drafts", () => {
  it("Read Captain replies aloud defaults on and waits for Save; Discard restores it", async () => {
    section = "voice"
    render()
    expect(checkbox("Read Captain replies aloud").checked).toBe(true)
    await click(checkbox("Read Captain replies aloud"))
    expect(getVoiceSettings().captains).toBe(true)
    expect(localStorage.getItem(VOICE_KEY)).toBeNull()
    expect(saveButton().disabled).toBe(false)
    await click(button("Discard"))
    expect(checkbox("Read Captain replies aloud").checked).toBe(true)
    await click(checkbox("Read Captain replies aloud"))
    await click(saveButton())
    expect(getVoiceSettings().captains).toBe(false)
    expect(JSON.parse(localStorage.getItem(VOICE_KEY)!).captains).toBe(false)
    expect(writes()).toEqual([])
  })

  it("a radio change doesn't save until Save, and Save enables and disables with it", async () => {
    section = "voice"
    render()
    expect(saveButton().disabled).toBe(true)
    await click(radio("elevenlabs"))
    expect(radio("elevenlabs").getAttribute("aria-checked")).toBe("true")
    expect(writes()).toEqual([])
    expect(saveButton().disabled).toBe(false)
    expect(unsaved()).toBe("1 unsaved change")
    expect(navDot("voice")).toBe(true)
    expect(navDot("orchestrator")).toBe(false)

    // Back to the saved provider: nothing to save again.
    await click(radio("browser"))
    expect(saveButton().disabled).toBe(true)
    expect(unsaved()).toBeNull()
    expect(navDot("voice")).toBe(false)

    await click(radio("openai"))
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PUT", url: "/api/tts/settings", body: { provider: "openai" } }])
    expect(radio("openai").getAttribute("aria-checked")).toBe("true")
    expect(saveButton().disabled).toBe(true)
    expect(document.body.textContent).toContain("Saved")
  })

  it("changing the provider never speaks or plays anything, in the draft or on Save; only Test voice does", async () => {
    expect(getVoiceSettings().enabled).toBe(true)
    section = "voice"
    render()
    for (const p of ["openai", "elevenlabs", "openai"]) await click(radio(p))
    await click(saveButton())
    await click(radio("browser"))
    await click(saveButton())
    expect(writes().filter((r) => r.url === "/api/tts/settings")).toHaveLength(2)
    // A silent unlock utterance ("") is fine; no line is read.
    expect(spoken.filter(Boolean)).toEqual([])
    expect(played).toBe(0)
    await click(button("Test voice"))
    expect(spoken.filter(Boolean)).toHaveLength(1)
  })

  it("browser-only voice choices stay out of localStorage until Save", async () => {
    section = "voice"
    render()
    const before = getVoiceSettings().orchestrator
    act(() => checkbox("Coordinator summaries").click())
    await settle()
    expect(checkbox("Coordinator summaries").checked).toBe(!before)
    expect(localStorage.getItem(VOICE_KEY)).toBeNull()
    expect(getVoiceSettings().orchestrator).toBe(before)
    expect(saveButton().disabled).toBe(false)
    await click(saveButton())
    expect(getVoiceSettings().orchestrator).toBe(!before)
    expect(JSON.parse(localStorage.getItem(VOICE_KEY)!).orchestrator).toBe(!before)
    expect(saveButton().disabled).toBe(true)
  })

  it("Discard reverts every draft", async () => {
    section = "voice"
    render()
    const before = getVoiceSettings().taskEvents
    await click(radio("elevenlabs"))
    act(() => checkbox("Task events").click())
    await settle()
    expect(unsaved()).toBe("2 unsaved changes")
    await click(button("Discard"))
    expect(radio("browser").getAttribute("aria-checked")).toBe("true")
    expect(checkbox("Task events").checked).toBe(before)
    expect(saveButton().disabled).toBe(true)
    expect(writes()).toEqual([])
    expect(localStorage.getItem(VOICE_KEY)).toBeNull()
  })

  it("closing with unsaved changes asks: Discard, or Keep editing", async () => {
    section = "voice"
    render()
    await click(radio("elevenlabs"))
    act(() => document.querySelector<HTMLButtonElement>("button[aria-label=Close]")!.click())
    await settle()
    const ask = currentConfirm()!
    expect(ask).toMatchObject({ confirmLabel: "Discard", cancelLabel: "Keep editing" })
    act(() => settleConfirm(ask.id, false))
    await settle()
    expect(closed).toBe(0)
    expect(radio("elevenlabs").getAttribute("aria-checked")).toBe("true")
  })

  it("drafts survive switching sections, and one Save writes them all", async () => {
    section = "voice"
    render()
    await click(radio("openai"))
    await click(document.querySelector("[data-section=orchestrator]"))
    act(() => (document.querySelector("[data-testid=notes-retro]") as HTMLInputElement).click())
    await settle()
    expect(unsaved()).toBe("2 unsaved changes")
    expect(navDot("voice")).toBe(true)
    expect(navDot("orchestrator")).toBe(true)
    await click(document.querySelector("[data-section=voice]"))
    expect(radio("openai").getAttribute("aria-checked")).toBe("true")
    expect(writes()).toEqual([])

    await click(saveButton())
    expect(writes().map((r) => `${r.method} ${r.url}`).sort()).toEqual(["PUT /api/agent-settings", "PUT /api/tts/settings"])
    expect(writes().find((r) => r.url === "/api/agent-settings")!.body).toMatchObject({ notesRetroEnabled: !DEFAULT_SETTINGS.notesRetroEnabled })
    expect(saveButton().disabled).toBe(true)
  })

  it("the Coordinator's PR merge settings (Done when its PR merges, Close the issues it names) wait for Save", async () => {
    section = "orchestrator"
    render()
    const auto = document.querySelector<HTMLInputElement>("[data-testid=auto-done-on-merge]")!
    const issues = document.querySelector<HTMLInputElement>("[data-testid=close-issues-on-merge]")!
    expect(auto.checked).toBe(true)
    expect(issues.checked).toBe(true)
    await click(auto)
    await click(issues)
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("2 unsaved changes")
    await click(saveButton())
    expect(writes()).toMatchObject([{ method: "PUT", url: "/api/agent-settings", body: { autoDoneOnMerge: false, closeIssuesOnMerge: false } }])
  })

  it("Resume after usage limits is on by default and waits for Save", async () => {
    section = "orchestrator"
    render()
    const resume = document.querySelector<HTMLInputElement>("[data-testid=resume-after-usage-limit]")!
    expect(resume.checked).toBe(true)
    await click(resume)
    expect(writes()).toEqual([])
    await click(saveButton())
    expect(writes()).toMatchObject([{ method: "PUT", url: "/api/agent-settings", body: { resumeAfterUsageLimit: false } }])
  })

  it("hook switches in Settings wait for Save", async () => {
    section = "hooks"
    render()
    const sw = () => document.querySelector<HTMLButtonElement>('[role=switch][aria-label="Turn on Hook hk_one"], [role=switch][aria-label="Turn off Hook hk_one"]')!
    await click(sw())
    expect(sw().getAttribute("aria-checked")).toBe("true")
    expect(writes()).toEqual([])
    expect(navDot("hooks")).toBe(true)
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/hooks/hk_one", body: { enabled: true } }])
  })
})

describe("draftChanges", () => {
  it("counts changed fields of an object, else one", () => {
    expect(draftChanges({ a: 1, b: [1] }, { a: 1, b: [1] })).toBe(0)
    expect(draftChanges({ a: 2, b: [2] }, { a: 1, b: [1] })).toBe(2)
    expect(draftChanges("x", undefined)).toBe(1)
    expect(draftChanges(undefined, undefined)).toBe(0)
  })
})

const searchInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!
const typeInput = async (el: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}
const search = async (value: string) => typeInput(searchInput(), value)
const visible = (el: Element) => !el.closest("[hidden]")
const resultLabels = () => [...document.querySelectorAll("[data-settings-field]")].filter(visible).map((el) => el.getAttribute("data-settings-label"))
const key = (value: string, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra })
  act(() => document.activeElement!.dispatchEvent(event))
  return event
}

describe("Settings search", () => {
  beforeEach(() => seedSearchPanels(qc))
  it("focuses search on open; matches label, help, category and option labels live, in any word order", async () => {
    section = "orchestrator"
    render()
    expect(document.activeElement).toBe(searchInput())
    await search("EFFORT box")
    expect(resultLabels()).toContain("Effort")
    expect([...document.querySelectorAll("[data-settings-category]")].filter(visible).map((el) => el.getAttribute("data-settings-category"))).toEqual(["agents"])
    expect([...document.querySelectorAll("mark")].filter(visible).map((el) => el.textContent?.toLowerCase())).toContain("effort")
    await search("offline browser")
    expect(resultLabels()).toContain("Browser voice")
    await search("Coordinator decide")
    expect(resultLabels()).toContain("Effort")
    expect(document.querySelector('[data-settings-label="Effort"] [data-settings-search-ignore]')?.textContent).toContain("Let the Coordinator decide")
    await search("speech")
    expect(resultLabels()).toContain("Voice announcements")
    await search("[literal.*")
    expect(resultLabels()).toEqual([])
    await search("runner where")
    expect(resultLabels()).toContain("New projects run on")
    await search("sky identities")
    expect(resultLabels()).toContain("Colour")
    expect(document.querySelector('[data-settings-label="Colour"] [data-settings-search-ignore] mark')?.textContent).toBe("sky")
  })

  it("updates the registry when asynchronously loaded option labels change", async () => {
    section = "agents"
    render()
    await search("newly discovered")
    expect(resultLabels()).toEqual([])
    await act(async () => {
      qc.setQueryData(keys.models, { models: [{ id: "claude-new-model", label: "Newly discovered model", group: "latest", note: "", efforts: ["low", "high"] }] })
      await new Promise((r) => setTimeout(r, 20))
    })
    await settle()
    expect(resultLabels()).toContain("Model")
    expect(document.querySelector('[data-settings-label="Model"] [data-settings-search-ignore]')?.textContent).toContain("Newly discovered model")
  })

  it("edits a Codex catalog model from search and saves it with the normal Settings draft", async () => {
    section = "agents"
    render()
    const choose = async (el: HTMLSelectElement, value: string) => {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value)
        el.dispatchEvent(new Event("change", { bubbles: true }))
      })
      await settle()
    }
    await choose(document.querySelector<HTMLSelectElement>('[data-testid="agent-cli"]')!, "codex")
    await search("gpt-6-luna")
    expect(resultLabels()).toContain("Codex model")
    const model = document.querySelector<HTMLSelectElement>('[data-testid="agent-codex-model"]')!
    expect(model.value).toBe("gpt-6.1-sol")
    await choose(model, "gpt-6-luna")
    expect(writes()).toEqual([])
    await click(document.querySelector('[aria-label="Clear settings search"]'))
    expect(model.value).toBe("gpt-6-luna")
    await click(saveButton())
    expect(writes()).toMatchObject([{ method: "PUT", url: "/api/agent-settings", body: { agentCli: "codex", agentCodexModel: "gpt-6-luna" } }])
  })

  it("edits the real fields, preserves browser and server drafts across queries and clearing, then saves them together", async () => {
    section = "orchestrator"
    render()
    await search("captain replies")
    const before = checkbox("Read Captain replies aloud").checked
    await click(checkbox("Read Captain replies aloud"))
    await search("max notes")
    await typeInput(document.querySelector<HTMLInputElement>('[data-settings-field][data-settings-label="Max notes"] input')!, "8")
    expect(writes()).toEqual([])
    expect(localStorage.getItem(VOICE_KEY)).toBeNull()
    expect(unsaved()).toBe("2 unsaved changes")
    await search("nothing-matches-this")
    expect(resultLabels()).toEqual([])
    expect(document.body.textContent).toContain("No settings found")
    await click(document.querySelector('[aria-label="Clear settings search"]'))
    expect(document.querySelector<HTMLInputElement>('[data-settings-field][data-settings-label="Max notes"] input')!.value).toBe("8")
    await search("captain replies")
    expect(checkbox("Read Captain replies aloud").checked).toBe(!before)
    expect(key("Enter").defaultPrevented).toBe(true)
    expect(writes()).toEqual([])
    await click(saveButton())
    expect(writes()).toMatchObject([{ method: "PUT", url: "/api/agent-settings", body: { notesMaxCount: 8 } }])
    expect(getVoiceSettings().captains).toBe(!before)
    expect(saveButton().disabled).toBe(true)
  })

  it("filters individual hooks and saves a matching switch only on Save", async () => {
    section = "hooks"
    render()
    await search("hk_one")
    expect(resultLabels()).toEqual(["Hook hk_one"])
    const toggle = document.querySelector<HTMLButtonElement>('[role=switch][aria-label="Turn on Hook hk_one"]')!
    await click(toggle)
    expect(writes()).toEqual([])
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/hooks/hk_one", body: { enabled: true } }])
  })

  it("Discard restores filtered drafts", async () => {
    section = "voice"
    render()
    await search("captain replies")
    const before = checkbox("Read Captain replies aloud").checked
    await click(checkbox("Read Captain replies aloud"))
    await click(button("Discard"))
    expect(checkbox("Read Captain replies aloud").checked).toBe(before)
    expect(writes()).toEqual([])
  })

  it("document shortcuts prevent the window palette, preserve slashes while typing, and clear on first Escape", async () => {
    section = "orchestrator"
    render()
    const seen: boolean[] = []
    const palette = (e: KeyboardEvent) => { if (e.key === "/") seen.push(e.defaultPrevented) }
    window.addEventListener("keydown", palette)
    try {
      act(() => button("Close")!.focus())
      expect(key("/").defaultPrevented).toBe(true)
      expect(seen).toEqual([true])
      expect(document.activeElement).toBe(searchInput())
      expect(key("/").defaultPrevented).toBe(false)
      act(() => document.querySelector<HTMLSelectElement>('[aria-label="Settings category"]')!.focus())
      expect(key("/").defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(searchInput())
      act(() => document.querySelector<HTMLInputElement>('[data-settings-field][data-settings-label="Max notes"] input')!.focus())
      expect(key("f", { metaKey: true }).defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(searchInput())
      await search("MODEL")
      expect(key("Escape").defaultPrevented).toBe(true)
      await settle()
      expect(searchInput().value).toBe("")
      expect(closed).toBe(0)
      key("Escape")
      await settle()
      expect(closed).toBe(1)
    } finally { window.removeEventListener("keydown", palette) }
  })

  it("Escape clears before asking about unsaved drafts", async () => {
    section = "orchestrator"
    render()
    await typeInput(document.querySelector<HTMLInputElement>('[data-settings-field][data-settings-label="Max notes"] input')!, "9")
    await search("max notes")
    key("Escape")
    await settle()
    expect(currentConfirm()).toBeFalsy()
    expect(searchInput().value).toBe("")
    key("Escape")
    await settle()
    expect(currentConfirm()?.title).toBe("Discard unsaved changes?")
    expect(closed).toBe(0)
    act(() => settleConfirm(currentConfirm()!.id, false))
    await settle()
    expect(unsaved()).toBe("1 unsaved change")
  })

  it("every rendered setting control belongs to the field registry, including conditional fields", async () => {
    section = "orchestrator"
    seedSearchPanels(qc)
    render()
    await search("all-panels-mounted")
    // In search every section is mounted; inspect even filtered/disabled controls. A new naked input fails here.
    const assertCoverage = () => {
      const controls = [...document.querySelectorAll('[data-settings-section] input, [data-settings-section] textarea, [data-settings-section] select, [data-settings-section] [role=switch], [data-settings-section] [role=radio]')]
      expect(controls.length).toBeGreaterThan(100)
      expect(controls.filter((el) => !el.closest('[data-settings-field]')).map((el) => el.outerHTML)).toEqual([])
      expect([...document.querySelectorAll('[data-settings-field]')].every((el) => el.closest('[data-settings-category]'))).toBe(true)
    }
    assertCoverage()
    await search("voice")
    await click(radio("openai"))
    assertCoverage()
    await search("alloy")
    expect(resultLabels()).toContain("Voice")
    expect(document.querySelector('[data-voice-picker="openai"] mark')?.textContent?.toLowerCase()).toBe("alloy")
    await search("voice")
    await click(radio("elevenlabs"))
    assertCoverage()
    await search("codex coordinator")
    const cli = document.querySelector<HTMLSelectElement>('[data-testid="orchestrator-cli"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(cli, "codex")
      cli.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await settle()
    assertCoverage()
    await search("gpt-6.1-terra coordinator")
    expect(resultLabels()).toContain("Codex model")
    expect(document.querySelector('[data-settings-label="Codex model"] [data-settings-search-ignore]')?.textContent).toContain("gpt-6.1-terra")
  })

  it("drills into providers, shows the saved default and retains drafts across navigation and search", async () => {
    section = "runners"
    seedSearchPanels(qc)
    render()
    expect(document.querySelector('[data-runner-section=local]')!.textContent).toContain("Saved default")
    expect(document.querySelector('[data-runner-section=daytona]')!.textContent).toContain("API key missing")
    expect(document.querySelector('[data-section=daytona]')).toBeNull()
    const nav = document.querySelector<HTMLSelectElement>('[aria-label="Settings category"]')!
    expect(nav.value).toBe("runners")
    await click(document.querySelector<HTMLButtonElement>('[data-runner-choice=box]')!)
    await click(document.querySelector<HTMLButtonElement>('[data-runner-section=upstash]')!)
    expect(section).toBe("upstash")
    expect(document.activeElement?.hasAttribute("data-settings-back")).toBe(true)
    expect(document.querySelector('[role=tabpanel]')!.textContent).toContain("Box providers")
    await typeInput(document.querySelector<HTMLInputElement>('[data-credential=upstashBoxApiKey] input')!, "draft-key")
    expect(unsaved()).toBe("2 unsaved changes")
    await click(button("Box providers"))
    expect(section).toBe("runners")
    expect(document.activeElement?.getAttribute("data-runner-section")).toBe("upstash")
    expect(nav.options[nav.selectedIndex]!.text).toContain("unsaved")
    expect(document.querySelector('[data-runner-section=upstash] [title="Unsaved changes"]')).not.toBeNull()
    await search("key Upstash where")
    expect(resultLabels()).toContain("Upstash Box API key")
    expect(document.querySelector('[data-settings-category=upstash] h3')!.textContent).toBe("Box providers › Upstash boxes")
    await search("")
    expect(document.querySelector('[data-runner-choice=box]')!.getAttribute('aria-pressed')).toBe("true")
    expect(writes()).toEqual([])
    await click(saveButton())
    await settle()
    expect(writes()).toEqual(expect.arrayContaining([
      { method: "PUT", url: "/api/setup/runner", body: { runner: "box" } },
      { method: "PUT", url: "/api/setup/credentials", body: { upstashBoxApiKey: "draft-key" } },
    ]))
    expect(unsaved()).toBeNull()
  })

  it("Box providers: picks the provider first, then that provider's own sizes, as drafts until Save", async () => {
    section = "runners"
    seedSearchPanels(qc)
    render()
    const sizes = (p: string) => document.querySelector<HTMLElement>(`[data-provider-size=${p}]`)
    const size = (k: string) => document.querySelector<HTMLButtonElement>(`[data-size="${k}"]`)!
    expect(sizes("local")!.hidden).toBe(false)
    expect(sizes("local")!.textContent).toContain("no size to pick")
    // Every provider is a choice, Daytona and SSH machines too.
    expect([...document.querySelectorAll("[data-runner-choice]")].map((el) => el.getAttribute("data-runner-choice"))).toEqual(["local", "box", "docker", "daytona", "ssh"])

    await click(document.querySelector('[data-runner-choice=box]'))
    expect(sizes("local")!.hidden).toBe(true)
    expect(size("upstash:small").getAttribute("aria-checked")).toBe("true")
    await click(size("upstash:large"))

    await click(document.querySelector('[data-runner-choice=daytona]'))
    expect(sizes("box")!.hidden).toBe(true)
    // Daytona's own list: CPU only, then a GPU, then Custom (the defaults ask for two GPU types, so they're Custom).
    expect(size("daytona:cpu-small").textContent).toContain("2 vCPU · 4 GB RAM · 10 GB disk")
    expect(size("daytona:gpu-H100").textContent).toContain("H100")
    expect(size("daytona:custom").getAttribute("aria-checked")).toBe("true")
    await click(size("daytona:gpu-H100"))
    expect(size("daytona:gpu-H100").getAttribute("aria-checked")).toBe("true")
    expect(document.querySelector("[data-runner-section=daytona] [title='Unsaved changes']")).not.toBeNull()
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("3 unsaved changes")

    await click(saveButton())
    await settle()
    expect(writes()).toEqual(expect.arrayContaining([
      { method: "PUT", url: "/api/setup/runner", body: { runner: "daytona" } },
      { method: "PUT", url: "/api/daytona/settings", body: { gpuTypes: ["H100"] } },
      { method: "PUT", url: "/api/agent-settings", body: expect.objectContaining({ workerSize: "large" }) },
    ]))
    expect(unsaved()).toBeNull()
    expect(document.querySelector("[data-runner-section=daytona]")!.textContent).toContain("Saved default")
  })

  it("Box providers and a provider's own page edit one draft", async () => {
    section = "runners"
    seedSearchPanels(qc)
    render()
    const size = (k: string) => document.querySelector<HTMLButtonElement>(`[data-size="${k}"]`)!
    await click(document.querySelector('[data-runner-choice=daytona]'))
    await click(size("daytona:cpu-large"))
    // The runner, and Daytona's CPU-only type, vCPUs, memory and disk.
    expect(unsaved()).toBe("5 unsaved changes")
    await click(document.querySelector('[data-runner-section=daytona]'))
    expect(section).toBe("daytona")
    const types = () => document.querySelector('[data-settings-section=daytona] [data-testid$="daytona-gpus-list"]')!.textContent
    expect(types()).toContain("CPU only")
    expect(types()).not.toContain("RTX 4090")
    await click(button("Box providers"))
    expect(size("daytona:cpu-large").getAttribute("aria-checked")).toBe("true")
    expect(unsaved()).toBe("5 unsaved changes")
    // Custom is Daytona's own numbers, on its own page.
    await click(size("daytona:custom"))
    expect(section).toBe("daytona")
    await click(button("Discard"))
    expect(unsaved()).toBeNull()
    expect(types()).toContain("RTX 4090")
    expect(writes()).toEqual([])
  })

  it("Box providers: the Default GPU cloud lists that cloud's own GPUs with their @ picks", async () => {
    section = "runners"
    seedSearchPanels(qc)
    render()
    const cloud = (p: string) => document.querySelector<HTMLButtonElement>(`[data-gpu-cloud=${p}]`)!
    const gpus = () => [...document.querySelectorAll("[data-gpu]")].map((el) => el.getAttribute("data-gpu"))
    expect(cloud("runpod").getAttribute("aria-checked")).toBe("true")
    expect(gpus()).toContain("runpod:rtx-a5000")
    expect(gpus().every((g) => g!.startsWith("runpod:"))).toBe(true)
    await click(cloud("daytona"))
    expect(cloud("daytona").getAttribute("aria-checked")).toBe("true")
    expect(gpus()).toContain("daytona:h100")
    expect(gpus()).toContain("daytona:cpu")
    expect(gpus().some((g) => g!.startsWith("runpod:"))).toBe(false)
    expect(document.querySelector("[data-gpu='daytona:h100']")!.textContent).toContain("@gpu:daytona:h100")
    expect(document.querySelector("[data-testid=gpu-default-line]")!.textContent).toContain("@gpu runs a task on Daytona with RTX 4090 or RTX 5090")
    // The cloud's own page shows the unsaved pick too.
    await click(document.querySelector<HTMLElement>("[data-runner-section=daytona]")!)
    expect(document.querySelector("[data-testid=daytona-gpu-default]")?.textContent).toBe("Yes: Daytona is the default")
    expect(writes()).toEqual([])
    await click(saveButton())
    await settle()
    expect(writes()).toEqual([{ method: "PUT", url: "/api/agent-settings", body: expect.objectContaining({ gpuProvider: "daytona" }) }])
  })

  it("shows nested category paths and indexes them in any word order", async () => {
    section = "daytona"
    seedSearchPanels(qc)
    render()
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Settings category"]')!.value).toBe("runners")
    await search("KEY daytona GPU providers")
    expect(resultLabels()).toContain("Daytona API key")
    expect(document.querySelector('[data-settings-category=daytona] h3')!.textContent).toBe("Box providers › Daytona")
    expect(document.querySelector('[data-settings-category=daytona] h3 mark')!.textContent?.toLowerCase()).toBe("providers")
    await search("vast KEY gpu providers")
    expect(document.querySelector('[data-settings-category=vast] h3')!.textContent).toBe("Box providers › GPU clouds › Vast.ai GPU")
    await search("runner where")
    const categories = [...document.querySelectorAll('[data-settings-category]')].filter(visible).map((el) => el.getAttribute('data-settings-category'))
    expect(categories).toContain("local")
    expect(categories).toContain("agents")
    await search("")
    expect(section).toBe("daytona")
  })

  it("finds signing by gpg and never indexes typed credentials", async () => {
    section = "orchestrator"
    seedSearchPanels(qc)
    render()
    await search("gpg")
    expect(resultLabels()).toContain("Signing key")
    expect([...document.querySelectorAll('[data-settings-label="Signing key"] mark')].some((el) => el.textContent?.toLowerCase() === "gpg")).toBe(true)
    expect([...document.querySelectorAll('[data-settings-category]')].filter(visible).map((el) => el.getAttribute('data-settings-category'))).toContain("identities")
    await search("github token")
    const input = document.querySelector<HTMLInputElement>('[data-credential=githubToken] input')!
    await typeInput(input, "sensitive-search-canary")
    await search("sensitive-search-canary")
    expect(resultLabels()).toEqual([])
    await search("")
    expect(input.value).toBe("sensitive-search-canary")
    expect(writes()).toEqual([])
  })
})

// Full mock responses make the registry coverage gate reach provider and identity controls too.
function seedSearchPanels(client: QueryClient) {
  vi.stubGlobal("__APP_VERSION__", "test")
  vi.stubGlobal("__APP_COMMIT__", "")
  client.setQueryData(keys.health, { provider: "local", mock: true, claude: { available: true, version: "mock" }, bus: "local", scheduler: "local" })
  client.setQueryData(keys.setup, {
    ready: true, mock: true, missing: [], restart: [], authorFallbacks: [],
    credentials: Object.fromEntries(CREDENTIAL_KEYS.map((k) => [k, { state: "unset", source: null }])),
    boxes: { provider: "local", required: false }, claude: { required: false, state: "unset", using: null },
    codex: { required: false, state: "unset", using: null }, github: { state: "unset" },
    owner: { name: "Owner", source: "default" }, runner: { choice: "local", provider: "local", default: "local" }, upstash: { available: true }, local: null,
  })
  client.setQueryData(keys.projects, [{ id: "prj_search", name: "Search project", repo: null }])
  client.setQueryData(keys.identities, [{ id: "idn_default", name: "Default", color: "sky", isDefault: false, githubLogin: null, githubId: null, owners: [], tokens: [], author: null, signing: { format: "ssh", kind: "file", publicKey: "ssh-ed25519 test", fingerprint: "SHA256:test", program: null, requireSigned: false, readable: true }, claude: null, runners: null, coordinatorSees: "everything", projectIds: [], lastCheck: null, createdAt: 1, updatedAt: 1 }])
  const build = { state: "idle", log: "", tag: null, error: null }
  client.setQueryData(keys.runpod, { settings: DEFAULT_RUNPOD_SETTINGS, apiKey: false, docker: { installed: false, running: false, error: null }, currentTag: "test", build, pods: [], volumes: [], problem: null, error: null })
  client.setQueryData(keys.runpodGpus, [])
  client.setQueryData(keys.vast, { settings: DEFAULT_VAST_SETTINGS, apiKey: false, image: "test", instances: [], balanceUsd: null, problem: null, error: null })
  client.setQueryData(keys.vastGpus, [])
  client.setQueryData(keys.daytona, { settings: DEFAULT_DAYTONA_SETTINGS, apiKey: false, image: "test", cpuImage: "test", sandboxes: [], problem: null, error: null })
  client.setQueryData(keys.docker, { docker: { installed: false, running: false, version: null, error: null, cpus: null, memoryBytes: null }, settings: DEFAULT_DOCKER_SETTINGS, image: { tag: "test", present: false }, build, containers: [] })
  client.setQueryData(keys.machines, { machines: [], labels: [], settings: { localLabel: null } })
}


describe("Appearance drafts", () => {
  it("applies and persists the theme only on Save, with Discard restoring the saved choice", async () => {
    setTheme("dark")
    section = "appearance"
    render()
    const label = () => [...document.querySelectorAll("label")].find((l) => l.textContent === "Theme")!
    const select = () => document.getElementById(label().htmlFor) as HTMLSelectElement
    const choose = async (value: string) => {
      act(() => { select().value = value; select().dispatchEvent(new Event("change", { bubbles: true })) })
      await settle()
    }
    expect(select().tagName).toBe("SELECT")
    await choose("light")
    expect(localStorage.getItem(THEME_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(unsaved()).toContain("1")
    expect(navDot("appearance")).toBe(true)
    await click(button("Discard"))
    expect(select().value).toBe("dark")
    await choose("light")
    await click(saveButton())
    expect(localStorage.getItem(THEME_KEY)).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(unsaved()).toBe(null)
    await choose("system")
    await click(saveButton())
    expect(localStorage.getItem(THEME_KEY)).toBe("system")
    expect(writes()).toEqual([])
  })
})
