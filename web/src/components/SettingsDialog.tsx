import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react"
import { ArrowLeft, Palette, BarChart3, Bell, Bot, Boxes, Check, CircleAlert, Cloud, Container, Laptop, Cpu, DollarSign, Fingerprint, FolderGit2, Info, KeyRound, Network, Plug, Server, Search, X, Volume2, Webhook, type LucideIcon } from "lucide-react"
import { useAgentSettings, useHealth, useResetSettings, useSaveSettings, useSettings } from "../lib/queries"
import {
  SETTINGS_SECTIONS,
  SETTINGS_TOP_SECTIONS,
  settingsRoot,
  SETTING_ENV,
  changedKeys,
  changedSections,
  savePatch,
  type SettingsSection,
} from "../lib/settingsNav"
import { SettingsDraftContext, SettingsFieldError, draftSlots, updateParts, useDraft, type DraftPart, type DraftRegistry } from "../lib/settingsDraft"
import { SettingsField, SettingsSearchProvider, SearchHighlight, useSettingsSearch } from "../lib/settingsSearch"
import { NUMBER_RULES, numberText, problemSections, refusedByBrowser, settingsProblems, typedNumber, type SettingPath } from "../lib/settingsValidation"
import { LEGACY_POOL_DEFAULTS, sizeCapacities } from "../lib/capacity"
import { AppearancePanel } from "./AppearanceSettings"
import { VoicePanel } from "./VoiceSettings"
import { SendSoundRow } from "./SendSoundSettings"
import { BrowserNotificationsRow } from "./BrowserNotificationSettings"
import { setSendSound, useSendSound } from "../lib/sendSound"
import { HooksPanel } from "./Hooks"
import { CredentialsPanel, LocalRunnerPanel, UpstashPanel } from "./Setup"
import { RunnerSettings } from "./RunnerSettings"
import { IdentitiesPanel } from "./Identities"
import { ConnectorsPanel } from "./Connectors"
import { RunPodPanel } from "./RunPodSettings"
import { VastPanel } from "./VastSettings"
import { DaytonaPanel } from "./DaytonaSettings"
import { DockerPanel } from "./DockerSettings"
import { MachinesPanel } from "./MachineSettings"
import { useOpenUsage } from "./UsageHost"
import { ProjectSettingsPicker } from "./ProjectSettingsDialog"
import { Modal } from "./Modal"
import { Panel, Row, SourceHint } from "./SettingsBlocks"
import { UpstashSizes } from "./SizeCards"
import { SettingsTabs, type SettingsTab } from "./SettingsTabs"
import { confirmDialog } from "../lib/confirm"
import { EffortPicker, ModelPicker } from "./ModelPicker"
import { CaptainIconPicker } from "./CaptainIconPicker"
import { EFFORT_LABEL } from "../../../shared/models"
import { CodexModelSelect } from "./CodexModelSelect"
import { OpenCodeModelInput } from "./OpenCodeModelInput"
import { CursorModelSelect } from "./CursorModelSelect"
import { Button, LineIcon, NewTabLink, Select, cx, inputClass } from "./ui"
import { Loading } from "./Loading"
import { BOX_SIZE_SPECS } from "../../../shared/boxSizes"
import { AGENT_CLIS, AGENT_CLI_LABEL, hasSeparateEffort, MANAGER_CLIS, type AgentCli } from "../../../shared/agentCli"
import { NOTE_BUDGET_LIMITS } from "../../../shared/notes"
import { LOCAL_AGENTS_LIMITS, LOCAL_UNSANDBOXED } from "../../../shared/runner"
import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  BOX_CREATE_CONCURRENCY,
  BOX_SIZES,
  SUBTASK_MAX_CHILDREN,
  SUBTASK_MAX_DEPTH,
  DEFAULT_AUTOCOMPACT_TOKENS,
  SIZE_DEFAULTS,
  UPSTASH_FREE_CONCURRENT_BOXES,
  WORKER_SIZES,
  agentCapacity,
  type AgentEffort,
  type AutoCompact,
  type BoxSize,
  type Settings,
  type SettingSource,
} from "../../../shared/types"


const SECTION_ICON: Record<SettingsSection, LucideIcon> = { orchestrator: Network, projects: FolderGit2, agents: Bot, runners: Server, local: Laptop, upstash: Cloud, credentials: KeyRound, identities: Fingerprint, connectors: Plug, runpod: Cpu, vast: Cpu, daytona: Cpu, docker: Container, machines: Server, hooks: Webhook, limits: Boxes, costs: DollarSign, notifications: Bell, voice: Volume2, appearance: Palette, about: Info }
const TOP_TABS: SettingsTab<SettingsSection>[] = SETTINGS_TOP_SECTIONS.map((s) => ({ key: s.key, label: s.label, icon: SECTION_ICON[s.key] }))

// ------------------------------------------------------------------ building blocks

/** A field's problem, under its control, which points at it with aria-describedby. Search doesn't index it. */
function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} data-settings-search-ignore className="flex basis-full items-start gap-1.5 text-xs leading-relaxed text-red-300">
      <LineIcon icon={CircleAlert} className="h-3.5 w-3.5" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** On a field's control: Save finds a problem by `data-setting`, and the control names its error. */
type FieldProps = InputHTMLAttributes<HTMLInputElement> & { "data-setting": SettingPath }
type FieldCheck = (path: SettingPath) => FieldProps
type Hint = (k: keyof Settings, problems?: SettingPath[]) => ReactNode
type NumberKey = { [K in keyof Settings]-?: Settings[K] extends number ? K : never }[keyof Settings]

function AutoCompactControl({
  id,
  label,
  value,
  onChange,
  tokens = 800_000,
  field,
}: {
  id: string
  label: string
  value: AutoCompact
  onChange: (v: AutoCompact) => void
  /** The token count a switch to "tokens" starts from. */
  tokens?: number
  field?: FieldProps
}) {
  const percent = value.unit === "percent"
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input id={id} type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        Enabled
      </label>
      <div className="flex flex-col gap-2 @sm:flex-row @sm:items-center">
        <input
          type="number"
          className={cx(inputClass, "min-w-0 flex-1 disabled:opacity-50")}
          disabled={!value.enabled}
          value={numberText(value.value)}
          min={percent ? 10 : AUTOCOMPACT_MIN_TOKENS}
          max={percent ? 95 : AUTOCOMPACT_MAX_TOKENS}
          step={percent ? 5 : 10_000}
          onChange={(e) => onChange({ ...value, value: typedNumber(e.target.value) })}
          aria-label={`${label} threshold`}
          {...field}
        />
        <Select
          className="w-full shrink-0 @sm:w-36"
          disabled={!value.enabled}
          value={value.unit}
          aria-label={`${label} unit`}
          onChange={(e) => {
            const unit = e.target.value as AutoCompact["unit"]
            onChange({ ...value, unit, value: unit === "percent" ? 80 : tokens })
          }}
        >
          <option value="percent">% of window</option>
          <option value="tokens">tokens</option>
        </Select>
      </div>
    </div>
  )
}

/** One of `clis` (shared/agentCli.ts): every harness for task agents, Claude Code or Codex for the Coordinator and Captains. */
function AgentCliSelect<C extends AgentCli>({ id, value, onChange, testId, clis }: { id: string; value: C; onChange: (v: C) => void; testId: string; clis: readonly C[] }) {
  return (
    <Select id={id} className="w-full" value={value} onChange={(e) => onChange(e.target.value as C)} data-testid={testId}>
      {clis.map((c) => (
        <option key={c} value={c}>
          {AGENT_CLI_LABEL[c]}
        </option>
      ))}
    </Select>
  )
}

// ------------------------------------------------------------------ dialog

