// A failed task's banner: what went wrong in plain words (lib/failure.ts), the next step (Retry, the Settings page that
// fixes it, or when a usage limit resets), and the raw error under Details. The task panel and the task page show it.
import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, CloudOff, Copy, CreditCard, HardDrive, Hourglass, KeyRound, MemoryStick, RefreshCcw, ServerOff, Settings, Timer, TriangleAlert, Unplug, type LucideIcon } from "lucide-react"
import type { Project, Task } from "../../../shared/types"
import { explainFailure, failureHasMore, type FailureKind } from "../lib/failure"
import { useIdentities, useRetryTask } from "../lib/queries"
import { copyText } from "../lib/clipboard"
import { toast } from "../lib/toast"
import { useOpenSettings } from "./SettingsHost"
import { ContinueTask } from "./ContinueTask"
import { Button, COPIED_MS, LineIcon, LinkedText, cx, useMinuteClock } from "./ui"

const ICON: Record<FailureKind, LucideIcon> = {
  usage_limit: Hourglass,
  rate_limited: Hourglass,
  out_of_credit: CreditCard,
  agent_auth: KeyRound,
  github_auth: KeyRound,
  unreachable: ServerOff,
  disk: HardDrive,
  memory: MemoryStick,
  api_down: CloudOff,
  start_timeout: Timer,
  interrupted: Unplug,
  not_started: TriangleAlert,
  start_failed: TriangleAlert,
  unknown: TriangleAlert,
}

type FailedTask = Pick<Task, "id" | "status" | "error" | "agentCli" | "limitWait">

/** Nothing unless the task failed with an error. */
export function TaskFailure({ task, project, className }: { task: FailedTask; project?: Pick<Project, "identityId"> | null; className?: string }) {
  if (task.status !== "failed" || !task.error) return null
  return <FailureBanner task={task} error={task.error} identityId={project?.identityId} className={className} />
}

function FailureBanner({ task, error, identityId, className }: { task: FailedTask; error: string; identityId?: string; className?: string }) {
  // A usage limit's "resets in 2h 17m" counts down, and says so once it has reset.
  const now = useMinuteClock()
  const identity = useIdentities().data?.find((i) => i.id === identityId)
  const retry = useRetryTask()
  const openSettings = useOpenSettings()
  const [open, setOpen] = useState(false)
  const f = explainFailure(error, { agentCli: task.agentCli, ownClaudeLogin: Boolean(identity?.claude), now, resumesItself: Boolean(task.limitWait) })
  const more = failureHasMore(error, f)
  const rawId = `task-error-${task.id}`
  const settings = f.settings && (
    <Button size="sm" variant={f.fixFirst ? "primary" : "subtle"} onClick={() => openSettings(f.settings!.section)} data-testid="failure-settings">
      <Settings className="h-3.5 w-3.5" aria-hidden /> {f.settings.label}
    </Button>
  )
  return (
    <section aria-label="Why it failed" data-failure={f.kind} className={cx("rounded-xl border border-red-900/50 bg-red-950/30 p-3 text-sm text-red-100", className)}>
      <div className="flex items-start gap-2.5">
        <LineIcon icon={ICON[f.kind]} className="h-4 w-4 text-red-300" />
        <div className="min-w-0 flex-1">
          <p className="font-medium wrap-anywhere text-red-50" data-testid="failure-title">
            {f.title}
          </p>
          <p className="mt-0.5 wrap-anywhere text-red-200/80" data-testid="failure-detail">
            {f.detail}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {f.fixFirst && settings}
            <Button size="sm" variant={f.fixFirst || f.waitFirst ? "subtle" : "primary"} loading={retry.isPending} onClick={() => retry.mutate(task.id)} data-testid="failure-retry">
              {!retry.isPending && <RefreshCcw className="h-3.5 w-3.5" aria-hidden />} {f.waitFirst ? "Retry now" : "Retry"}
            </Button>
            <ContinueTask task={task} />
            {!f.fixFirst && settings}
            {more && (
              <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={rawId} onClick={() => setOpen((o) => !o)} className="text-red-200/70 hover:text-red-100" data-testid="failure-details">
                Details <ChevronDown className={cx("h-3.5 w-3.5", open && "rotate-180")} aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>
      {more && open && (
        <div id={rawId} className="mt-2.5">
          <pre className="max-h-48 overflow-y-auto rounded-lg bg-zinc-950/60 p-2.5 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-red-200/90" data-testid="failure-raw">
            <LinkedText text={error} />
          </pre>
          <CopyError text={error} />
        </div>
      )}
    </section>
  )
}

/** Always shown (no hover), so the exact error can go into a bug report or a message to the agent. */
function CopyError({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <Button
      size="sm"
      variant="ghost"
      className="mt-1.5 text-red-200/70 hover:text-red-100"
      onClick={async () => {
        if (!(await copyText(text))) return void toast.error("Couldn't copy", "The browser blocked clipboard access.")
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span role="status">{copied ? "Copied" : "Copy error"}</span>
    </Button>
  )
}