export function SettingsDialog({
  section,
  onSection,
  onClose,
}: {
  section: SettingsSection
  onSection: (s: SettingsSection) => void
  onClose: () => void
}) {
  const info = useAgentSettings()
  const save = useSaveSettings()
  const reset = useResetSettings()
  const resetFields = useResetSettings()
  const [draft, setDraft] = useState<Settings | null>(null)
  // Box limits typed in while the size defaults apply: saved even when the number matches the default.
  const [pinned, setPinned] = useState<(keyof Settings)[]>([])
  // Saved values to forget on Save ("Use size default").
  const [resets, setResets] = useState<(keyof Settings)[]>([])
  // Drafts of the parts that aren't plain Settings fields (voice, keys, RunPod, hooks...), registered by useDraft.
  const [parts, setParts] = useState<Record<string, DraftPart>>({})
  const registry = useMemo<DraftRegistry>(() => ({ update: (id, part) => setParts((p) => updateParts(p, id, part)), slot: draftSlots() }), [])
  // Sections opened so far stay mounted (hidden), so their drafts survive switching sections.
  const [visited, setVisited] = useState<SettingsSection[]>([section])
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const { registry: searchRegistry, matches, searching } = useSettingsSearch(query)
  const searchCategories = new Set(matches.map((f) => f.category))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const ids = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const previousSection = useRef(section)

  const current = info.data
  const s = draft ?? current?.settings
  const changed = [...new Set([...(draft ? [...changedKeys(draft, current?.settings), ...pinned] : []), ...resets])]
  const partList = Object.values(parts)
  const changeCount = changed.length + partList.reduce((n, p) => n + p.count, 0)
  const dirty = changeCount > 0
  const dirtySections = new Set([...changedSections(changed), ...partList.map((p) => p.section)])
  const rootSection = settingsRoot(section)
  const rootDirty = (key: SettingsSection) => [...dirtySections].some((s) => settingsRoot(s) === key)
  // What Save would send, checked with the server's limits: each problem shows under its field and holds Save.
  const patch = draft ? savePatch(draft, current?.settings, pinned) : {}
  for (const k of resets) delete patch[k]
  const problems = settingsProblems(patch)
  const problemCount = Object.keys(problems).length
  const problemRoots = new Set([...problemSections(problems)].map(settingsRoot))
  // A field to show after Save found a problem: its section opens first, then it's focused.
  const [reveal, setReveal] = useState<HTMLElement | string | null>(null)

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    if (!s) return
    setDraft({ ...s, [k]: v })
    setResets((r) => (r.includes(k) ? r.filter((x) => x !== k) : r))
  }
  const pin = (k: keyof Settings, on: boolean) => setPinned((p) => (on ? (p.includes(k) ? p : [...p, k]) : p.filter((x) => x !== k)))
  // Forget just these saved values on Save; until then the field shows the size defaults, marked unsaved.
  const resetKeys = (keys: (keyof Settings)[]) => {
    setResets((r) => [...new Set([...r, ...keys])])
    setPinned((p) => p.filter((k) => !keys.includes(k)))
    setDraft((d) => d && { ...d, ...Object.fromEntries(keys.map((k) => [k, current?.settings[k]])) })
  }
  const fid = (k: string) => `${ids}-${k}`
  const errorId = (path: SettingPath) => fid(`error-${path}`)
  const field: FieldCheck = (path) => ({ "data-setting": path, ...(problems[path] && { "aria-invalid": true, "aria-describedby": errorId(path) }) })
  // Under the control: the field's problems (by default its key's), then where its value comes from.
  const hint: Hint = (k, paths = [k]) => (
    <>
      {paths.map((p) => problems[p] && <FieldError key={p} id={errorId(p)}>{problems[p]}</FieldError>)}
      <SourceHint source={current?.sources[k]} env={SETTING_ENV[k]} changed={changed.includes(k)} />
    </>
  )

  const discard = () => {
    setDraft(null)
    setPinned([])
    setResets([])
    setSaveError(null)
    for (const p of partList) p.discard()
  }

  const close = async () => {
    if (
      dirty &&
      !(await confirmDialog({
        title: "Discard unsaved changes?",
        body: `${changeCount === 1 ? "1 change" : `${changeCount} changes`} to settings haven't been saved.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        danger: true,
      }))
    )
      return
    onClose()
  }

  useEffect(() => {
    setVisited((v) => (v.includes(section) ? v : [...v, section]))
  }, [section])

  useEffect(() => { searchRef.current?.focus() }, [])

  // A provider drill-in hides its button. Keep keyboard focus in the visible level, and return it on Back.
  useEffect(() => {
    const previous = previousSection.current
    previousSection.current = section
    if (previous === section) return
    if (settingsRoot(section) !== section) panelRef.current?.querySelector<HTMLButtonElement>("[data-settings-back]")?.focus()
    else if (settingsRoot(previous) === section) panelRef.current?.querySelector<HTMLButtonElement>(`[data-runner-section=${previous}]`)?.focus()
  }, [section])

  // Document runs before the window palette/Modal handlers. Nested dialogs keep their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dialog = searchRef.current?.closest("[role=dialog]")
      const dialogs = document.querySelectorAll("[role=dialog]")
      if (!dialog || dialogs.item(dialogs.length - 1) !== dialog || e.defaultPrevented || e.isComposing) return
      const target = e.target as HTMLElement
      const typing = target.closest?.("input, textarea, [contenteditable=true]")
      if ((e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f")) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === "Escape" && query) {
        e.preventDefault()
        e.stopPropagation()
        setQuery("")
        searchRef.current?.focus()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [query])

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 })
  }, [section, query])

  // After the scroll reset above. Waits while its section is still hidden (it shows on the next render).
  useEffect(() => {
    const control = typeof reveal === "string" ? document.getElementById(reveal) : reveal
    if (!control || control.closest("[hidden]")) return
    const details = control.closest("details")
    if (details) details.open = true
    control.scrollIntoView({ block: "center" })
    control.focus({ preventScroll: true })
    // A value only the browser checks gets the browser's own message.
    if (!control.hasAttribute("data-setting") && !control.hasAttribute("data-identity-field")) (control as HTMLInputElement).reportValidity?.()
    setReveal(null)
  }, [reveal, section, query])

  // Drafts live only in this dialog: reloading or closing the tab asks first, as closing the dialog does.
  useEffect(() => {
    if (!dirty) return
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = "" // Older Safari and Firefox
    }
    window.addEventListener("beforeunload", onLeave)
    return () => window.removeEventListener("beforeunload", onLeave)
  }, [dirty])

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(0), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  const saveCore = async () => {
    if (draft && (changedKeys(draft, current?.settings).length || pinned.length)) {
      const patch = savePatch(draft, current?.settings, pinned)
      for (const k of resets) delete patch[k]
      await save.mutateAsync(patch)
    }
    if (resets.length) await resetFields.mutateAsync(resets)
    setDraft(null)
    setPinned([])
    setResets([])
  }

  /** Opens `el`'s section (and leaves search) so the reveal effect can focus it. */
  const showField = (el: HTMLElement) => {
    const where = el.closest<HTMLElement>("[data-settings-section]")?.dataset.settingsSection as SettingsSection | undefined
    setQuery("")
    if (where && where !== section) onSection(where)
    setReveal(el)
  }

  /** The first field to fix: this section's, else the first section's with one. */
  const firstProblem = (form: HTMLFormElement) => {
    const invalid = "[data-setting][aria-invalid=true]"
    const own = form.querySelector<HTMLElement>(`[data-settings-section=${section}] ${invalid}`) ?? form.querySelector<HTMLElement>(invalid)
    // Other panels' fields have only the browser's checks (Save skips its own, which ignore hidden sections).
    return own ?? [...form.elements].find((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.willValidate && refusedByBrowser(el.validity)) ?? null
  }

  const failedSave = (error: unknown) => {
    setSaveError(error instanceof Error ? error.message : "Couldn't save")
    if (error instanceof SettingsFieldError) {
      error.reveal?.()
      setQuery("")
      onSection(error.section)
      setReveal(error.controlId)
    }
  }

  // One Save writes every draft. Each part starts inside the click, so a browser permission prompt still works.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || saving) return
    setSaveError(null)
    // Validate every pending part before writing anything, even when its editor or section is hidden.
    try {
      for (const part of partList) part.validate?.()
    } catch (error) {
      failedSave(error)
      return
    }
    const problem = firstProblem(e.currentTarget as HTMLFormElement)
    if (problem) return showField(problem)
    // A problem with no control on screen (its field is switched off): at least open its section.
    if (problemCount) return onSection(SETTINGS_SECTIONS.find((sec) => problemRoots.has(sec.key))?.key ?? section)
    setSaving(true)
    setSaveError(null)
    const jobs = [...(changed.length ? [saveCore()] : []), ...partList.map((p) => p.save())]
    const failed = (await Promise.allSettled(jobs)).filter((r): r is PromiseRejectedResult => r.status === "rejected")
    setSaving(false)
    if (failed.length) failedSave(failed[0]!.reason)
    else setSavedAt(Date.now())
  }

  return (
    <Modal
      size="xl"
      title="Settings"
      description="Changes apply from the next turn. Values shown are the ones in effect."
      dirty={dirty}
      onClose={() => void close()}
      onSubmit={submit}
      className="settings-dialog @container/settings sm:h-[min(88dvh,56rem)]"
      bodyClassName="settings-body @container flex min-h-0 flex-1 flex-col"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={reset.isPending}
            onClick={() => {
              void confirmDialog({
                title: "Reset settings to defaults?",
                body: "Forget every value saved here? Env vars and defaults apply again.",
                confirmLabel: "Reset",
                danger: true,
              }).then((ok) => ok && reset.mutate(undefined, {
                    onSuccess: () => {
                      setDraft(null)
                      setPinned([])
                      setResets([])
                    },
                  }))
            }}
            title="Forget saved values: env vars and defaults apply again"
          >
            Reset to defaults
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row sm:items-center sm:gap-3">
            {saveError ? (
              <span className="text-xs text-red-300 wrap-anywhere" role="alert">
                Couldn't save: {saveError}
              </span>
            ) : problemCount && dirty ? (
              <span className="text-xs text-red-300" role="status" data-testid="settings-problems">
                {problemCount === 1 ? "Fix 1 field to save" : `Fix ${problemCount} fields to save`}
              </span>
            ) : dirty ? (
              <span className="text-xs text-amber-300" role="status" data-testid="unsaved-count">
                {changeCount === 1 ? "1 unsaved change" : `${changeCount} unsaved changes`}
              </span>
            ) : savedAt ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-400" role="status">
                <Check className="h-3.5 w-3.5" /> Saved
              </span>
            ) : null}
            {dirty && (
              <Button type="button" variant="ghost" onClick={discard}>
                Discard
              </Button>
            )}
            {!dirty && (
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
            {/* Save checks every field itself: the browser's check can't reach a hidden section and refuses numbers between steps. */}
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty} formNoValidate>
              Save
            </Button>
          </div>
        </>
      }
    >
      <SettingsSearchProvider value={searchRegistry}>
      <div className="shrink-0 border-b border-zinc-900 p-3">
        <div data-control-boundary className="flex min-h-11 items-center gap-2 rounded-lg border border-control bg-zinc-900 px-3 focus-within:border-yard-500 focus-within:ring-2 focus-within:ring-yard-500/20">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={searchRef} type="search" aria-label="Search settings" placeholder="Search settings…" value={query}
            className="min-h-11 min-w-0 flex-1 bg-transparent text-base text-zinc-100 outline-none [&::-webkit-search-cancel-button]:appearance-none"
            onChange={(e) => {
              setQuery(e.target.value)
              if (e.target.value.trim()) setVisited(SETTINGS_SECTIONS.map((s) => s.key))
            }}
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault() }}
          />
          {query && <button type="button" aria-label="Clear settings search" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 focus-visible:ring-2 focus-visible:ring-yard-400" onClick={() => { setQuery(""); searchRef.current?.focus() }}><X className="h-4 w-4" /></button>}
        </div>
        {searching && <p role="status" className="mt-2 text-xs text-zinc-400">{matches.length} matching {matches.length === 1 ? "field" : "fields"} in {searchCategories.size} {searchCategories.size === 1 ? "category" : "categories"}</p>}
      </div>
      <SettingsTabs
        tabs={TOP_TABS}
        selected={rootSection}
        onSelect={onSection}
        mark={(key) => (problemRoots.has(key) ? "problem" : rootDirty(key) ? "unsaved" : null)}
        label="Settings categories"
        selectLabel="Settings category"
        idPrefix={ids}
        navHidden={searching}
        className={searching ? "settings-searching" : undefined}
        panelRef={panelRef}
        panelRole={searching ? "region" : "tabpanel"}
        panelLabel={searching ? "Settings search results" : SETTINGS_SECTIONS.find((s) => s.key === section)!.label}
      >
        {!searching && rootSection !== section && <button type="button" data-settings-back onClick={() => onSection(rootSection)} className="mb-4 flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-yard-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yard-400"><ArrowLeft aria-hidden="true" className="h-4 w-4" />Box providers</button>}
        {searching && matches.length === 0 && <div className="py-10 text-center"><p className="text-sm text-zinc-200">No settings found</p><p className="mt-2 text-xs text-zinc-500">Try a different word, like model, signing or voice.</p></div>}
        <SettingsDraftContext.Provider value={registry}>
          {SETTINGS_SECTIONS.filter((sec) => visited.includes(sec.key)).map(({ key: category }) => (
            <div key={category} hidden={!searching && category !== section} data-settings-section={category}>
              {category === "notifications" ? (
                <NotificationsPanel fid={fid} />
              ) : category === "voice" ? (
                <VoicePanel fid={fid} />
              ) : category === "runners" ? (
                <RunnerSettings fid={fid} onSection={onSection} dirtySections={dirtySections} active={!searching && rootSection === "runners"} settings={s ? { s, set, hint } : null} />
              ) : category === "local" ? (
                <LocalRunnerPanel fid={fid} />
              ) : category === "upstash" ? (
                <UpstashPanel fid={fid}>
                  {s ? (
                    <UpstashBoxRows s={s} set={set} hint={hint} field={field} fid={fid} sources={current?.sources} changed={changed} current={current?.settings} pin={pin} resetKeys={resetKeys} resets={resets} />
                  ) : (
                    <Loading label="Loading box sizes" />
                  )}
                </UpstashPanel>
              ) : category === "credentials" ? (
                <CredentialsPanel fid={fid} />
              ) : category === "identities" ? (
                <IdentitiesPanel fid={fid} />
              ) : category === "connectors" ? (
                <ConnectorsPanel fid={fid} />
              ) : category === "runpod" ? (
                <RunPodPanel fid={fid} active={section === "runpod"} gpuDefault={s?.gpuProvider} />
              ) : category === "vast" ? (
                <VastPanel fid={fid} active={section === "vast"} gpuDefault={s?.gpuProvider} />
              ) : category === "daytona" ? (
                <DaytonaPanel fid={fid} active={section === "daytona"} gpuDefault={s?.gpuProvider} />
              ) : category === "docker" ? (
                <DockerPanel fid={fid} active={section === "docker"} />
              ) : category === "machines" ? (
                <MachinesPanel fid={fid} />
              ) : category === "hooks" ? (
                <Panel section="hooks">
                  <HooksPanel projectId={null} intro={false} />
                </Panel>
              ) : category === "projects" ? (
                <Panel section="projects"><SettingsField label="Project" keywords="configure repository project settings"><ProjectSettingsPicker /></SettingsField></Panel>
              ) : category === "appearance" ? (
                <AppearancePanel />
              ) : category === "about" ? (
                <AboutPanel />
              ) : !s ? (
                <Panel section={category}><Loading label="Loading settings" /></Panel>
              ) : category === "orchestrator" ? (
                <Panel section="orchestrator">
                  <Row
                    id={fid("ocli")}
                    label="Agent"
                    help="The coding agent the Coordinator chat runs on; Codex needs a Codex login in Settings › Credentials."
                    hint={hint("orchestratorCli")}
                  >
                    <AgentCliSelect id={fid("ocli")} clis={MANAGER_CLIS} value={s.orchestratorCli} onChange={(v) => set("orchestratorCli", v)} testId="orchestrator-cli" />
                  </Row>
                  {s.orchestratorCli === "codex" ? (
                    <Row
                      id={fid("ocm")}
                      label="Codex model"
                      help="The OpenAI model the Coordinator runs on; leave it empty for Codex's own default."
                      hint={hint("orchestratorCodexModel")}
                    >
                      <CodexModelSelect id={fid("ocm")} value={s.orchestratorCodexModel} onChange={(v) => set("orchestratorCodexModel", v)} testId="orchestrator-codex-model" />
                    </Row>
                  ) : (
                    <Row
                      id={fid("om")}
                      label="Model"
                      help="The Claude model the Coordinator chat runs on, and its quick questions unless Quick questions below picks one. Pick a model or alias, or enter a custom model ID."
                      hint={hint("orchestratorModel")}
                    >
                      <ModelPicker id={fid("om")} value={s.orchestratorModel} onChange={(v) => set("orchestratorModel", v)} testId="orchestrator-model" customInputProps={field("orchestratorModel")} />
                    </Row>
                  )}
                  <Row id={fid("oe")} label="Effort" help="How hard it thinks before answering. Higher is slower and costs more." hint={hint("orchestratorEffort")}>
                    <EffortPicker
                      id={fid("oe")}
                      cli={s.orchestratorCli}
                      model={s.orchestratorCli === "codex" ? s.orchestratorCodexModel : s.orchestratorModel}
                      value={s.orchestratorEffort}
                      onChange={(v) => set("orchestratorEffort", v as Settings["orchestratorEffort"])}
                      testId="orchestrator-effort"
                    />
                  </Row>
                  <Row
                    id={fid("oac")}
                    label="Auto-compact"
                    help={`Compacts the Coordinator and every Captain between turns once context usage passes this. A summary is saved to the compaction log first and shown again after the compaction. Default: ${DEFAULT_AUTOCOMPACT_TOKENS / 1000}k tokens; every turn re-sends the whole context, so a lower threshold makes turns cheaper. Off: only the CLI's own last-resort compaction near the window limit.`}
                    hint={hint("orchestratorAutoCompact")}
                  >
                    <AutoCompactControl
                      id={fid("oac")}
                      label="Coordinator auto-compact"
                      value={s.orchestratorAutoCompact}
                      onChange={(v) => set("orchestratorAutoCompact", v)}
                      tokens={DEFAULT_AUTOCOMPACT_TOKENS}
                      field={field("orchestratorAutoCompact")}
                    />
                  </Row>
                  {/* Relay turns switch to a lighter Claude model; a Coordinator on Codex keeps its one model. */}
                  {s.orchestratorCli !== "codex" && (
                    <Row
                      id={fid("orl")}
                      label="Relay turns"
                      help="Runs the Coordinator's relay-only turns (woken by task updates and Captain replies, with no message from you) on this model and effort. Off by default: another model or effort can't reuse the last turn's prompt cache, so each relay turn sends the whole context again. That's quick and cheap on a small model, slow and costly on a big one. Your own messages always use the model above."
                      hint={hint("orchestratorRelay", ["orchestratorRelay.model"])}
                    >
                      <div className="space-y-2">
                        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
                          <input
                            id={fid("orl")}
                            type="checkbox"
                            checked={s.orchestratorRelay.enabled}
                            onChange={(e) => set("orchestratorRelay", { ...s.orchestratorRelay, enabled: e.target.checked })}
                            data-testid="orchestrator-relay"
                          />
                          {s.orchestratorRelay.enabled ? "On: relay turns use this" : "Off: every turn uses the model above"}
                        </label>
                        <ModelPicker
                          value={s.orchestratorRelay.model}
                          onChange={(v) => set("orchestratorRelay", { ...s.orchestratorRelay, model: v })}
                          disabled={!s.orchestratorRelay.enabled}
                          ariaLabel="Relay turn model"
                          testId="orchestrator-relay-model"
                          customInputProps={field("orchestratorRelay.model")}
                        />
                        <EffortPicker
                          value={s.orchestratorRelay.effort}
                          onChange={(v) => set("orchestratorRelay", { ...s.orchestratorRelay, effort: v as Settings["orchestratorEffort"] })}
                          model={s.orchestratorRelay.model}
                          disabled={!s.orchestratorRelay.enabled}
                          ariaLabel="Relay turn effort"
                          testId="orchestrator-relay-effort"
                        />
                      </div>
                    </Row>
                  )}
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Project Captains</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    Each project's Captain wakes on its task events, so it runs far more often than the Coordinator. Set its agent, model and effort separately to tune that cost.
                    Captains share the auto-compact threshold above. The icon below is every Captain's look; a project can pick its own in its settings.
                  </p>
                  <Row
                    id={fid("ccli")}
                    label="Captain agent"
                    help="The coding agent every project's Captain runs on; Codex needs a Codex login in Settings › Credentials."
                    hint={hint("captainCli")}
                  >
                    <AgentCliSelect id={fid("ccli")} clis={MANAGER_CLIS} value={s.captainCli} onChange={(v) => set("captainCli", v)} testId="captain-cli" />
                  </Row>
                  {s.captainCli === "codex" ? (
                    <Row
                      id={fid("ccm")}
                      label="Captain Codex model"
                      help="The OpenAI model every Captain runs on; leave it empty for Codex's own default."
                      hint={hint("captainCodexModel")}
                    >
                      <CodexModelSelect id={fid("ccm")} value={s.captainCodexModel} onChange={(v) => set("captainCodexModel", v)} testId="captain-codex-model" />
                    </Row>
                  ) : (
                    <Row
                      id={fid("cm")}
                      label="Captain model"
                      help="The Claude model every project Captain runs on, and its quick questions unless Quick questions below picks one. Pick a model or alias, or enter a custom model ID."
                      hint={hint("captainModel")}
                    >
                      <ModelPicker id={fid("cm")} value={s.captainModel} onChange={(v) => set("captainModel", v)} testId="captain-model" customInputProps={field("captainModel")} />
                    </Row>
                  )}
                  <Row id={fid("ce")} label="Captain effort" help="How hard Captains think before answering. Lower is faster and cheaper." hint={hint("captainEffort")}>
                    <EffortPicker
                      id={fid("ce")}
                      cli={s.captainCli}
                      model={s.captainCli === "codex" ? s.captainCodexModel : s.captainModel}
                      value={s.captainEffort}
                      onChange={(v) => set("captainEffort", v as Settings["captainEffort"])}
                      testId="captain-effort"
                    />
                  </Row>
                  <Row
                    id={fid("cicon")}
                    label="Captain icon"
                    help="What every project's Captain shows in the sidebar, its chat and its messages, in its project's colour. A project's settings can pick its own; one with an uploaded image and no pick shows the image."
                    hint={hint("captainIcon")}
                  >
                    <CaptainIconPicker id={fid("cicon")} value={s.captainIcon} onChange={(v) => v && set("captainIcon", v)} testId="captain-icon" />
                  </Row>
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Quick questions</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    A task's side questions, and Reply and Ask on the Coordinator's and Captains' messages. Each one answers read-only beside its chat, which never sees it. By
                    default they run on their chat's model and effort; a small model like Haiku answers sooner and costs less.
                  </p>
                  <Row
                    id={fid("qqm")}
                    label="Quick question model"
                    help="The Claude model quick questions run on. Same as its chat: the Coordinator's model in its chat and for a task's side questions, the Captain model in a Captain's chat. Another model can't reuse the chat's prompt cache, so a thread's first answer reads the chat's whole context again, which is cheap on Haiku. A chat on Codex keeps its own model."
                    hint={hint("quickQuestionModel")}
                  >
                    <ModelPicker
                      id={fid("qqm")}
                      value={s.quickQuestionModel}
                      onChange={(v) => set("quickQuestionModel", v)}
                      defaultLabel={s.orchestratorModel === s.captainModel ? `Same as its chat (${s.orchestratorModel})` : "Same as its chat"}
                      testId="quick-question-model"
                      customInputProps={field("quickQuestionModel")}
                    />
                  </Row>
                  <Row
                    id={fid("qqe")}
                    label="Quick question effort"
                    help="How hard quick questions think before answering. Same as its chat: the Coordinator's or Captain effort above."
                    hint={hint("quickQuestionEffort")}
                  >
                    <EffortPicker
                      id={fid("qqe")}
                      value={s.quickQuestionEffort}
                      onChange={(v) => set("quickQuestionEffort", v as Settings["quickQuestionEffort"])}
                      model={s.quickQuestionModel}
                      effective={s.quickQuestionEffort || s.orchestratorEffort}
                      lead={<option value="">Same as its chat{s.orchestratorEffort === s.captainEffort ? ` (${EFFORT_LABEL[s.orchestratorEffort]})` : ""}</option>}
                      testId="quick-question-effort"
                    />
                  </Row>
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Project notes</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    Every agent in a project starts with its notes. Agents only suggest notes; each project's Captain curates them into a small set of lasting rules, and you can edit
                    them on the project's Notes tab.
                  </p>
                  <Row
                    id={fid("nre")}
                    label="Notes retro"
                    help="When a task's PR merges, or a task without a PR ends done, its project's Captain decides on each note suggestion the agent left: it accepts, merges or rejects it, with a one-line reason. Nobody needs to approve them; the Notes tab shows what was decided."
                    hint={hint("notesRetroEnabled")}
                  >
                    <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
                      <input id={fid("nre")} type="checkbox" checked={s.notesRetroEnabled} onChange={(e) => set("notesRetroEnabled", e.target.checked)} data-testid="notes-retro" />
                      {s.notesRetroEnabled ? "On: Captains curate suggestions" : "Off: suggestions stay pending until it's on again"}
                    </label>
                  </Row>
                  <Row
                    id={fid("nmc")}
                    label="Max notes"
                    help="Most notes an agent's first prompt gets; Captains keep their project under it. Over it, agents get the newest notes that fit, their prompt says how many were left out, and the Captain is asked to prune. A project can set its own on its Settings tab."
                    hint={hint("notesMaxCount")}
                  >
                    <input
                      id={fid("nmc")}
                      type="number"
                      min={NOTE_BUDGET_LIMITS.maxNotes.min}
                      max={NOTE_BUDGET_LIMITS.maxNotes.max}
                      className={inputClass}
                      value={numberText(s.notesMaxCount)}
                      onChange={(e) => set("notesMaxCount", typedNumber(e.target.value, true))}
                      {...field("notesMaxCount")}
                    />
                  </Row>
                  <Row id={fid("nmt")} label="Max note tokens" help="About how many tokens all the notes may take in that prompt, next to Max notes (4 characters is about 1 token)." hint={hint("notesMaxTokens")}>
                    <input
                      id={fid("nmt")}
                      type="number"
                      min={NOTE_BUDGET_LIMITS.maxTokens.min}
                      max={NOTE_BUDGET_LIMITS.maxTokens.max}
                      step={100}
                      className={inputClass}
                      value={numberText(s.notesMaxTokens)}
                      onChange={(e) => set("notesMaxTokens", typedNumber(e.target.value, true))}
                      {...field("notesMaxTokens")}
                    />
                  </Row>
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">When a task's PR merges</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    Box Yard checks open PRs with GitHub about once a minute, with each project's own token. A project can turn either of these off (or on) in its settings, and a task can stay open from its details (ⓘ). Hooks on "PR merged" still run too, right after.
                  </p>
                  <Row
                    id={fid("adm")}
                    label="Done when its PR merges"
                    help="When a task's pull request merges and its turn is over (it's idle or waiting for review), it moves to done and its workspace is archived, as Mark done does. It stays as it is while messages are queued for it, while it has another PR open, or when it's set to stay open. Turning it on also moves resting tasks whose PR has already merged. Off: a merged PR leaves its task idle until you mark it done. Messaging a done task picks it back up."
                    hint={hint("autoDoneOnMerge")}
                  >
                    <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
                      <input id={fid("adm")} type="checkbox" checked={s.autoDoneOnMerge ?? true} onChange={(e) => set("autoDoneOnMerge", e.target.checked)} data-testid="auto-done-on-merge" />
                      {(s.autoDoneOnMerge ?? true) ? "On: a merged PR moves its task to done" : "Off: you mark tasks done yourself"}
                    </label>
                  </Row>
                  <Row
                    id={fid("cim")}
                    label="Close the issues it names"
                    help="GitHub closes the issues a PR names with Fixes, Closes or Resolves #N only when it merges into the repo's default branch. For a PR merged into any other branch (an epic branch), Box Yard closes them: open issues of the same repo only, never PRs or other repos' issues, each with a comment linking the PR."
                    hint={hint("closeIssuesOnMerge")}
                  >
                    <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
                      <input id={fid("cim")} type="checkbox" checked={s.closeIssuesOnMerge ?? true} onChange={(e) => set("closeIssuesOnMerge", e.target.checked)} data-testid="close-issues-on-merge" />
                      {(s.closeIssuesOnMerge ?? true) ? "On: closed after a merge into an epic branch, with a comment" : "Off: only GitHub closes them (default branch)"}
                    </label>
                  </Row>
                  <Row
                    id={fid("rul")}
                    label="Resume after usage limits"
                    help="When Claude's 5-hour, weekly or monthly spend limit stops a task, a Captain or the Coordinator, Box Yard shows the work as waiting for the reset, checks the limit without using any model tokens (the same usage numbers Claude Code shows), and resumes the stalled work in its original order once the limit clears. Each item resumes at most 3 times a day. Off: a limit fails the work as before, and you press Retry yourself."
                    hint={hint("resumeAfterUsageLimit")}
                  >
                    <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
                      <input id={fid("rul")} type="checkbox" checked={s.resumeAfterUsageLimit ?? true} onChange={(e) => set("resumeAfterUsageLimit", e.target.checked)} data-testid="resume-after-usage-limit" />
                      {(s.resumeAfterUsageLimit ?? true) ? "On: stalled work resumes by itself when the limit clears" : "Off: you press Retry after a limit"}
                    </label>
                  </Row>
                </Panel>
              ) : category === "agents" ? (
                <Panel section="agents">
                  <Row
                    id={fid("on")}
                    label="Your name"
                    help={'What the Coordinator, Captains and agents call you in their prompts and labels. The default is “the owner” until you save your name.'}
                    hint={hint("ownerName")}
                  >
                    <input id={fid("on")} className={inputClass} value={s.ownerName} maxLength={40} onChange={(e) => set("ownerName", e.target.value)} {...field("ownerName")} />
                  </Row>
                  <Row
                    id={fid("acli")}
                    label="Agent"
                    help="The coding agent new tasks run on: a project can pick its own. Existing tasks keep their saved harness; use Continue with… on a resting task to switch it explicitly. A new task given provider/model runs on OpenCode, one given a gpt-* model runs on Codex, and one given a Cursor-only model (composer-2.5, gemini-…) on Cursor."
                    hint={hint("agentCli")}
                  >
                    <AgentCliSelect id={fid("acli")} clis={AGENT_CLIS} value={s.agentCli} onChange={(v) => set("agentCli", v)} testId="agent-cli" />
                  </Row>
                  {s.agentCli === "opencode" ? (
                    <Row id={fid("aoc")} label="OpenCode model" help="Provider and model for OpenCode tasks. An optional #variant selects provider-specific reasoning. Generic effort and Box Yard compaction thresholds do not apply." hint={hint("agentOpencodeModel")}>
                      <OpenCodeModelInput id={fid("aoc")} value={s.agentOpencodeModel} onChange={(v) => set("agentOpencodeModel", v)} testId="agent-opencode-model" />
                    </Row>
                  ) : s.agentCli === "cursor" ? (
                    <Row
                      id={fid("acu")}
                      label="Cursor model"
                      help="The model tasks on Cursor run on, unless the task or its project's Routing YAML entry picks one Cursor has. Auto lets Cursor pick per request. Cursor's ids carry the effort, so there's no separate Effort here, and Cursor compacts its context on its own."
                      hint={hint("agentCursorModel")}
                    >
                      <CursorModelSelect id={fid("acu")} value={s.agentCursorModel} onChange={(v) => set("agentCursorModel", v)} testId="agent-cursor-model" />
                    </Row>
                  ) : s.agentCli === "codex" ? (
                    <Row id={fid("acm")} label="Codex model" help="The model tasks on Codex run on, unless the task or its project's Routing YAML entry picks one. Options depend on your Codex account and CLI version." hint={hint("agentCodexModel")}>
                      <CodexModelSelect id={fid("acm")} value={s.agentCodexModel} onChange={(v) => set("agentCodexModel", v)} testId="agent-codex-model" />
                    </Row>
                  ) : (
                    <Row id={fid("am")} label="Model" help="The Claude model each task's agent runs on, unless the task or its project's Routing YAML entry picks one. Once saved here or set by an env var, it wins over the YAML's defaults and fallback." hint={hint("agentModel")}>
                      <ModelPicker id={fid("am")} value={s.agentModel} onChange={(v) => set("agentModel", v)} testId="agent-model" customInputProps={field("agentModel")} />
                    </Row>
                  )}
                  {hasSeparateEffort(s.agentCli) && (
                    <Row
                      id={fid("ae")}
                      label="Effort"
                      help={
                        (s.agentCli === "codex" ? s.agentCodexEffort : s.agentEffort) === "orchestrator"
                          ? "The Coordinator picks an effort in create_task and send_to_task: low for one-command chores, high for real coding. Without one, Routing YAML or the harness default applies."
                          : "Every agent turn uses this effort, unless the task or its project's Routing YAML entry picks one. Once saved here or set by an env var, it wins over the YAML's defaults and fallback."
                      }
                      hint={hint(s.agentCli === "codex" ? "agentCodexEffort" : "agentEffort")}
                    >
                      <EffortPicker
                        id={fid("ae")}
                        cli={s.agentCli}
                        model={s.agentCli === "codex" ? s.agentCodexModel : s.agentModel}
                        value={s.agentCli === "codex" ? s.agentCodexEffort : s.agentEffort}
                        onChange={(v) => set(s.agentCli === "codex" ? "agentCodexEffort" : "agentEffort", v as AgentEffort)}
                        lead={<option value="orchestrator">Let the Coordinator decide</option>}
                        testId="agent-effort"
                      />
                    </Row>
                  )}
                  <Row
                    id={fid("arc")}
                    label="Routing YAML"
                    help="Optional rules for task model and effort, also read from routing.yaml in the data directory. Each turn the first match wins: the task's own choice, then its project's entry, then Model and Effort above when saved or set by an env var, then defaults, then fallback, then the harness default (OpenCode: provider/model above, no generic effort; Codex: gpt-6.1-sol at extra high; Claude: claude-opus-5-5 at high; Cursor: its Cursor model above, which only takes ids Cursor lists)."
                    hint={hint("agentRoutingConfig")}
                  >
                    <textarea
                      id={fid("arc")}
                      className={cx(inputClass, "min-h-40 resize-y font-mono text-xs leading-5")}
                      spellCheck={false}
                      value={s.agentRoutingConfig}
                      onChange={(e) => set("agentRoutingConfig", e.target.value)}
                      placeholder={"fallback:\n  model: claude-opus-5-5\n  effort: high\nrules:\n  - name: docs-small-fixes\n    when: docs, typos, small fixes\n    model: claude-haiku-5-5\n    effort: low"}
                    />
                  </Row>
                  <Row
                    id={fid("aac")}
                    label="Custom auto-compact threshold"
                    help="Passed to each agent's CLI as its auto-compact window (100k–1M tokens). Off: the CLI's own default."
                    hint={hint("agentAutoCompact")}
                  >
                    <AutoCompactControl id={fid("aac")} label="Agent auto-compact" value={s.agentAutoCompact} onChange={(v) => set("agentAutoCompact", v)} field={field("agentAutoCompact")} />
                  </Row>
                  <Row
                    id={fid("smd")}
                    label="Sub-task depth"
                    help="How deep sub-tasks may nest. An agent splits its work with spawn_subtasks; each sub-task runs as a task of its own and reports back. 1: a sub-task can't start its own."
                    hint={hint("subtaskMaxDepth")}
                  >
                    <input
                      id={fid("smd")}
                      type="number"
                      min={SUBTASK_MAX_DEPTH.min}
                      max={SUBTASK_MAX_DEPTH.max}
                      className={inputClass}
                      value={numberText(s.subtaskMaxDepth ?? SUBTASK_MAX_DEPTH.default)}
                      onChange={(e) => set("subtaskMaxDepth", typedNumber(e.target.value, true))}
                      {...field("subtaskMaxDepth")}
                    />
                  </Row>
                  <Row id={fid("smc")} label="Sub-tasks per task" help="How many sub-tasks one task may start, over its whole life." hint={hint("subtaskMaxChildren")}>
                    <input
                      id={fid("smc")}
                      type="number"
                      min={SUBTASK_MAX_CHILDREN.min}
                      max={SUBTASK_MAX_CHILDREN.max}
                      className={inputClass}
                      value={numberText(s.subtaskMaxChildren ?? SUBTASK_MAX_CHILDREN.default)}
                      onChange={(e) => set("subtaskMaxChildren", typedNumber(e.target.value, true))}
                      {...field("subtaskMaxChildren")}
                    />
                  </Row>
                </Panel>
              ) : category === "limits" ? (
                <LimitsPanel s={s} set={set} hint={hint} field={field} fid={fid} sources={current?.sources} resets={resets} />
              ) : (
                <CostsPanel s={s} set={set} hint={hint} field={field} fid={fid} />
              )}
            </div>
          ))}
        </SettingsDraftContext.Provider>
      </SettingsTabs>
      </SettingsSearchProvider>
    </Modal>
  )
}

// ------------------------------------------------------------------ panels

function LimitsPanel({
  s,
  set,
  hint,
  field,
  fid,
  sources,
  resets,
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  hint: Hint
  field: FieldCheck
  fid: (k: string) => string
  sources?: Record<keyof Settings, SettingSource>
  resets: (keyof Settings)[]
}) {
  const health = useHealth()
  const server = useSettings()
  // A number field's value and draft. Emptied, it's NaN until a number is typed, so Save asks instead of saving 0.
  const num = (k: NumberKey) => ({
    value: numberText(s[k]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, typedNumber(e.target.value, NUMBER_RULES[k]?.whole)),
    ...field(k),
  })
  const capacity = agentCapacity(s)
  // A pending "Use size default" shows the size defaults already.
  const shownSources = sources && { ...sources, ...Object.fromEntries(resets.map((k) => [k, "default"])) }
  const upstash = health.data?.provider === "upstash"
  return (
    <Panel section="limits">
      {/* Rarely touched: open when one of them isn't the default, so a ceiling set on purpose (or by env) shows. */}
      <details
        className="border-t border-zinc-900 py-4"
        data-testid="limits-advanced"
        open={(["maxBoxes", "boxCreateConcurrency"] as const).some((k) => shownSources?.[k] && shownSources[k] !== "default") || undefined}
      >
        <summary className="cursor-pointer text-sm font-medium text-zinc-300 select-none hover:text-zinc-100">Advanced: box ceiling and how fast boxes are made</summary>
        <div className="mt-4">
          <Row
            id={fid("mb")}
            label="Max boxes (safety ceiling)"
            help="A safety stop, not a budget: the most worker boxes alive at once, however much work waits. What keeps spend in check is the daily cloud limit (Settings › Usage); boxes start when work needs one and are deleted when idle."
            hint={hint("maxBoxes")}
          >
            <input id={fid("mb")} type="number" min={1} max={100} className={inputClass} {...num("maxBoxes")} data-testid="max-boxes" />
          </Row>
          <Row
            id={fid("bcc")}
            label="Boxes created at once"
            help="When many tasks wait for a box (say a Captain starts a batch of tasks), Box Yard creates up to this many boxes in parallel, still within Max boxes. Lower it if your box provider rate-limits box creation; Box Yard also backs off by itself when a create fails or is rate-limited."
            hint={hint("boxCreateConcurrency")}
          >
            <input
              id={fid("bcc")}
              type="number"
              min={BOX_CREATE_CONCURRENCY.min}
              max={BOX_CREATE_CONCURRENCY.max}
              className={inputClass}
              {...num("boxCreateConcurrency")}
              data-testid="box-create-concurrency"
            />
          </Row>
        </div>
      </details>
      <Row id={fid("ma")} label="Max tasks running at once" help="A cap on tasks running at once across all boxes. 0 = boxes × tasks running at once per box." hint={hint("maxAgents")}>
        <input id={fid("ma")} type="number" min={0} max={1000} className={inputClass} {...num("maxAgents")} />
      </Row>
      <Row id={fid("bid")} label="Idle box deletion" help="Delete an idle worker box after this many minutes, but only when every resident workspace has a fresh archive. 0 keeps boxes." hint={hint("boxIdleDeleteMinutes")}>
        <input id={fid("bid")} type="number" min={0} max={43_200} className={inputClass} {...num("boxIdleDeleteMinutes")} />
      </Row>
      <Row
        id={fid("wrd")}
        label="Workspace retention"
        help="After this many idle days, archived resting task folders are removed from boxes and restored from the archive on the next message. 0 keeps folders."
        hint={hint("workspaceRetentionDays")}
      >
        <input id={fid("wrd")} type="number" min={0} max={3650} className={inputClass} {...num("workspaceRetentionDays")} />
      </Row>
      <Row
        id={fid("ard")}
        label="Archive retention"
        help="After this many days, orphan archives and long-done task archives are pruned. Archives of tasks with an open or unmerged PR are always kept. A done task whose archive was pruned restarts from a recap on its next message. 0 keeps archives."
        hint={hint("archiveRetentionDays")}
      >
        <input id={fid("ard")} type="number" min={0} max={3650} className={inputClass} {...num("archiveRetentionDays")} />
      </Row>
      <Row
        id={fid("akt")}
        label="Keep recent archives"
        help="Never prune the archive of a task touched in the last this many days, so recent work resumes with its full session. 0 = only archive retention applies."
        hint={hint("archiveKeepTouchedDays")}
      >
        <input id={fid("akt")} type="number" min={0} max={3650} className={inputClass} {...num("archiveKeepTouchedDays")} />
      </Row>
      <Row
        id={fid("dmf")}
        label="Disk headroom (MB)"
        help="A new workspace only lands on a box with at least this much free disk. A box below it is cleaned up in the background while tasks go to another box."
        hint={hint("diskMinFreeMb")}
      >
        <input id={fid("dmf")} type="number" min={0} max={1_000_000} step={128} className={inputClass} {...num("diskMinFreeMb")} />
      </Row>
      <Row
        id={fid("dcf")}
        label="Clone size factor"
        help="...and at least this many times the repo's last clone size, for big repos (the clone plus the box's shared mirror of it)."
        hint={hint("diskCloneFactor")}
      >
        <input
          id={fid("dcf")}
          type="number"
          min={1}
          max={20}
          step={0.5}
          className={inputClass}
          {...num("diskCloneFactor")}
        />
      </Row>
      <Row
        id={fid("mup")}
        label="Memory limit (% used)"
        help="A new agent skips a box with more than this much of its memory in use while other agents run on it, and goes to another box (or waits). Memory is read from the box's cgroup without the reclaimable page cache. 0 = off."
        hint={hint("memoryMaxUsedPercent")}
      >
        <input id={fid("mup")} type="number" min={0} max={100} step={5} className={inputClass} {...num("memoryMaxUsedPercent")} data-testid="memory-max-used" />
      </Row>
      <Row id={fid("mmf")} label="Memory headroom (MB)" help="...or with less than this much memory free. 0 = off." hint={hint("memoryMinFreeMb")}>
        <input id={fid("mmf")} type="number" min={0} max={1_000_000} step={256} className={inputClass} {...num("memoryMinFreeMb")} />
      </Row>
      <Row
        id={fid("lpc")}
        label="Load limit (per CPU)"
        help="...or with a 1-minute load average above this many times its CPUs (nproc). On Upstash, /proc/loadavg and nproc describe the host the box runs on. 0 = off."
        hint={hint("loadMaxPerCpu")}
      >
        <input
          id={fid("lpc")}
          type="number"
          min={0}
          max={100}
          step={0.5}
          className={inputClass}
          {...num("loadMaxPerCpu")}
        />
      </Row>
      <Row
        id={fid("bci")}
        label="Build output cleanup (idle minutes)"
        help="Once a done task has sat idle this long, its git-ignored build output (node_modules, dist, .cache, tmp, perf captures) is removed from its Upstash box (this computer and SSH machines have their own settings below). A task that isn't done keeps it, and so does a folder a process still uses (a dev server, a shell); only low-disk cleanup frees an idle task's build output, and the task's log says what went. Only folders git ignores and doesn't track; uncommitted work is never touched. 0 = off (low-disk cleanup still runs)."
        hint={hint("buildCleanupIdleMinutes")}
      >
        <input id={fid("bci")} type="number" min={0} max={43_200} className={inputClass} {...num("buildCleanupIdleMinutes")} />
      </Row>
      <Row
        id={fid("dce")}
        label="Dependency cache (npm)"
        help="Each box keeps the node_modules its agents installed, one per package-lock.json, next to the task folders. A task with that lockfile and no node_modules (a fresh clone, or one the build output cleanup emptied) gets it hard-linked in before its turn, in under a second, and its prompt says it needn't run npm ci. The shared files are read-only, so a task can't change another's. A project can override it."
        hint={hint("depCacheEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("dce")} type="checkbox" checked={s.depCacheEnabled} onChange={(e) => set("depCacheEnabled", e.target.checked)} data-testid="dep-cache" />
          {s.depCacheEnabled ? "On: node_modules restored from the box cache" : "Off: agents install dependencies"}
        </label>
      </Row>
      <Row
        id={fid("dcm")}
        label="Dependency cache size (MB)"
        help="Most work-disk space one box's cache may hold. Over it, the least recently used lockfiles no task links go first. Low-disk cleanup also removes entries no task links."
        hint={hint("depCacheMaxMb")}
      >
        <input id={fid("dcm")} type="number" min={100} max={1_000_000} step={256} className={inputClass} disabled={!s.depCacheEnabled} {...num("depCacheMaxMb")} data-testid="dep-cache-max" />
      </Row>
      <Row
        id={fid("gpc")}
        label="Partial clone mirrors"
        help="Each box keeps one mirror per repo, and task checkouts borrow its objects instead of copying them. With this on, mirrors skip old file versions (git clone --filter=blob:none); git fetches one from GitHub when log -p, blame or a checkout needs it. A project can override it."
        hint={hint("gitPartialClone")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("gpc")} type="checkbox" checked={s.gitPartialClone} onChange={(e) => set("gitPartialClone", e.target.checked)} data-testid="git-partial-clone" />
          {s.gitPartialClone ? "On: blob:none mirrors" : "Off: full mirrors"}
        </label>
      </Row>
      <Row
        id={fid("gpt")}
        label="Push at turn end"
        help="After every agent turn in a repo project, Box Yard pushes the task's branch and saves uncommitted work (untracked files too) to a hidden ref on origin, refs/boxyard/wip/<task>, without committing in the task's repo. Archives then carry only what git can't, so a box can go at any time without losing code. Without write access it quietly keeps full archives. A project can override it."
        hint={hint("gitPushAtTurnEnd")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("gpt")} type="checkbox" checked={s.gitPushAtTurnEnd} onChange={(e) => set("gitPushAtTurnEnd", e.target.checked)} data-testid="git-push-at-turn-end" />
          {s.gitPushAtTurnEnd ? "On: branch and WIP pushed, small archives" : "Off: full archives"}
        </label>
      </Row>
      <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100" data-testid="limits-own-computers">
        This computer and SSH machines
      </h4>
      <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
        Task folders on your own computers aren't boxes, so the box cleanup above doesn't reach them. These settings do. They never touch a running, queued or starting task,
        one waiting for an answer, a folder a process still uses (a dev server, an editor, a shell), or one with anything uncommitted, stashed or unpushed. Only done tasks'
        folders leave, archived first, and come back on their next message. Whatever goes is written to the task's log.
      </p>
      <Row
        id={fid("la")}
        label="Tasks running at once on this computer"
        help={`Tasks of projects that run on this computer (project settings › Runs on) that may run at once here, every project's together; a project's own Tasks running at once limits only its own tasks within this. They have their own queue: they never take a box slot or count toward Max tasks running at once. Each task works in its own folder in ${server.data?.localDir ?? "~/boxyard-workspaces"} (BOXYARD_LOCAL_DIR). ${LOCAL_UNSANDBOXED}`}
        hint={hint("localAgents")}
      >
        <input
          id={fid("la")}
          type="number"
          min={LOCAL_AGENTS_LIMITS.min}
          max={LOCAL_AGENTS_LIMITS.max}
          className={inputClass}
          {...num("localAgents")}
          data-testid="local-agents"
        />
      </Row>
      <Row
        id={fid("lfk")}
        label="Task folders kept on this computer"
        help={`Most task folders in ${server.data?.localDir ?? "~/boxyard-workspaces"}, and on each SSH machine. Past it, the oldest done tasks' folders are archived and removed, but only when all their work is pushed. A task that isn't done keeps its folder. 0 = no limit.`}
        hint={hint("localFoldersKept")}
      >
        <input id={fid("lfk")} type="number" min={0} max={1000} className={inputClass} {...num("localFoldersKept")} data-testid="local-folders-kept" />
      </Row>
      <Row
        id={fid("lbc")}
        label="Free a finished task's build output"
        help="Once a task is done and all its work is pushed, remove the dependency and build output git ignores (node_modules, dist, build, .next, caches) from its folder within a couple of minutes. A task that isn't done keeps it (only low-disk cleanup frees it), and so does a folder a process still uses. Scratch folders and captures (tmp, shots, perf, reports) stay. The task's log and the agent's next prompt say what went, so it reinstalls first."
        hint={hint("localBuildCleanup")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("lbc")} type="checkbox" checked={s.localBuildCleanup} onChange={(e) => set("localBuildCleanup", e.target.checked)} data-testid="local-build-cleanup" />
          {s.localBuildCleanup ? "On: freed once the work is pushed" : "Off: only low-disk cleanup frees it"}
        </label>
      </Row>
      <Row
        id={fid("ldf")}
        label="Low-disk cleanup (GB free)"
        help="When the disk holding the task folders has less free space than this, Box Yard frees build output (an idle task's too, unless a process still uses its folder) and then removes the oldest done tasks' folders, until there's this much free again. Each task's log says what went. It checks every couple of minutes. 0 = off."
        hint={hint("localDiskMinFreeGb")}
      >
        <input id={fid("ldf")} type="number" min={0} max={100_000} step={5} className={inputClass} {...num("localDiskMinFreeGb")} data-testid="local-disk-min-free" />
      </Row>
      <div className="mt-2 space-y-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-400">
        <p>
          With these limits, up to <span className="font-medium text-zinc-100 tabular-nums">{capacity}</span> {capacity === 1 ? "task runs" : "tasks run"} at once on up to{" "}
          <span className="font-medium text-zinc-100 tabular-nums">{s.maxBoxes}</span> {s.maxBoxes === 1 ? "box" : "boxes"}.
        </p>
        <p>Saved changes apply right away. Lowering a limit never stops running boxes or tasks: no new work is placed until usage drops.</p>
        {upstash && (
          <p className={cx(s.maxBoxes > UPSTASH_FREE_CONCURRENT_BOXES && "text-amber-300")}>
            Free plan: up to {UPSTASH_FREE_CONCURRENT_BOXES} concurrent boxes (
            <NewTabLink className="text-sky-400 hover:underline" href="https://upstash.com/pricing/box">
              Upstash Box pricing
            </NewTabLink>
            ).
          </p>
        )}
      </div>
    </Panel>
  )
}

/** Settings › Box providers › Upstash boxes: the size new boxes get, resizing, and what each box runs and keeps. */
function UpstashBoxRows({
  s,
  set,
  hint,
  field,
  fid,
  sources,
  changed,
  current,
  pin,
  resetKeys,
  resets,
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  hint: Hint
  field: FieldCheck
  fid: (k: string) => string
  sources?: Record<keyof Settings, SettingSource>
  changed: (keyof Settings)[]
  current?: Settings
  pin: (k: keyof Settings, on: boolean) => void
  resetKeys: (keys: (keyof Settings)[]) => void
  resets: (keyof Settings)[]
}) {
  const limitField = (k: BoxLimitKey) => ({
    k,
    value: s[k],
    current: current?.[k],
    source: sources?.[k],
    changed: changed.includes(k),
    onValue: (v: number) => set(k, v),
    pin: (on: boolean) => pin(k, on),
    onReset: () => resetKeys([k]),
    pendingReset: resets.includes(k),
    field: field(k),
  })
  // A pending "Use size default" shows the size defaults already.
  const shownSources = sources && { ...sources, ...Object.fromEntries(resets.map((k) => [k, "default"])) }
  const overrides = changed.filter((k) => !resets.includes(k))
  return (
    <>
      <Row
        id={fid("ws")}
        wide
        label="Worker size"
        help="Upstash Box size for newly created boxes, unless a project sets its own preferred size or auto-sizing (below) picked one from its runs. Existing boxes keep their size until resized from the Boxes page."
        hint={hint("workerSize")}
      >
        <UpstashSizes value={s.workerSize} onPick={(size) => set("workerSize", size)} />
      </Row>
      <Row
        id={fid("are")}
        label="Size and resize boxes automatically"
        help="Box Yard sizes each project's new boxes from what its runs used (from 3 runs: the smallest with RAM for 1.25 × the peak of the last 14 days, bigger for disk or busy CPU), unless the project sets its own Box size, and a turn that runs out of memory carries on once on a bigger box. The Coordinator, and Captains for boxes their project uses, may also resize a box with resize_box: up when it keeps running low on disk, down when it sits mostly empty. They never stop running tasks for it, and every resize they make sends you a notice with their reason."
        hint={hint("autoResizeEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("are")} type="checkbox" checked={s.autoResizeEnabled} onChange={(e) => set("autoResizeEnabled", e.target.checked)} data-testid="auto-resize" />
          {s.autoResizeEnabled ? "Allowed" : "Off: new boxes are Worker size, and only you resize boxes"}
        </label>
      </Row>
      <Row id={fid("arm")} label="Max size it may choose" help="resize_box refuses anything bigger. You can still pick any size yourself on the Boxes page." hint={hint("autoResizeMaxSize")}>
        <Select
          id={fid("arm")}
          className="w-full disabled:opacity-50"
          value={s.autoResizeMaxSize}
          disabled={!s.autoResizeEnabled}
          onChange={(e) => set("autoResizeMaxSize", e.target.value as BoxSize)}
          data-testid="auto-resize-max"
        >
          {BOX_SIZES.map((size) => (
            <option key={size} value={size}>
              {BOX_SIZE_SPECS[size].label} · {BOX_SIZE_SPECS[size].cpu} vCPU · {BOX_SIZE_SPECS[size].ramGb} GB RAM
            </option>
          ))}
        </Select>
      </Row>
      <Row
        id={fid("pre")}
        label="Resize an idle box when no big-enough box is free"
        help="For projects with a box size: when the pool is at Max boxes and no box of that size has room, Box Yard may grow an idle smaller box (no agent running on it) to that size and run the task there. Larger boxes cost more. Off, the task waits for a box of its size; it never runs on a smaller one."
        hint={hint("placementResizeEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input
            id={fid("pre")}
            type="checkbox"
            checked={s.placementResizeEnabled}
            onChange={(e) => set("placementResizeEnabled", e.target.checked)}
            data-testid="placement-resize"
          />
          {s.placementResizeEnabled ? "On: an idle box may be resized" : "Off: the task waits"}
        </label>
      </Row>
      <SizeCapacityTable s={s} sources={shownSources} changed={overrides} />
      <Row
        id={fid("spb")}
        label="Tasks running at once per box"
        help={`Tasks that may run at the same time inside one box, every project's together (each task runs its own Claude Code agent). A project's own Tasks running at once (project settings) limits only its own tasks within this. Unless set here, each box uses its own size's default: ${WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z].slotsPerBox}`).join(", ")}.`}
        hint={hint("slotsPerBox")}
      >
        <BoxLimitInput id={fid("spb")} max={20} {...limitField("slotsPerBox")} />
      </Row>
      <Row
        id={fid("mr")}
        label="Task folders kept per box"
        help={`Task folders kept on one box (running or not) before older archived workspaces are parked. Unless set here, each box uses its own size's default: ${WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z].maxResidentPerBox}`).join(", ")}.`}
        hint={hint("maxResidentPerBox")}
      >
        <BoxLimitInput id={fid("mr")} max={200} {...limitField("maxResidentPerBox")} />
      </Row>
    </>
  )
}

/** Tasks running at once and task folders kept per box for each worker size, so a small box's lower capacity is visible. */
type BoxLimitKey = "slotsPerBox" | "maxResidentPerBox"

/**
 * Tasks running at once or task folders kept per box. While each box follows its own size, the field shows every size's default
 * instead of one number; typing a number overrides it for every box. A value saved here gets a "Use size default"
 * button, and one set by env says how to remove it.
 */
export function BoxLimitInput({
  id,
  k,
  max,
  value,
  current,
  source,
  changed,
  onValue,
  pin,
  onReset,
  pendingReset = false,
  field,
}: {
  id: string
  k: BoxLimitKey
  max: number
  value: number
  current?: number
  source?: SettingSource
  changed: boolean
  onValue: (v: number) => void
  pin: (on: boolean) => void
  onReset: () => void
  /** "Use size default" was pressed; Save forgets the saved value. */
  pendingReset?: boolean
  field?: FieldProps
}) {
  // What's typed while focused, so the field can be empty mid-edit without the number snapping back.
  const [text, setText] = useState<string | null>(null)
  const atDefault = pendingReset || (source === "default" && !changed)
  const sizes = boxLimitDefaults(k)
  const env = SETTING_ENV[k]
  const shown = text ?? (atDefault ? "" : String(value))
  return (
    <>
      <input
        id={id}
        type="number"
        min={1}
        max={max}
        className={cx(inputClass, atDefault && "placeholder:text-zinc-300!")}
        value={shown}
        placeholder={atDefault ? sizes : undefined}
        aria-description={atDefault ? `Each box uses its size's default: ${sizes}` : undefined}
        data-testid={`limit-${k}`}
        {...field}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          // Out of range still goes to the draft, so the field says what fits and Save waits for it.
          if (t === "") return
          onValue(Number(t))
          if (source === "default") pin(true)
        }}
        onBlur={() => {
          // An emptied field drops the edit: back to the saved value, or to the size defaults.
          if (text === "" && current !== undefined) {
            onValue(current)
            pin(false)
          }
          setText(null)
        }}
      />
      {source === "ui" && !changed && (
        <Button type="button" variant="subtle" size="sm" className="w-full sm:w-auto" onClick={onReset} data-testid={`use-size-default-${k}`}>
          Use size default
        </Button>
      )}
      {source === "env" && !changed && env && (
        <p className="text-xs leading-relaxed text-zinc-500" data-testid={`env-note-${k}`}>
          To use each box's size default ({sizes}), remove <code className="font-mono text-zinc-400">{env}</code> from .env (and from the shell or deploy env) and
          restart Box Yard.
        </p>
      )}
    </>
  )
}

/** "small 1 · medium 2 · large 4" */
export function boxLimitDefaults(k: BoxLimitKey) {
  return WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z][k]}`).join(" · ")
}

function SizeCapacityTable({ s, sources, changed }: { s: Settings; sources?: Record<keyof Settings, SettingSource>; changed: (keyof Settings)[] }) {
  const rows = sizeCapacities(s, sources, { slotsPerBox: changed.includes("slotsPerBox"), maxResidentPerBox: changed.includes("maxResidentPerBox") })
  const overridden = rows[0]!.slotsOverridden || rows[0]!.residentOverridden
  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-zinc-900 text-xs" data-testid="size-capacity">
      <table className="w-full text-left tabular-nums">
        <thead className="bg-zinc-900/60 text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Worker size</th>
            <th className="px-3 py-2 font-medium">Tasks running at once per box</th>
            <th className="px-3 py-2 font-medium">Task folders kept per box</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.size} className={cx("border-t border-zinc-900", r.current ? "bg-yard-500/10 text-zinc-100" : "text-zinc-400")}>
              <td className="px-3 py-2 capitalize">
                {r.size}
                {r.current && <span className="ml-2 rounded bg-yard-500/20 px-1.5 py-px text-[10px] text-yard-300 normal-case">in use</span>}
              </td>
              <td className="px-3 py-2">
                {r.slotsPerBox}
                {r.slotsOverridden && r.slotsPerBox !== r.defaults.slotsPerBox && <span className="ml-1 text-zinc-600">(size default {r.defaults.slotsPerBox})</span>}
              </td>
              <td className="px-3 py-2">
                {r.maxResidentPerBox}
                {r.residentOverridden && r.maxResidentPerBox !== r.defaults.maxResidentPerBox && (
                  <span className="ml-1 text-zinc-600">(size default {r.defaults.maxResidentPerBox})</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-zinc-900 px-3 py-2 leading-relaxed text-zinc-500">
        {overridden
          ? "Your saved or env values below replace the size defaults for every size."
          : `Each box uses its own size's values: a small box runs ${SIZE_DEFAULTS.small.slotsPerBox} task at a time and keeps ${SIZE_DEFAULTS.small.maxResidentPerBox} task folders, a medium one ${SIZE_DEFAULTS.medium.slotsPerBox} and ${SIZE_DEFAULTS.medium.maxResidentPerBox}. Set the fields below to override them for every box.`}{" "}
        Before size-based defaults, every box ran {LEGACY_POOL_DEFAULTS.slotsPerBox} tasks at once and kept {LEGACY_POOL_DEFAULTS.maxResidentPerBox} folders.
      </p>
    </div>
  )
}

/** Settings › Usage's way into the Usage modal, which used to be the spend report here. */
function OpenUsage() {
  const openUsage = useOpenUsage()
  return (
    <Button type="button" onClick={() => openUsage()} data-testid="open-usage">
      <BarChart3 className="h-4 w-4" aria-hidden />
      Open Usage
    </Button>
  )
}

function CostsPanel({
  s,
  set,
  hint,
  field,
  fid,
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  hint: Hint
  field: FieldCheck
  fid: (k: string) => string
}) {
  const money = (path: SettingPath, value: number, onChange: (n: number) => void, id?: string) => (
    <input
      id={id}
      type="number"
      min={0}
      step={0.01}
      className={inputClass}
      value={numberText(value)}
      onChange={(e) => onChange(typedNumber(e.target.value))}
      {...field(path)}
    />
  )
  const rates = (kind: "boxActiveCpuHourlyUsd" | "boxKeepAliveMonthlyUsd") => BOX_SIZES.map((size) => `costRates.${kind}.${size}`)
  const sizeLabel: Record<BoxSize, string> = { small: "Small", medium: "Medium", large: "Large" }
  // A server older than this UI sends no cost settings and would reject saving them.
  if (!s.costRates || !s.budget)
    return (
      <Panel section="costs">
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          The server is running an older build without cost settings. Rebuild and restart it to set rates and budgets.
        </div>
      </Panel>
    )
  return (
    <Panel section="costs">
      <Row
        label="Allowances, cost and tokens"
        help="Open Usage for each Claude and Codex login's session and weekly allowances, plus daily model and box costs by project and task. It opens over Settings; closing it comes back here."
      >
        <OpenUsage />
      </Row>
      <Row
        id={fid("scm")}
        label="Box spend in the header"
        help="The Coordinator's header shows the cloud meter: boxes running, what they cost an hour and today's spend against the daily limit. Off, the Boxes page still shows it, and the limit's notices and Raise today's limit work the same."
        hint={hint("showCloudMeter")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("scm")} type="checkbox" checked={Boolean(s.showCloudMeter)} onChange={(e) => set("showCloudMeter", e.target.checked)} data-testid="show-cloud-meter" />
          {s.showCloudMeter ? "Shown in the Coordinator's header" : "Off: only on the Boxes page"}
        </label>
      </Row>
      <Row
        id={fid("daily-budget")}
        label="Daily cloud limit"
        help="What boxes may cost per day, by the CPU they use (Claude isn't counted). At 80% Box Yard says so; at the limit new boxes wait until midnight while work already running goes on, and the cloud meter (on the Boxes page, and in the Coordinator's header if shown) offers Raise today's limit. 0: no daily limit."
        hint={hint("budget", ["budget.dailyUsd"])}
      >
        {money("budget.dailyUsd", s.budget.dailyUsd, (n) => set("budget", { ...s.budget, dailyUsd: n }), fid("daily-budget"))}
      </Row>
      <Row
        id={fid("monthly-budget")}
        label="Monthly cloud limit"
        help="Box spend over the last 30 days. At it, new boxes wait until the spend drops under it or you raise it. 0: no monthly limit."
        hint={hint("budget", ["budget.monthlyUsd"])}
      >
        {money("budget.monthlyUsd", s.budget.monthlyUsd, (n) => set("budget", { ...s.budget, monthlyUsd: n }), fid("monthly-budget"))}
      </Row>
      <Row
        label="Active CPU rates"
        help="Upstash bills the CPU a box uses, per core-hour: a box busy on 2 cores for an hour uses 2. Box Yard measures each box's CPU and prices it at these rates, unless Upstash reports its own charge for the box. Defaults match the public Small / Medium / Large rates."
        hint={hint("costRates", rates("boxActiveCpuHourlyUsd"))}
      >
        <div className="grid grid-cols-3 gap-2">
          {BOX_SIZES.map((size) => (
            <label key={size} className="space-y-1">
              <span className="text-[11px] text-zinc-500">{sizeLabel[size]}</span>
              {money(`costRates.boxActiveCpuHourlyUsd.${size}`, s.costRates.boxActiveCpuHourlyUsd[size], (n) =>
                set("costRates", { ...s.costRates, boxActiveCpuHourlyUsd: { ...s.costRates.boxActiveCpuHourlyUsd, [size]: n } }),
              )}
            </label>
          ))}
        </div>
      </Row>
      <Row
        label="Keep-alive rates"
        help="A keep-alive box costs its monthly fee and no CPU charge, prorated by uptime, when the provider reports keep-alive is on."
        hint={hint("costRates", rates("boxKeepAliveMonthlyUsd"))}
      >
        <div className="grid grid-cols-3 gap-2">
          {BOX_SIZES.map((size) => (
            <label key={size} className="space-y-1">
              <span className="text-[11px] text-zinc-500">{sizeLabel[size]}</span>
              {money(`costRates.boxKeepAliveMonthlyUsd.${size}`, s.costRates.boxKeepAliveMonthlyUsd[size], (n) =>
                set("costRates", { ...s.costRates, boxKeepAliveMonthlyUsd: { ...s.costRates.boxKeepAliveMonthlyUsd, [size]: n } }),
              )}
            </label>
          ))}
        </div>
      </Row>
      <Row id={fid("storage")} label="Storage rate" help="Storage and snapshot cost per GB-month. Disk use is probed from boxes when available." hint={hint("costRates", ["costRates.boxStorageGbMonthUsd"])}>
        {money("costRates.boxStorageGbMonthUsd", s.costRates.boxStorageGbMonthUsd, (n) => set("costRates", { ...s.costRates, boxStorageGbMonthUsd: n }), fid("storage"))}
      </Row>
      <div className="mt-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-400">
        Claude Code costs come from the CLI's result JSON and don't count against the cloud limits. A box's cost is Upstash's own charge when its API reports one, its measured CPU at these rates when that's more, and the time a turn ran (labeled an estimate) while neither is known. RunPod GPU pods, Vast.ai instances and Daytona sandboxes have their own hourly caps (Settings › RunPod GPU, Settings › Vast.ai GPU, Settings › Daytona); Daytona sandboxes also count toward the cloud limits, at Box Yard's estimate of their price.
      </div>
    </Panel>
  )
}

function NotificationsPanel({ fid }: { fid: (k: string) => string }) {
  // Sound on send is saved in this browser; the row previews the draft.
  const [sound, setSound] = useDraft("send-sound", "notifications", useSendSound(), setSendSound)
  return (
    <Panel section="notifications">
      <BrowserNotificationsRow fid={fid} />
      <SendSoundRow fid={fid} value={sound} onChange={setSound} />
    </Panel>
  )
}

function AboutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SettingsField label={label} className="grid gap-x-8 gap-y-1 border-t border-zinc-900 py-3 first:border-t-0 first:pt-0 @lg:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-sm text-zinc-400"><SearchHighlight text={label} /></dt>
      <dd className="min-w-0 text-sm wrap-anywhere text-zinc-100">{children}</dd>
    </SettingsField>
  )
}

function AboutPanel() {
  const health = useHealth()
  const server = useSettings()
  const h = health.data
  const link = "inline-flex items-center gap-1 text-sky-400 hover:underline"
  return (
    <Panel section="about">
      <dl>
        <AboutRow label="Version">
          <span className="font-mono">{__APP_VERSION__}</span>
          {__APP_COMMIT__ && (
            <NewTabLink className={cx(link, "ml-2 font-mono")} href={`https://github.com/AgentSystemLabs/box-yard/commit/${__APP_COMMIT__}`}>
              {__APP_COMMIT__}
            </NewTabLink>
          )}
        </AboutRow>
        <AboutRow label="Box provider">
          {h?.provider ?? "…"}
          {h?.mock && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">mock mode</span>}
        </AboutRow>
        <AboutRow label="Claude CLI">{h ? (h.claude.available ? <span className="font-mono">{h.claude.version}</span> : <span className="text-red-300">not found</span>) : "…"}</AboutRow>
        <AboutRow label="Event bus">{h ? (h.bus === "redis" ? "Upstash Redis" : "Local files") : "…"}</AboutRow>
        <AboutRow label="Scheduler">{h ? (h.scheduler === "qstash" ? "QStash + server timer" : "Server timer") : "…"}</AboutRow>
        <AboutRow label="Default time zone">{server.data?.defaultTimezone ?? "…"}</AboutRow>
        <AboutRow label="Max upload">{server.data ? `${server.data.maxUploadMb} MB` : "…"}</AboutRow>
        <AboutRow label="Links">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <NewTabLink className={link} mark="end" href="https://github.com/AgentSystemLabs/box-yard">
              GitHub
            </NewTabLink>
            <NewTabLink className={link} mark="end" href="https://upstash.com/docs/box">
              Upstash Box docs
            </NewTabLink>
            <NewTabLink className={link} mark="end" href="https://console.upstash.com">
              Upstash console
            </NewTabLink>
          </div>
        </AboutRow>
      </dl>
      <p className="mt-6 text-xs text-zinc-500">Time zone, upload size, provider and data directory come from env vars on the server (see the README).</p>
    </Panel>
  )
}
