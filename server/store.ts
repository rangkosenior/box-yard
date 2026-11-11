import { randomUUID } from "node:crypto"
import type { DB } from "./db.js"
import type { ArchiveKind } from "./archive.js"
import { redactPrivateKeys, redactValues } from "./redact.js"
import type { UsageLimitKind } from "../shared/usageLimit.js"
import { BOX_SIZES, TASK_STATUSES, WAIT_FIXES, shouldNotify, weakerSource } from "../shared/types.js"
import { activityLine } from "../shared/activity.js"
import { todaysRaise } from "./cloudLimit.js"
import { isQuietRun, parseOutcome, type TaskOutcome } from "../shared/quiet.js"
import { parsePriority, type TaskPriority } from "../shared/priority.js"
import { normalizeRunner, parseRunsOn, type Runner } from "../shared/runner.js"
import { normalizeLabel } from "../shared/machines.js"
import { DEFAULT_IDENTITY_ID } from "../shared/identities.js"
import { DEFAULT_AGENT_CLI, isAgentCli, type AgentCli } from "../shared/agentCli.js"
import { isProjectColor, type ProjectColor } from "../shared/projectColors.js"
import { isCaptainIcon, type CaptainIconId } from "../shared/captainIcons.js"
import { PROJECT_ICON_FILE, projectIconUrl } from "../shared/projectIcons.js"
import { isTaskIcon, type TaskIconName } from "../shared/taskIcons.js"
import { isBoxPick, placeKindOf, type BoxPick, type Place, type TaskPlacement } from "../shared/placement.js"
import { limitBlock, type BoxAgent } from "./agentLimits.js"
import type { ProjectSnapshot } from "../shared/snapshots.js"
import type { ProjectGpuMachine } from "../shared/runpod.js"
import { isGpuProvider, type GpuPick, type GpuProvider } from "../shared/gpu.js"
import type { ProjectDocker } from "../shared/docker.js"
import { buildUsagePeriod, type PeriodBoxInterval, type PeriodClaudeRow } from "./usagePeriod.js"
import { attributeCompute, buildUsageLedger, isDipBooking, sessionRates, type LedgerClaudeRow, type LedgerInterval, type LedgerPod, type LedgerTurn } from "./usageLedger.js"
import { usageLedgerCache, type LedgerDay } from "./usageLedgerCache.js"
import type { UsageComputeRow, UsageLedger, UsageLlmRow } from "../shared/usageLedger.js"
import { DAYTONA_RATES } from "../shared/daytona.js"
import { loginName } from "../shared/agentLogins.js"
import type { TokenUsage } from "./usage.js"
import type { TurnTrigger } from "./turnTrigger.js"
import { AUTO_SIZE_WINDOW_MS, type TurnPeak } from "../shared/autoSize.js"
import { TURN_TIMINGS_WINDOW_MS, type TurnRole, type TurnTiming } from "../shared/turnTimings.js"
import type { LimitHarness, LimitLoginKind, LimitStatus } from "../shared/loginLimits.js"
import type {
  AppNotification,
  Artifact,
  CaptainMessage,
  BoxSize,
  BoxUsageTotals,
  BudgetSettings,
  BudgetStatus,
  UsageSource,
  WaitFix,
  ChatMessage,
  ChatRole,
  ClaudeUsageTotals,
  CostRates,
  CompactionTaskSnapshot,
  Effort,
  MergeRequest,
  OrchestratorCompactionRecord,
  PrState,
  PreviewLink,
  PushState,
  Project,
  ProjectNote,
  NoteSuggestion,
  NoteSuggestionStatus,
  CatchUp,
  Schedule,
  ScheduleRun,
  ScheduleRunStatus,
  ScheduleTarget,
  SideThread,
  SideThreadKind,
  SideThreadMessage,
  SideThreadRole,
  Task,
  WaitFor,
  TaskCompactionRecord,
  TaskMessage,
  TaskMessageRole,
  TaskStatus,
  UsageBoxTotal,
  UsageProjectTotal,
  UsageReport,
  UsagePeriodReport,
  UsageTaskTotal,
  UsageWindow,
} from "../shared/types.js"

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`

interface SideThreadRow {
  id: string
  project_id: string | null
  anchor_id: string
  kind: string
  quote: string
  created_at: number
  updated_at: number
  context: string | null
  resolved_at: number | null
  seen_at: number | null
  replies: number
  last_answer_at: number | null
}

/** A thread row with its reply count and newest answer, for sideThreadFrom. */
const SIDE_THREAD_SELECT = `SELECT t.*,
  (SELECT COUNT(*) FROM side_thread_messages m WHERE m.thread_id = t.id AND m.role IN ('user', 'assistant')) AS replies,
  (SELECT MAX(m.created_at) FROM side_thread_messages m WHERE m.thread_id = t.id AND m.role IN ('assistant', 'error')) AS last_answer_at
  FROM side_threads t`

/** busy is the runner's to say (SideThreads.decorate); a row alone is never busy. */
function sideThreadFrom(r: SideThreadRow): SideThread {
  return {
    id: r.id,
    projectId: r.project_id,
    anchorId: r.anchor_id,
    kind: r.kind === "reply" || r.kind === "task" ? r.kind : "ask",
    quote: r.quote,
    context: r.context === "fork" || r.context === "summary" ? r.context : null,
    busy: false,
    replies: r.replies ?? 0,
    unread: r.last_answer_at !== null && r.last_answer_at > (r.seen_at ?? 0),
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Parse JSON text, or return the fallback when it's empty or invalid. */
export const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const publicMergeRequest = (req: StoredMergeRequest | null): MergeRequest | null =>
  req ? { prNumber: req.prNumber, prUrl: req.prUrl, requestedAt: req.requestedAt, deliveredAt: req.deliveredAt, requestedBy: req.requestedBy ?? null } : null

/** What happened during the turn that is running now. Reset at turn start. */
export interface TurnFlags {
  asked?: string
  /** The agent called finish with this summary: its work is ready for review. The task rests, never done (only Cody marks that). */
  finished?: string
  waitingOn?: string[]
  sawPr?: boolean
  /** The agent marked the run a no-op (finish outcome "noop"), with its commit count if it could tell. */
  noop?: { commits: number | null }
  /** How many times in a row a turn died and was retried. */
  interrupts?: number
  /** How many local-runner turns in a row this computer's sleep cut off, each resumed instead of failed (#104). */
  sleeps?: number
  /** A turn that ran out of memory was retried on a bigger box (auto-sizing); a second one fails as usual. */
  oomRetries?: number
  /** A turn whose login hit its usage limit or was refused was retried on the next login (docs/logins.md); a second one fails as usual. */
  loginRetries?: number
  /** The turn failed on a Claude usage limit and waits for it to clear (server/usageLimitWatch.ts); the task stays failed until then. */
  limitWait?: { kind: UsageLimitKind; resetsAt: number | null }
  /** Hooks whose prompts started this turn (their inputs were in it), so they don't fire on it again. */
  hookIds?: string[]
  /** The same for the turn before, kept while the task rests (a PR merged later still knows who asked). */
  lastHookIds?: string[]
  /** What started this turn (a retry keeps the retried turn's); "agent" turns can be quiet agent wakes. */
  trigger?: TurnTrigger
  /** The PR (url and state, prMark) as this turn started, to tell whether it changed during the turn. */
  prBefore?: string
}

export interface TaskRow {
  id: string
  project_id: string
  title: string
  prompt: string
  status: TaskStatus
  box_id: string | null
  session_id: string
  session_started: number
  branch: string | null
  pr_url: string | null
  pr_state: PrState | null
  pr_merged_at: number | null
  pr_merged_by: string | null
  outcome: TaskOutcome | null
  previews_json: string
  question: string | null
  summary: string | null
  error: string | null
  wait_reason: string | null
  wait_box_size: string | null
  wait_for_json?: string | null
  wait_fix?: string | null
  turn_count: number
  port_base: number | null
  event_cursor: string | null
  current_turn_id: string | null
  turn_flags_json: string
  env_json: string
  archive_path: string | null
  last_archived_at: number | null
  /** What the archive holds: 'git', 'whole', 'partial' or 'thin' (TaskManager.archive); null on old rows. */
  archive_kind?: string | null
  created_at: number
  updated_at: number
  last_active_at: number
  schedule_id: string | null
  context_tokens: number | null
  context_window: number | null
  compact_pending: number
  compacting: number
  compact_prev_status: TaskStatus | null
  model: string | null
  effort: Effort | null
  routing_rule: string | null
  routing_reason: string | null
  /** The task's own runner, 'local' or 'box', over its project's; null (and old rows) follow the project. */
  runs_on?: string | null
  /** With its own runs_on 'ssh': the SSH machines it runs on, by label or name; null: any machine. */
  machine_label?: string | null
  /** With its own runs_on 'gpu': its own cloud ('runpod', 'vast' or 'daytona') and GPU, as that cloud spells it (Task.gpu). */
  gpu_provider?: string | null
  gpu_type?: string | null
  gpu_size?: string | null
  box_size?: string | null
  /** The CLI its agent runs on, 'claude' or 'codex'; null on rows from before Codex: Claude Code. */
  agent_cli?: string | null
  /** Where it last ran once its box let it go: a Place plus leftAt (Task.placement.last). */
  last_place_json?: string | null
  placed_how?: string | null
  /** Who started the task: cody, orchestrator, captain:<project>, schedule or hook:<hook>; null on old rows. */
  source: string | null
  pr_head_sha: string | null
  pr_labels_json: string | null
  merge_request_json: string | null
  push_state_json: string | null
  /** Its icon (shared/taskIcons.ts); null picks one from its title. */
  icon?: string | null
  /** Shared by the tasks one create_tasks call started; null when started on its own. */
  batch_id?: string | null
  /** 'high' jumps the queue (shared/priority.ts); null (and old rows) are normal. */
  priority?: string | null
  /** 1: never moved to done when its PR merges (server/mergeFollowUp.ts). */
  stay_open_on_merge?: number
  /** Immutable physical environment inherited by descendants; server policy only, never TaskPatch. */
  environment_type?: string | null
  /** The task whose agent started this one with spawn_subtasks (server/subtasks.ts); null for a top-level task. */
  parent_task_id?: string | null
  /** The top of its sub-task tree; null for a top-level task. */
  root_task_id?: string | null
  /** How deep in its tree: 0 top level, 1 a parent's child, and so on. */
  subtask_depth?: number
  /** 1: runs where its parent runs and shares its parent's slot (runs_on "same"). */
  with_parent?: number
  /** What Mark done closed it from (DoneFrom, as JSON), for Reopen; null once it leaves done another way. */
  done_from_json?: string | null
  /** The merged PR a reopen kept open: that merge doesn't move it to done again (TaskManager.autoDoneOnMerge). */
  reopened_merged_pr?: string | null
}

/** What a task was when Mark done closed it (TaskManager.closeTask), so Reopen can put it back. */
export interface DoneFrom {
  status: TaskStatus
  /** Its open question, when it was waiting on Cody's answer. */
  question: string | null
  /** The task it was closed with (a parent's close takes its sub-tasks), so reopening that one reopens it too. */
  parent: string | null
}

/** A pending merge request as stored: the public fields plus the queued input that carries the message. */
export interface StoredMergeRequest extends MergeRequest {
  inputId: string
}

export interface TaskTurnRow {
  id: string
  task_id: string
  turn_index: number
  model: string | null
  effort: Effort | null
  routing_rule: string | null
  routing_reason: string | null
  status: string
  started_at: number
  finished_at: number | null
  cost_usd: number | null
  error: string | null
  /** What started the turn (server/turnTrigger.ts); null for turns from before it was recorded. */
  trigger: TurnTrigger | null
  /** The login it ran on (server/agentLogins.ts); null when the rotation handed it none (or before logins). */
  login_id: string | null
  /** The box it ran on; null for turns from before it was recorded. */
  box_id: string | null
}

interface ScheduleRunRow {
  id: string
  schedule_id: string
  status: ScheduleRunStatus
  reason: ScheduleRun["reason"]
  prompt: string
  due_at: number
  chat_message_id: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface ScheduleRow {
  id: string
  target: ScheduleTarget
  project_id: string | null
  runs_on: Runner | null
  name: string
  cron: string
  timezone: string
  prompt: string
  enabled: number
  catch_up: CatchUp
  allow_overlap: number
  next_run_at: number | null
  last_run_at: number | null
  last_task_id: string | null
  last_skip_reason: string | null
  run_count: number
  qstash_id: string | null
  created_at: number
  updated_at: number
}

export type SchedulePatch = Partial<{
  runsOn: Runner | null
  name: string
  cron: string
  timezone: string
  prompt: string
  enabled: boolean
  catchUp: CatchUp
  allowOverlap: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastTaskId: string | null
  lastSkipReason: string | null
  runCount: number
  qstashId: string | null
}>

const SCHEDULE_COLUMNS: Record<keyof SchedulePatch, string> = {
  runsOn: "runs_on",
  name: "name",
  cron: "cron",
  timezone: "timezone",
  prompt: "prompt",
  enabled: "enabled",
  catchUp: "catch_up",
  allowOverlap: "allow_overlap",
  nextRunAt: "next_run_at",
  lastRunAt: "last_run_at",
  lastTaskId: "last_task_id",
  lastSkipReason: "last_skip_reason",
  runCount: "run_count",
  qstashId: "qstash_id",
}

/** An unseen Captain notice, with what its WakeLoopGuard counts it by and its meta (a notes retro's suggestion ids). */
export interface CaptainNoticeEntry {
  content: string
  loopKey: string
  meta: Record<string, unknown> | null
  createdAt: number
}

/** A project's own box settings; null uses the global one (shared/types.ts Project). */
export interface ProjectBoxLimits {
  agentsPerBox: number | null
  /** Needs the whole machine (server/agentLimits.ts). */
  wholeMachine: boolean
  tasksPerBox: number | null
  maxBoxes: number | null
}

/**
 * The old per-project "heavy tasks" choice (projects.heavy_tasks), which Agents per box replaced: "one-per-box" and
 * "whole-box" both mean 1. The migration copied them into agents_per_box; they're still read while it's NULL.
 */
const legacyAgentsPerBox = (heavy: string | null | undefined): number | null => (heavy === "one-per-box" || heavy === "whole-box" ? 1 : null)
/** A project row's own GPU machine (Project.gpuMachine); anything unreadable is null, so Settings › RunPod GPU's applies. */
function gpuMachineOf(row: Pick<ProjectRow, "gpu_types_json" | "gpu_cloud" | "gpu_min_ram_gb" | "gpu_min_vcpus">): ProjectGpuMachine {
  const types = json<unknown>(row.gpu_types_json ?? null, null)
  return {
    gpuTypes: Array.isArray(types) && types.length && types.every((t) => typeof t === "string") ? (types as string[]) : null,
    cloud: row.gpu_cloud === "SECURE" || row.gpu_cloud === "COMMUNITY" ? row.gpu_cloud : null,
    minRamGb: row.gpu_min_ram_gb ?? null,
    minVcpus: row.gpu_min_vcpus ?? null,
  }
}
/** legacyAgentsPerBox in SQL, for the slot claim. */
const AGENTS_PER_BOX = "COALESCE(agents_per_box, CASE WHEN heavy_tasks IN ('one-per-box', 'whole-box') THEN 1 END)"

interface ProjectRow {
  id: string
  name: string
  /** Its colour (shared/projectColors.ts); null picks one from its name. */
  color?: string | null
  /** Its icon's file (server/projectIcons.ts); null shows its coloured letter. */
  icon?: string | null
  /** Its Captain's icon id (shared/captainIcons.ts); null uses the default. */
  captain_icon?: string | null
  description: string
  repo: string | null
  base_branch: string
  env_json: string
  box_size: string | null
  partial_clone: number | null
  push_at_turn_end: number | null
  dep_cache?: number | null
  close_issues_on_merge?: number | null
  auto_done_on_merge?: number | null
  runner?: string | null
  machine_label?: string | null
  heavy_tasks: string | null
  agents_per_box?: number | null
  whole_machine?: number | null
  tasks_per_box?: number | null
  max_boxes?: number | null
  gpu_max_hourly_usd?: number | null
  gpu_types_json?: string | null
  gpu_cloud?: string | null
  gpu_min_ram_gb?: number | null
  gpu_min_vcpus?: number | null
  gpu_provider?: string | null
  docker_image?: string | null
  docker_dockerfile?: string | null
  identity_id?: string | null
  agent_cli?: string | null
  notes_max_count?: number | null
  notes_max_tokens?: number | null
  snapshot_id?: string | null
  snapshot_provider?: string | null
  snapshot_size?: string | null
  snapshot_box_id?: string | null
  snapshot_bytes?: number | null
  snapshot_at?: number | null
  sort_order: number
  created_at: number
  updated_at: number
}

export interface BoxRow {
  id: string
  provider: string
  status: "creating" | "ready" | "lost" | "deleting"
  created_at: number
  last_used_at: number
  size: BoxSize
  keep_alive: number
  active_ms: number
  last_metered_at: number | null
  disk_bytes: number | null
  disk_updated_at: number | null
  usage_source: UsageSource
  disk_free_bytes: number | null
  disk_total_bytes: number | null
  disk_checked_at: number | null
  root_free_bytes: number | null
  root_total_bytes: number | null
  mem_used_bytes: number | null
  mem_total_bytes: number | null
  load_avg: number | null
  cpu_count: number | null
  /** Last cumulative CPU readings: the box's cgroup (µs) and the provider's total (ns); null before the first. */
  cgroup_cpu_usec: number | null
  provider_cpu_ns: number | null
  /** Last cumulative compute cost the provider reported for the box; null before the first (or never). */
  provider_compute_usd: number | null
  /** Measured CPU core-ms and provider-priced compute $ not in box_usage_intervals yet (meterBoxes moves them). */
  pending_cpu_ms: number
  pending_compute_usd: number
  /** The part of active_ms whose price is fixed (intervals with compute_usd), and that price. */
  priced_active_ms: number
  priced_usd: number
  /** Since the provider began pricing the box: its compute total, and what the measured CPU cost at Settings' rates. */
  provider_usd: number
  measured_usd: number
}

/** Who ran a Claude turn. Captain rows written before "captain" existed are "orchestrator" rows with a project id. */
export type ClaudeUsageSource = "task" | "orchestrator" | "captain"

/** SQL filters for the Coordinator and Captain usage lines, so older Captain rows still land on the Captain line. */
export const COORDINATOR_USAGE_WHERE = "WHERE source = 'orchestrator' AND project_id IS NULL"
export const CAPTAIN_USAGE_WHERE = "WHERE source = 'captain' OR (source = 'orchestrator' AND project_id IS NOT NULL)"

export interface ClaudeUsageRow {
  id: string
  source: ClaudeUsageSource
  run_kind: string
  task_id: string | null
  project_id: string | null
  turn_id: string | null
  session_id: string | null
  model: string | null
  started_at: number
  ended_at: number
  duration_ms: number
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  total_tokens: number
  /** This run's own cost. */
  cost_usd: number
  /** What the CLI reported: the session's running total. */
  reported_cost_usd: number
  cost_estimated: number
  raw_usage_json: string
  /** What the CLI reported: the session's running token totals (TokenUsage JSON), or null. */
  reported_usage_json: string | null
}

/** A window's last reading for a login (shared/loginLimits.ts LimitWindow). */
export interface LoginLimitRow {
  login_id: string
  limit_window: string
  harness: LimitHarness
  kind: LimitLoginKind
  source: string
  scope: string
  fingerprint: string | null
  plan: string | null
  minutes: number | null
  used_pct: number | null
  resets_at: number | null
  status: LimitStatus | null
  as_of: number
}

interface TurnPeakRow {
  turn_id: string
  project_id: string
  task_id: string
  box_id: string
  box_size: string
  at: number
  mem_peak_bytes: number | null
  cpu_peak_cores: number | null
  cpu_busy_cores: number | null
  disk_peak_bytes: number | null
  oom: number
}

interface BoxUsageIntervalRow {
  id: string
  box_id: string
  provider: string
  size: BoxSize
  keep_alive: number
  started_at: number
  ended_at: number
  active_ms: number
  uptime_ms: number
  disk_bytes: number | null
  source: UsageSource
  /** The provider's own compute cost for the interval; null: priced from active_ms with Settings' rates. */
  compute_usd: number | null
}

/** One box's metered intervals' shares of a 15-minute slot, as the parts boxCost prices (see the box_usage_slots migration). */
interface BoxUsageSlotRow {
  slot: number
  box_id: string
  size: BoxSize
  keep_alive: number
  started_at: number
  ended_at: number
  active_ms: number
  cpu_ms: number
  compute_usd: number
  uptime_ms: number
  disk_byte_ms: number
  max_disk_bytes: number
  disk_bytes: number | null
  disk_at: number | null
  source_rank: number
}

/** A part of a box's spend inside a range (Store.boxPieces): a whole slot, or an interval's share of the range's end. */
type BoxPiece = PeriodBoxInterval & { maxDiskBytes: number }

/** box_usage_slots' slot length. */
const SLOT_MS = 15 * 60_000
/** box_usage_slots.source_rank: the index of the slot's weakest source. */
const SOURCE_RANKS: UsageSource[] = ["actual", "measured", "estimated"]

type TaskPatch = Partial<{
  agentCli: AgentCli
  title: string
  status: TaskStatus
  boxId: string | null
  sessionId: string
  sessionStarted: boolean
  branch: string | null
  prUrl: string | null
  prState: PrState | null
  prMergedAt: number | null
  prMergedBy: string | null
  outcome: TaskOutcome | null
  previews: PreviewLink[]
  question: string | null
  summary: string | null
  error: string | null
  waitReason: string | null
  waitBoxSize: BoxSize | null
  waitFor: WaitFor[]
  waitFix: WaitFix | null
  turnCount: number
  portBase: number | null
  eventCursor: string | null
  currentTurnId: string | null
  turnFlags: TurnFlags
  archivePath: string | null
  lastArchivedAt: number | null
  archiveKind: ArchiveKind | null
  lastActiveAt: number
  contextTokens: number | null
  contextWindow: number | null
  compactPending: boolean
  compacting: boolean
  compactPrevStatus: TaskStatus | null
  model: string | null
  effort: Effort | null
  routingRule: string | null
  routingReason: string | null
  runsOn: Runner | null
  machineLabel: string | null
  gpuProvider: GpuProvider | null
  gpuType: string | null
  gpuSize: string | null
  boxSize: BoxSize | null
  prHeadSha: string | null
  prLabels: string[]
  mergeRequest: StoredMergeRequest | null
  pushState: PushState | null
  placedHow: BoxPick | null
  priority: TaskPriority
  stayOpenOnMerge: boolean
  /** Set by closeTask; any other status but done clears it (updateTask). */
  doneFrom: DoneFrom | null
  reopenedMergedPr: string | null
}>

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  agentCli: "agent_cli",
  title: "title",
  status: "status",
  boxId: "box_id",
  sessionId: "session_id",
  sessionStarted: "session_started",
  branch: "branch",
  prUrl: "pr_url",
  prState: "pr_state",
  prMergedAt: "pr_merged_at",
  prMergedBy: "pr_merged_by",
  outcome: "outcome",
  previews: "previews_json",
  question: "question",
  summary: "summary",
  error: "error",
  waitReason: "wait_reason",
  waitBoxSize: "wait_box_size",
  waitFor: "wait_for_json",
  waitFix: "wait_fix",
  turnCount: "turn_count",
  portBase: "port_base",
  eventCursor: "event_cursor",
  currentTurnId: "current_turn_id",
  turnFlags: "turn_flags_json",
  archivePath: "archive_path",
  lastArchivedAt: "last_archived_at",
  archiveKind: "archive_kind",
  lastActiveAt: "last_active_at",
  contextTokens: "context_tokens",
  contextWindow: "context_window",
  compactPending: "compact_pending",
  compacting: "compacting",
  compactPrevStatus: "compact_prev_status",
  model: "model",
  effort: "effort",
  routingRule: "routing_rule",
  routingReason: "routing_reason",
  runsOn: "runs_on",
  machineLabel: "machine_label",
  gpuProvider: "gpu_provider",
  gpuType: "gpu_type",
  gpuSize: "gpu_size",
  boxSize: "box_size",
  prHeadSha: "pr_head_sha",
  prLabels: "pr_labels_json",
  mergeRequest: "merge_request_json",
  pushState: "push_state_json",
  placedHow: "placed_how",
  priority: "priority",
  stayOpenOnMerge: "stay_open_on_merge",
  doneFrom: "done_from_json",
  reopenedMergedPr: "reopened_merged_pr",
}

/** How many notifications to keep; older ones are pruned as new ones land. */
const NOTIFICATIONS_KEPT = 200

interface NotificationRow {
  id: string
  task_id: string | null
  box_id: string | null
  href: string | null
  project_id: string
  title: string
  project_name: string
  status: AppNotification["status"]
  summary: string | null
  created_at: number
  read_at: number | null
}

interface OrchestratorCompactionRow {
  id: string
  at: number
  session_id: string
  model: string
  trigger: "button" | "auto"
  tokens_before: number | null
  tokens_after: number | null
  markdown_path: string
  json_path: string
  markdown: string
  created_at: number
  task_count?: number
}

interface OrchestratorCompactionTaskRow {
  compaction_id: string
  task_id: string
  title: string
  status: TaskStatus
  project_id: string
  project_name: string
  branch: string | null
  pr_url: string | null
  session_id: string
  summary: string
  last_active_at: number
}

interface TaskCompactionRow {
  id: string
  task_id: string
  session_id: string
  at: number
  status_before: TaskStatus | null
  status_after: TaskStatus | null
  tokens_before: number | null
  tokens_after: number | null
  summary: string
  archive_path: string | null
  archive_available: number
  archive_note: string | null
  created_at: number
}

const taskRunsOn = (row: { runs_on?: string | null }) => parseRunsOn(row.runs_on)
/** A task's own GPU pick (Task.gpu): only with its own runs_on 'gpu' and a cloud Box Yard knows. */
export const taskGpuPick = (row: { runs_on?: string | null; gpu_provider?: string | null; gpu_type?: string | null; gpu_size?: string | null }): GpuPick | null =>
  taskRunsOn(row) === "gpu" && isGpuProvider(row.gpu_provider) ? { provider: row.gpu_provider, type: row.gpu_type || null, ...(row.gpu_size ? { size: row.gpu_size } : {}) } : null
/** The CLI a task's agent runs on: the one it was created with; older rows ran on Claude Code. */
export const taskAgentCli = (row: { agent_cli?: string | null }): AgentCli => (isAgentCli(row.agent_cli) ? row.agent_cli : DEFAULT_AGENT_CLI)

const oneLine = (text: string | null | undefined, max = 200) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

interface NoteRow {
  id: string
  project_id: string
  author: string
  content: string
  created_at: number
  updated_at: number | null
  updated_by: string | null
}
const noteFromRow = (r: NoteRow): ProjectNote => ({
  id: r.id,
  projectId: r.project_id,
  author: r.author,
  content: r.content,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? r.created_at,
  updatedBy: r.updated_by ?? null,
})

interface SuggestionRow {
  id: string
  project_id: string
  task_id: string | null
  task_title: string
  content: string
  why: string
  status: NoteSuggestionStatus
  note_id: string | null
  resolved_by: string | null
  reason: string | null
  retro_at: number | null
  created_at: number
  resolved_at: number | null
}
const suggestionFromRow = (r: SuggestionRow): NoteSuggestion => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  taskTitle: r.task_title,
  content: r.content,
  why: r.why,
  status: r.status,
  noteId: r.note_id,
  resolvedBy: r.resolved_by,
  reason: r.reason,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  retroAt: r.retro_at,
})

/** Queued inputs in send order. */
const INPUT_ORDER = "ORDER BY created_at ASC, rowid ASC"
/** A Coordinator chat notice that wakes it: all but a Captain's FYI reply (server/captainWake.ts). */
const WAKES = "json_extract(meta_json, '$.fyi') IS NOT 1"
/** How long a cancelled queued input is kept, so Undo can bring it back. */
export const CANCELLED_INPUT_KEEP_MS = 10 * 60_000

/**
 * What Store.taskFromRow reads besides the task's row. listTasks answers these for its whole list with one statement
 * each (the ids as a JSON array), not several statements per task: on a big yard that was most of GET /api/tasks.
 */
interface TaskLookups {
  /** Its queued messages (not cancelled): how many, and the parts of Task.queueRev. */
  pending(taskId: string): { n: number; v: number; d: number; t: number }
  spend(taskId: string): { costUsd: number; totalTokens: number }
  /** Its card line when it has no summary (shared/activity.ts). */
  activity(taskId: string): string | null
  runner(projectId: string): Runner
}
const NO_PENDING = { n: 0, v: 0, d: 0, t: 0 }
const NO_SPEND = { costUsd: 0, totalTokens: 0 }
/** A task's latest assistant and tool lines, newest first: the first that makes a card line is its activity. */
const ACTIVITY_SQL = "SELECT role, content, meta_json FROM task_messages WHERE task_id = ? AND role IN ('assistant', 'tool') ORDER BY created_at DESC, rowid DESC LIMIT 5"
const activityOf = (rows: unknown[]): string | null => {
  for (const r of rows as { role: string; content: string; meta_json: string | null }[]) {
    const line = activityLine(r.role, r.content, json(r.meta_json, null))
    if (line) return line
  }
  return null
}

interface InputRow {
  id: string
  task_id: string
  source: string
  content: string
  attachments: string | null
  status: "queued" | "delivering" | "cancelled"
  version: number
  claim: string | null
  prefix: string
  message_json: string | null
  created_at: number
  updated_at: number | null
}

/** A queued input as a turn delivers it: `content` is what the agent reads (prefix included). */
export interface PendingInput {
  id: string
  source: string
  content: string
  attachments: string[]
  /** When it was sent: a task turn's timings measure its queue wait from the oldest. */
  createdAt: number
}

/** A queued input as stored, for the queue list and its edits. `content` is the editable text (no prefix). */
export interface QueuedInputRow {
  id: string
  taskId: string
  source: string
  content: string
  attachments: string[]
  status: "queued" | "delivering" | "cancelled"
  /** Delivering as a steer into the running turn (claimSteer), not with a turn's start. */
  steering: boolean
  codexDelivery?: "submitted" | "accepted" | "uncertain"
  version: number
  /** The transcript line's meta (who sent it); null for agent and system messages. */
  message: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

/** A compare-and-set on a queued input: ok, or the input as it is now (null: gone, i.e. delivered or cleared). */
export type InputChange = { ok: true; row: QueuedInputRow; message?: TaskMessage } | { ok: false; row: QueuedInputRow | null }

/** A queued Coordinator chat or Captain message (meta.queued: sent mid-turn, waiting for the next one). */
export type QueuedChatTable = "chat_messages" | "captain_messages"
export interface QueuedChatRow {
  id: string
  content: string
  meta: Record<string, unknown>
  createdAt: number
}
/** Why a queued chat message couldn't change: a turn took it already, it was deleted, or there is no such message. */
export type QueuedChatChange = { ok: true; row: QueuedChatRow } | { ok: false; reason: "delivered" | "deleted" | "missing" }

const inputAttachments = (r: InputRow) => (r.attachments ? (JSON.parse(r.attachments) as string[]) : [])
const pendingInput = (r: InputRow): PendingInput => ({ id: r.id, source: r.source, content: r.prefix + (r.content || "(no text)"), attachments: inputAttachments(r), createdAt: r.created_at })
const queuedInputRow = (r: InputRow): QueuedInputRow => ({
  id: r.id,
  taskId: r.task_id,
  source: r.source,
  content: r.content,
  attachments: inputAttachments(r),
  status: r.status,
  steering: r.status === "delivering" && Boolean(r.claim?.startsWith("steer:") || r.claim?.startsWith("codex-")),
  codexDelivery: r.claim?.startsWith("codex-") ? r.claim.split(":")[0]!.slice(6) as QueuedInputRow["codexDelivery"] : undefined,
  version: r.version,
  message: r.message_json ? (JSON.parse(r.message_json) as Record<string, unknown>) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? r.created_at,
})

export class Store {
  constructor(readonly db: DB) {}

  // A conditional sidebar deletion reserves its entire scope before cleanup can await. Every input/turn admission
  // uses this Store, so a message, scheduled start or new child cannot enter the scope during destructive cleanup.
  private readonly deletingTasks = new Set<string>()
  private readonly deletingProjects = new Set<string>()

  projectDeletionPending(projectId: string): boolean {
    return this.deletingProjects.has(projectId)
  }

  taskDeletionPending(taskId: string, projectId?: string): boolean {
    if (this.deletingTasks.has(taskId)) return true
    return this.deletingProjects.size > 0 && this.deletingProjects.has(projectId ?? this.getTaskRow(taskId)?.project_id ?? "")
  }

  private assertTaskNotDeleting(taskId: string) {
    if (this.taskDeletionPending(taskId)) throw new ConflictError("This task is being deleted; wait for deletion to finish.")
  }

  /** Check live rows and reserve synchronously, before the first workspace/archive cleanup await. No status changes. */
  reserveRestingDeletion(target: { taskId: string; discardQueued?: number } | { projectId: string }): () => void {
    const projectId = "projectId" in target ? target.projectId : undefined
    if (projectId && !this.getProject(projectId)) throw new NotFoundError(`Project ${projectId} not found`)
    const rows = this.listTaskRows(projectId ? { projectId } : {})
    const ids = new Set("taskId" in target ? [target.taskId] : rows.map((r) => r.id))
    if ("taskId" in target) {
      if (!rows.some((r) => r.id === target.taskId)) throw new NotFoundError(`Task ${target.taskId} not found`)
      let added = true
      while (added) {
        added = false
        for (const r of rows) if (r.parent_task_id && ids.has(r.parent_task_id) && !ids.has(r.id)) { ids.add(r.id); added = true }
      }
    }
    if ((projectId && this.projectDeletionPending(projectId)) || rows.some((r) => ids.has(r.id) && this.taskDeletionPending(r.id, r.project_id))) {
      throw new ConflictError("Deletion is already in progress for this task or project.")
    }
    const discardQueued = "taskId" in target ? target.discardQueued : undefined
    const failedInputs = discardQueued === undefined ? [] : rows.filter((r) => ids.has(r.id) && r.status === "failed").flatMap((r) => this.listQueuedInputs(r.id))
    // Consent covers only failed tasks' queued inputs, never a running turn or an input already being delivered.
    if (discardQueued !== undefined && (rows.find((r) => r.id === ("taskId" in target ? target.taskId : ""))?.status !== "failed" || failedInputs.length !== discardQueued)) {
      throw new ConflictError("Queued messages changed. Review them and confirm deletion again.")
    }
    if (discardQueued !== undefined && failedInputs.some((i) => i.status !== "queued")) {
      throw new ConflictError("A queued message is being delivered or held. Stop the task and review its queued messages before deleting.")
    }
    if (rows.some((r) => ids.has(r.id) && (r.current_turn_id || ["queued", "starting", "working"].includes(r.status) || r.compacting || r.compact_pending || (this.hasInputs(r.id) && !(discardQueued !== undefined && r.status === "failed" && this.listQueuedInputs(r.id).every((i) => i.status === "queued"))) || this.hasUncertainCodexInput(r.id)))) {
      throw new ConflictError("Stop queued or running tasks before deleting.")
    }
    for (const id of ids) this.deletingTasks.add(id)
    if (projectId) this.deletingProjects.add(projectId)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of ids) this.deletingTasks.delete(id)
      if (projectId) this.deletingProjects.delete(projectId)
    }
  }

  /**
   * What only a provider knows about a box (a RunPod pod's GPU type and id, a Docker container's name), merged
   * into Task.placement. Set by the app; tests leave it unset.
   */
  placeExtra: ((boxId: string) => Partial<Place> | null) | null = null

  /** Called with every notification right after it is recorded (the app broadcasts it). */
  onNotification: ((n: AppNotification) => void) | null = null
  /**
   * The secret values transcripts never keep (app.ts: Settings › Credentials' and the identities'). An agent that
   * prints its env or task.json shows "[redacted]" in its transcript, the Captain's and the Coordinator's. What Cody
   * writes ("user" messages) is kept as written.
   */
  transcriptSecrets: (() => readonly string[]) | null = null

  /** `content` and `meta` with every transcript secret replaced by "[redacted]". */
  private scrub(role: string, content: string, meta: Record<string, unknown> | null): { content: string; meta: Record<string, unknown> | null } {
    if (role === "user") return { content, meta }
    const secrets = this.transcriptSecrets?.() ?? []
    const clean = (text: string) => redactPrivateKeys(secrets.length ? redactValues(text, secrets) : text)
    // Meta string by string, not as JSON text: a cut-off key's redaction can't break the JSON.
    let changed = false
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") {
        const c = clean(v)
        if (c !== v) changed = true
        return c
      }
      if (Array.isArray(v)) return v.map(walk)
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
      return v
    }
    const cleanMeta = meta ? (walk(meta) as Record<string, unknown>) : null
    return { content: clean(content), meta: changed ? cleanMeta : meta }
  }

  // ---------- projects ----------

  private projectFromRow(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      repo: row.repo,
      baseBranch: row.base_branch,
      envKeys: Object.keys(json<Record<string, string>>(row.env_json, {})),
      notes: this.listNotes(row.id),
      notesMaxCount: row.notes_max_count ?? null,
      notesMaxTokens: row.notes_max_tokens ?? null,
      boxSize: row.box_size ? normalizeBoxSize(row.box_size) : null,
      partialClone: row.partial_clone === null || row.partial_clone === undefined ? null : row.partial_clone === 1,
      pushAtTurnEnd: row.push_at_turn_end === null || row.push_at_turn_end === undefined ? null : row.push_at_turn_end === 1,
      depCache: row.dep_cache === null || row.dep_cache === undefined ? null : row.dep_cache === 1,
      closeIssuesOnMerge: row.close_issues_on_merge === null || row.close_issues_on_merge === undefined ? null : row.close_issues_on_merge === 1,
      autoDoneOnMerge: row.auto_done_on_merge === null || row.auto_done_on_merge === undefined ? null : row.auto_done_on_merge === 1,
      runner: normalizeRunner(row.runner),
      machineLabel: row.machine_label || null,
      agentCli: isAgentCli(row.agent_cli) ? row.agent_cli : null,
      agentsPerBox: row.agents_per_box ?? legacyAgentsPerBox(row.heavy_tasks),
      wholeMachine: row.whole_machine === 1,
      tasksPerBox: row.tasks_per_box ?? null,
      maxBoxes: row.max_boxes ?? null,
      gpuMaxHourlyUsd: row.gpu_max_hourly_usd ?? null,
      gpuMachine: gpuMachineOf(row),
      gpuProvider: isGpuProvider(row.gpu_provider) ? row.gpu_provider : null,
      docker: { image: row.docker_image || null, dockerfile: row.docker_dockerfile || null },
      identityId: row.identity_id || DEFAULT_IDENTITY_ID,
      color: isProjectColor(row.color) ? row.color : null,
      iconUrl: row.icon && PROJECT_ICON_FILE.test(row.icon) ? projectIconUrl(row.id, row.icon) : null,
      captainIcon: isCaptainIcon(row.captain_icon) ? row.captain_icon : null,
      snapshot: row.snapshot_id
        ? {
            id: row.snapshot_id,
            provider: row.snapshot_provider ?? "upstash",
            size: normalizeBoxSize(row.snapshot_size),
            boxId: row.snapshot_box_id ?? "",
            bytes: row.snapshot_bytes ?? null,
            takenAt: row.snapshot_at ?? 0,
          }
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** In the owner's order (drag-to-reorder in the sidebar), then oldest first. */
  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC, rowid ASC").all() as ProjectRow[]
    return rows.map((r) => this.projectFromRow(r))
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined
    return row ? this.projectFromRow(row) : null
  }

  /** Just the name, without loading the notes (placement asks often). */
  getProjectName(id: string): string | null {
    return (this.db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? null
  }

  /** The project's own box limits (null: the global one applies), without loading the rest (placement asks per box and running task). */
  projectBoxLimits(id: string): ProjectBoxLimits {
    const row = this.db.prepare(`SELECT ${AGENTS_PER_BOX} AS agents, whole_machine AS whole, tasks_per_box AS tasks, max_boxes AS boxes FROM projects WHERE id = ?`).get(id) as
      | { agents: number | null; whole: number | null; tasks: number | null; boxes: number | null }
      | undefined
    return { agentsPerBox: row?.agents ?? null, wholeMachine: row?.whole === 1, tasksPerBox: row?.tasks ?? null, maxBoxes: row?.boxes ?? null }
  }

  /** A GPU project's own $/hr cap on its pods together, or null for Settings › RunPod GPU's (Project.gpuMaxHourlyUsd). */
  projectGpuCap(id: string): number | null {
    const row = this.db.prepare("SELECT gpu_max_hourly_usd AS usd FROM projects WHERE id = ?").get(id) as { usd: number | null } | undefined
    return row?.usd ?? null
  }

  /** A GPU project's own machine for new pods (null fields: Settings › RunPod GPU's), without loading the rest. */
  projectGpuMachine(id: string): ProjectGpuMachine {
    const row = this.db.prepare("SELECT gpu_types_json, gpu_cloud, gpu_min_ram_gb, gpu_min_vcpus FROM projects WHERE id = ?").get(id) as ProjectRow | undefined
    return gpuMachineOf(row ?? {})
  }

  /** A GPU project's own cloud (Project.gpuProvider), or null to follow the global one, without loading the rest. */
  projectGpuProvider(id: string): GpuProvider | null {
    const row = this.db.prepare("SELECT gpu_provider FROM projects WHERE id = ?").get(id) as { gpu_provider: string | null } | undefined
    return isGpuProvider(row?.gpu_provider) ? row.gpu_provider : null
  }

  /** Where the project's agents run, without loading the rest (placement asks for every queued task). */
  /** Where a task's turns run: its own runs_on when set, else its project's "Runs on". */
  taskRunner(row: Pick<TaskRow, "project_id" | "runs_on">): Runner {
    return taskRunsOn(row) ?? this.projectRunner(row.project_id)
  }

  projectRunner(id: string): Runner {
    return normalizeRunner((this.db.prepare("SELECT runner FROM projects WHERE id = ?").get(id) as { runner: string | null } | undefined)?.runner)
  }

  /**
   * The SSH machines a task's turns run on (shared/machines.ts), by label or machine name; null: any machine. Its own
   * label goes with its own runs_on; a task that follows its project takes the project's.
   */
  taskMachineLabel(row: Pick<TaskRow, "project_id" | "runs_on" | "machine_label">): string | null {
    if (taskRunsOn(row)) return row.machine_label || null
    return (this.db.prepare("SELECT machine_label FROM projects WHERE id = ?").get(row.project_id) as { machine_label: string | null } | undefined)?.machine_label || null
  }

  findProject(idOrName: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ? OR name = ? COLLATE NOCASE")
      .get(idOrName, idOrName) as ProjectRow | undefined
    return row ? this.projectFromRow(row) : null
  }

  projectEnv(id: string): Record<string, string> {
    const row = this.db.prepare("SELECT env_json FROM projects WHERE id = ?").get(id) as { env_json: string } | undefined
    return json(row?.env_json, {})
  }

  createProject(input: {
    id?: string
    name: string
    description?: string
    repo?: string | null
    baseBranch?: string
    env?: Record<string, string>
    boxSize?: BoxSize | null
    partialClone?: boolean | null
    pushAtTurnEnd?: boolean | null
    depCache?: boolean | null
    closeIssuesOnMerge?: boolean | null
    autoDoneOnMerge?: boolean | null
    runner?: Runner
    /** Runs on: SSH machine: the machines' label or name (Project.machineLabel). */
    machineLabel?: string | null
    agentsPerBox?: number | null
    wholeMachine?: boolean
    tasksPerBox?: number | null
    maxBoxes?: number | null
    gpuMaxHourlyUsd?: number | null
    gpuMachine?: Partial<ProjectGpuMachine>
    gpuProvider?: GpuProvider | null
    docker?: Partial<ProjectDocker>
    identityId?: string
    /** The CLI its new tasks run on; null/omitted uses Settings › Box agents. */
    agentCli?: AgentCli | null
    notesMaxCount?: number | null
    notesMaxTokens?: number | null
    color?: ProjectColor | null
  }): Project {
    const now = Date.now()
    const id = input.id ?? newId("prj")
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, repo, base_branch, env_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM projects), ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.description ?? "",
        normalizeRepo(input.repo),
        input.baseBranch?.trim() || "main",
        JSON.stringify(input.env ?? {}),
        now,
        now,
      )
    if (input.boxSize) this.db.prepare("UPDATE projects SET box_size = ? WHERE id = ?").run(input.boxSize, id)
    if (typeof input.partialClone === "boolean") this.db.prepare("UPDATE projects SET partial_clone = ? WHERE id = ?").run(input.partialClone ? 1 : 0, id)
    if (typeof input.pushAtTurnEnd === "boolean") this.db.prepare("UPDATE projects SET push_at_turn_end = ? WHERE id = ?").run(input.pushAtTurnEnd ? 1 : 0, id)
    if (typeof input.depCache === "boolean") this.db.prepare("UPDATE projects SET dep_cache = ? WHERE id = ?").run(input.depCache ? 1 : 0, id)
    this.setProjectMergeFollowUp(id, input)
    this.setRunner(id, input.runner, input.machineLabel)
    this.setProjectBoxLimits(id, input)
    this.setProjectNotesBudget(id, input)
    if (input.identityId) this.setProjectIdentity(id, input.identityId)
    if (input.agentCli) this.db.prepare("UPDATE projects SET agent_cli = ? WHERE id = ?").run(input.agentCli, id)
    if (input.color) this.db.prepare("UPDATE projects SET color = ? WHERE id = ?").run(input.color, id)
    return this.getProject(id)!
  }

  /** Give a project an identity (shared/identities.ts). The caller checks that its runner fits. */
  setProjectIdentity(id: string, identityId: string) {
    if (!this.db.prepare("SELECT 1 FROM identities WHERE id = ?").get(identityId)) throw new BadRequestError(`Identity ${identityId} not found`)
    this.db.prepare("UPDATE projects SET identity_id = ? WHERE id = ?").run(identityId, id)
  }

  updateProject(
    id: string,
    patch: {
      name?: string
      description?: string
      repo?: string | null
      baseBranch?: string
      env?: Record<string, string>
      removeEnv?: string[]
      /** null clears it (Settings → Worker size applies). */
      boxSize?: BoxSize | null
      /** null clears it (Settings → Partial clone mirrors applies). */
      partialClone?: boolean | null
      /** null clears it (Settings → Push at turn end applies). */
      pushAtTurnEnd?: boolean | null
      /** null clears it (Settings → Dependency cache applies). */
      depCache?: boolean | null
      /** null clears it (Settings › Close the issues it names applies). */
      closeIssuesOnMerge?: boolean | null
      /** null clears it (Settings › Done when its PR merges applies). */
      autoDoneOnMerge?: boolean | null
      /** Where its agents run: Upstash boxes or this computer (shared/runner.ts). */
      runner?: Runner
      /** Runs on: SSH machine: the machines' label or name; null: any machine. Cleared when it runs elsewhere. */
      machineLabel?: string | null
      /** null clears it (the box's own Agents per box applies). */
      agentsPerBox?: number | null
      /** Run alone on this computer (server/agentLimits.ts). */
      wholeMachine?: boolean
      /** null clears it (the box's own Resident tasks per box applies). */
      tasksPerBox?: number | null
      /** null clears it (only Settings › Max boxes applies). */
      maxBoxes?: number | null
      /** null clears it (Settings › RunPod GPU's per-project cap applies). */
      gpuMaxHourlyUsd?: number | null
      /** Each field: undefined leaves it, null clears it (Settings › RunPod GPU's applies). */
      gpuMachine?: Partial<ProjectGpuMachine>
      /** null clears it (Settings › Box providers › Default GPU cloud decides). */
      gpuProvider?: GpuProvider | null
      /** Each field: undefined leaves it, null clears it (Settings › Docker's image applies). */
      docker?: Partial<ProjectDocker>
      /** null clears it (Settings › Max notes applies). */
      notesMaxCount?: number | null
      /** null clears it (Settings › Notes token budget applies). */
      notesMaxTokens?: number | null
      /** Who acts for it (shared/identities.ts). The caller checks that its runner fits. */
      identityId?: string
      /** The CLI its new tasks run on; null clears it (Settings › Box agents applies). Its existing tasks keep theirs. */
      agentCli?: AgentCli | null
      /** Its colour (shared/projectColors.ts); null goes back to the one from its name. */
      color?: ProjectColor | null
      /** Its Captain's icon (shared/captainIcons.ts); null goes back to the default. */
      captainIcon?: CaptainIconId | null
    },
  ): Project {
    const current = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined
    if (!current) throw new NotFoundError(`Project ${id} not found`)
    const env = json<Record<string, string>>(current.env_json, {})
    Object.assign(env, patch.env ?? {})
    for (const k of patch.removeEnv ?? []) delete env[k]
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, repo = ?, base_branch = ?, env_json = ?, box_size = ?, partial_clone = ?, push_at_turn_end = ?, dep_cache = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.name?.trim() || current.name,
        patch.description ?? current.description,
        patch.repo === undefined ? current.repo : normalizeRepo(patch.repo),
        patch.baseBranch?.trim() || current.base_branch,
        JSON.stringify(env),
        patch.boxSize === undefined ? current.box_size : patch.boxSize,
        patch.partialClone === undefined ? current.partial_clone : patch.partialClone === null ? null : patch.partialClone ? 1 : 0,
        patch.pushAtTurnEnd === undefined ? current.push_at_turn_end : patch.pushAtTurnEnd === null ? null : patch.pushAtTurnEnd ? 1 : 0,
        patch.depCache === undefined ? (current.dep_cache ?? null) : patch.depCache === null ? null : patch.depCache ? 1 : 0,
        Date.now(),
        id,
      )
    this.setRunner(id, patch.runner, patch.machineLabel)
    this.setProjectBoxLimits(id, patch)
    this.setProjectNotesBudget(id, patch)
    this.setProjectMergeFollowUp(id, patch)
    if (patch.identityId) this.setProjectIdentity(id, patch.identityId)
    if (patch.agentCli !== undefined) this.db.prepare("UPDATE projects SET agent_cli = ? WHERE id = ?").run(patch.agentCli, id)
    if (patch.color !== undefined) this.db.prepare("UPDATE projects SET color = ? WHERE id = ?").run(patch.color, id)
    if (patch.captainIcon !== undefined) this.db.prepare("UPDATE projects SET captain_icon = ? WHERE id = ?").run(patch.captainIcon, id)
    return this.getProject(id)!
  }

  /** What a merged PR does in this project (server/mergeFollowUp.ts); undefined leaves a value as it is, null clears it (Settings applies). */
  private setProjectMergeFollowUp(id: string, m: { closeIssuesOnMerge?: boolean | null; autoDoneOnMerge?: boolean | null }) {
    const bit = (v: boolean | null) => (v === null ? null : v ? 1 : 0)
    if (m.closeIssuesOnMerge !== undefined) this.db.prepare("UPDATE projects SET close_issues_on_merge = ? WHERE id = ?").run(bit(m.closeIssuesOnMerge), id)
    if (m.autoDoneOnMerge !== undefined) this.db.prepare("UPDATE projects SET auto_done_on_merge = ? WHERE id = ?").run(bit(m.autoDoneOnMerge), id)
  }

  /** The box snapshot new boxes for the project start from; null clears it (they start cold). */
  setProjectSnapshot(id: string, snap: ProjectSnapshot | null): Project | null {
    this.db
      .prepare(
        `UPDATE projects SET snapshot_id = ?, snapshot_provider = ?, snapshot_size = ?, snapshot_box_id = ?, snapshot_bytes = ?, snapshot_at = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(snap?.id ?? null, snap?.provider ?? null, snap?.size ?? null, snap?.boxId ?? null, snap?.bytes ?? null, snap?.takenAt ?? null, Date.now(), id)
    return this.getProject(id)
  }

  /**
   * undefined leaves it as it is; "box" is stored as NULL, like a project from before the setting. The SSH machines'
   * label only means something while it runs on SSH machines, so another runner clears it.
   */
  private setRunner(id: string, v: Runner | undefined, machineLabel?: string | null) {
    if (v !== undefined) {
      const runner = normalizeRunner(v)
      this.db.prepare("UPDATE projects SET runner = ? WHERE id = ?").run(runner === "box" ? null : runner, id)
    }
    if (v === undefined && machineLabel === undefined) return
    const ssh = this.projectRunner(id) === "ssh"
    if (!ssh) this.db.prepare("UPDATE projects SET machine_label = NULL WHERE id = ?").run(id)
    else if (machineLabel !== undefined) this.db.prepare("UPDATE projects SET machine_label = ? WHERE id = ?").run(normalizeLabel(machineLabel), id)
  }

  /**
   * A project's own box limits; undefined leaves a value as it is, null clears it. Saving Agents per box also
   * clears the old heavy_tasks it replaced, so a cleared value really goes back to the global one.
   */
  private setProjectBoxLimits(
    id: string,
    b: Partial<ProjectBoxLimits> & { gpuMaxHourlyUsd?: number | null; gpuMachine?: Partial<ProjectGpuMachine>; gpuProvider?: GpuProvider | null; docker?: Partial<ProjectDocker> },
  ) {
    if (b.agentsPerBox !== undefined) this.db.prepare("UPDATE projects SET agents_per_box = ?, heavy_tasks = NULL WHERE id = ?").run(b.agentsPerBox, id)
    if (b.wholeMachine !== undefined) this.db.prepare("UPDATE projects SET whole_machine = ? WHERE id = ?").run(b.wholeMachine ? 1 : 0, id)
    if (b.tasksPerBox !== undefined) this.db.prepare("UPDATE projects SET tasks_per_box = ? WHERE id = ?").run(b.tasksPerBox, id)
    if (b.maxBoxes !== undefined) this.db.prepare("UPDATE projects SET max_boxes = ? WHERE id = ?").run(b.maxBoxes, id)
    if (b.gpuMaxHourlyUsd !== undefined) this.db.prepare("UPDATE projects SET gpu_max_hourly_usd = ? WHERE id = ?").run(b.gpuMaxHourlyUsd, id)
    const m = b.gpuMachine ?? {}
    if (m.gpuTypes !== undefined) this.db.prepare("UPDATE projects SET gpu_types_json = ? WHERE id = ?").run(m.gpuTypes?.length ? JSON.stringify(m.gpuTypes) : null, id)
    if (m.cloud !== undefined) this.db.prepare("UPDATE projects SET gpu_cloud = ? WHERE id = ?").run(m.cloud, id)
    if (m.minRamGb !== undefined) this.db.prepare("UPDATE projects SET gpu_min_ram_gb = ? WHERE id = ?").run(m.minRamGb, id)
    if (m.minVcpus !== undefined) this.db.prepare("UPDATE projects SET gpu_min_vcpus = ? WHERE id = ?").run(m.minVcpus, id)
    if (b.gpuProvider !== undefined) this.db.prepare("UPDATE projects SET gpu_provider = ? WHERE id = ?").run(b.gpuProvider, id)
    const d = b.docker ?? {}
    if (d.image !== undefined) this.db.prepare("UPDATE projects SET docker_image = ? WHERE id = ?").run(d.image?.trim() || null, id)
    if (d.dockerfile !== undefined) this.db.prepare("UPDATE projects SET docker_dockerfile = ? WHERE id = ?").run(d.dockerfile?.trim() ? d.dockerfile : null, id)
  }

  /** A Docker project's own image (Project.docker), without loading the rest. */
  projectDocker(id: string): ProjectDocker {
    const row = this.db.prepare("SELECT docker_image, docker_dockerfile FROM projects WHERE id = ?").get(id) as ProjectRow | undefined
    return { image: row?.docker_image || null, dockerfile: row?.docker_dockerfile || null }
  }

  /** A project's own notes budget; undefined leaves a value as it is, null clears it. */
  private setProjectNotesBudget(id: string, b: { notesMaxCount?: number | null; notesMaxTokens?: number | null }) {
    if (b.notesMaxCount !== undefined) this.db.prepare("UPDATE projects SET notes_max_count = ? WHERE id = ?").run(b.notesMaxCount, id)
    if (b.notesMaxTokens !== undefined) this.db.prepare("UPDATE projects SET notes_max_tokens = ? WHERE id = ?").run(b.notesMaxTokens, id)
  }

  /**
   * Put every project in this order, in one transaction. `ids` must name each project exactly once,
   * so a list from a stale tab (missing a new project, or naming a deleted one) is refused rather than half-applied.
   */
  reorderProjects(ids: string[]): Project[] {
    this.db.transaction(() => {
      const known = (this.db.prepare("SELECT id FROM projects").all() as { id: string }[]).map((r) => r.id)
      const knownSet = new Set(known)
      const seen = new Set<string>()
      for (const id of ids) {
        if (seen.has(id)) throw new BadRequestError(`Project ${id} is listed twice`)
        seen.add(id)
      }
      const unknown = ids.filter((id) => !knownSet.has(id))
      if (unknown.length) throw new BadRequestError(`Unknown project${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`)
      const missing = known.filter((id) => !seen.has(id))
      if (missing.length) throw new BadRequestError(`The order must list every project; missing ${missing.join(", ")}`)
      const stmt = this.db.prepare("UPDATE projects SET sort_order = ? WHERE id = ?")
      ids.forEach((id, i) => stmt.run(i, id))
    })()
    return this.listProjects()
  }

  /** Its icon's file name (server/projectIcons.ts), or null for its coloured letter. */
  getProjectIcon(id: string): string | null {
    return (this.db.prepare("SELECT icon FROM projects WHERE id = ?").get(id) as { icon: string | null } | undefined)?.icon ?? null
  }

  /** Sets (a file name) or takes off (null) its icon. */
  setProjectIcon(id: string, icon: string | null): Project {
    const r = this.db.prepare("UPDATE projects SET icon = ?, updated_at = ? WHERE id = ?").run(icon, Date.now(), id)
    if (!r.changes) throw new NotFoundError(`Project ${id} not found`)
    return this.getProject(id)!
  }

  deleteProject(id: string) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id)
    // Its Captain's login in the rotation (AgentLogins).
    this.db.prepare("DELETE FROM agent_login_holds WHERE holder = ?").run(`captain:${id}`)
  }

  listNotes(projectId: string): ProjectNote[] {
    const rows = this.db.prepare("SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at ASC, rowid ASC").all(projectId) as NoteRow[]
    return rows.map(noteFromRow)
  }

  getNote(id: string): ProjectNote | null {
    const row = this.db.prepare("SELECT * FROM project_notes WHERE id = ?").get(id) as NoteRow | undefined
    return row ? noteFromRow(row) : null
  }

  addNote(projectId: string, author: string, content: string): ProjectNote {
    const now = Date.now()
    const note: ProjectNote = { id: newId("note"), projectId, author, content: content.trim(), createdAt: now, updatedAt: now, updatedBy: null }
    this.db
      .prepare("INSERT INTO project_notes (id, project_id, author, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(note.id, projectId, author, note.content, now, now)
    return note
  }

  updateNote(id: string, content: string, by: string): ProjectNote {
    const res = this.db.prepare("UPDATE project_notes SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(content.trim(), Date.now(), by, id)
    if (!res.changes) throw new NotFoundError(`Note ${id} not found`)
    return this.getNote(id)!
  }

  deleteNote(id: string) {
    this.db.prepare("DELETE FROM project_notes WHERE id = ?").run(id)
  }

  // ---------- note suggestions ----------

  addNoteSuggestion(input: { projectId: string; taskId: string | null; taskTitle: string; content: string; why: string }): NoteSuggestion {
    const s: NoteSuggestion = {
      id: newId("sug"),
      projectId: input.projectId,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      content: input.content.trim(),
      why: input.why.trim(),
      status: "pending",
      noteId: null,
      resolvedBy: null,
      reason: null,
      createdAt: Date.now(),
      resolvedAt: null,
      retroAt: null,
    }
    this.db
      .prepare("INSERT INTO note_suggestions (id, project_id, task_id, task_title, content, why, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(s.id, s.projectId, s.taskId, s.taskTitle, s.content, s.why, s.createdAt)
    return s
  }

  getNoteSuggestion(id: string): NoteSuggestion | null {
    const row = this.db.prepare("SELECT * FROM note_suggestions WHERE id = ?").get(id) as SuggestionRow | undefined
    return row ? suggestionFromRow(row) : null
  }

  /** Oldest first. `unsent` keeps only the ones no retro has handed to the Captain yet. */
  listNoteSuggestions(filter: { projectId?: string; taskId?: string; status?: NoteSuggestionStatus[]; unsent?: boolean; limit?: number } = {}): NoteSuggestion[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.projectId) where.push("project_id = ?"), args.push(filter.projectId)
    if (filter.taskId) where.push("task_id = ?"), args.push(filter.taskId)
    if (filter.status?.length) where.push(`status IN (${filter.status.map(() => "?").join(", ")})`), args.push(...filter.status)
    if (filter.unsent) where.push("retro_at IS NULL")
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM note_suggestions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?)
         ORDER BY created_at ASC, rid ASC`,
      )
      .all(...args, filter.limit ?? 500) as SuggestionRow[]
    return rows.map(suggestionFromRow)
  }

  pendingSuggestionCount(projectId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM note_suggestions WHERE project_id = ? AND status = 'pending'").get(projectId) as { n: number }).n
  }

  /** Settle a pending suggestion. Throws a ConflictError when someone already did. */
  resolveNoteSuggestion(id: string, r: { status: Exclude<NoteSuggestionStatus, "pending">; noteId?: string | null; by: string; reason?: string | null }): NoteSuggestion {
    const res = this.db
      .prepare("UPDATE note_suggestions SET status = ?, note_id = ?, resolved_by = ?, reason = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(r.status, r.noteId ?? null, r.by, r.reason?.trim() || null, Date.now(), id)
    const s = this.getNoteSuggestion(id)
    if (!s) throw new NotFoundError(`Suggestion ${id} not found`)
    if (!res.changes) throw new ConflictError(`Suggestion ${id} was already ${s.status}${s.resolvedBy ? ` by ${s.resolvedBy}` : ""}.`)
    return s
  }

  /** A retro handed these suggestions to the Captain. */
  markSuggestionsInRetro(ids: string[], at = Date.now()) {
    const stmt = this.db.prepare("UPDATE note_suggestions SET retro_at = ? WHERE id = ? AND retro_at IS NULL")
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, id)
    })()
  }

  // ---------- tasks ----------

  /** taskFromRow's lookups for these rows, each one statement over all their ids (see TaskLookups). */
  private taskLookups(rows: Pick<TaskRow, "id">[]): TaskLookups {
    // A list passes its ids as a JSON array; one task (getTask) by id, which compiles and runs faster.
    const [scope, arg] = rows.length === 1 ? ["task_id = ?", rows[0]!.id] : ["task_id IN (SELECT value FROM json_each(?))", JSON.stringify(rows.map((r) => r.id))]
    const pending = new Map(
      (
        this.db
          .prepare(
            `SELECT task_id, COUNT(*) AS n, COALESCE(SUM(version), 0) AS v, COALESCE(SUM(status = 'delivering'), 0) AS d, COALESCE(MAX(updated_at), 0) AS t
             FROM task_inputs WHERE ${scope} AND status != 'cancelled' GROUP BY task_id`,
          )
          .all(arg) as ({ task_id: string } & typeof NO_PENDING)[]
      ).map(({ task_id, ...p }) => [task_id, p]),
    )
    // Read from the claude_usage_task_spend index alone.
    const spend = new Map(
      (
        this.db
          .prepare(`SELECT task_id, COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(SUM(total_tokens), 0) AS totalTokens FROM claude_usage WHERE ${scope} GROUP BY task_id`)
          .all(arg) as ({ task_id: string } & typeof NO_SPEND)[]
      ).map(({ task_id, ...s }) => [task_id, s]),
    )
    let activity: ReturnType<DB["prepare"]> | undefined
    const runners = new Map<string, Runner>()
    return {
      pending: (id) => pending.get(id) ?? NO_PENDING,
      spend: (id) => spend.get(id) ?? NO_SPEND,
      activity: (id) => activityOf((activity ??= this.db.prepare(ACTIVITY_SQL)).all(id)),
      runner: (projectId) => {
        if (!runners.has(projectId)) runners.set(projectId, this.projectRunner(projectId))
        return runners.get(projectId)!
      },
    }
  }

  taskFromRow(row: TaskRow, lookups: TaskLookups = this.taskLookups([row])): Task {
    const pending = lookups.pending(row.id)
    const usage = lookups.spend(row.id)
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      prompt: row.prompt,
      status: row.status,
      boxId: row.box_id,
      sessionId: row.session_id,
      branch: row.branch,
      prUrl: row.pr_url,
      prState: row.pr_state ?? null,
      prMergedAt: row.pr_merged_at ?? null,
      prMergedBy: row.pr_merged_by ?? null,
      previews: json<PreviewLink[]>(row.previews_json, []),
      question: row.question,
      summary: row.summary,
      activity: row.summary === null ? lookups.activity(row.id) : null,
      error: row.error,
      limitWait: row.status === "failed" ? (this.turnFlags(row).limitWait ?? null) : null,
      waitReason: row.status === "queued" ? (row.wait_reason ?? null) : null,
      waitBoxSize: row.status === "queued" && row.wait_reason && row.wait_box_size ? normalizeBoxSize(row.wait_box_size) : null,
      waitFor: row.status === "queued" && row.wait_reason ? json<WaitFor[]>(row.wait_for_json ?? null, []) : [],
      waitFix: row.status === "queued" && row.wait_reason && (WAIT_FIXES as readonly string[]).includes(row.wait_fix ?? "") ? (row.wait_fix as WaitFix) : null,
      turnCount: row.turn_count,
      turnStartedAt: row.current_turn_id ? this.turnStartedAt(row.current_turn_id) : null,
      pendingCount: pending.n,
      queueRev: pending.n ? `${pending.n}.${pending.v}.${pending.d}.${pending.t}` : "",
      lastArchivedAt: row.last_archived_at,
      scheduleId: row.schedule_id ?? null,
      startedBy: row.source ?? null,
      outcome: parseOutcome(row.outcome),
      contextTokens: row.context_tokens ?? null,
      contextWindow: row.context_window ?? null,
      compactPending: Boolean(row.compact_pending),
      compacting: Boolean(row.compacting),
      agentCli: taskAgentCli(row),
      model: row.model ?? null,
      effort: row.effort ?? null,
      claudeCostUsd: usage.costUsd,
      claudeTokens: usage.totalTokens,
      routingRule: row.routing_rule ?? null,
      routingReason: row.routing_reason ?? null,
      runsOn: taskRunsOn(row),
      boxSize: row.box_size ? normalizeBoxSize(row.box_size) : null,
      machineLabel: row.machine_label || null,
      gpu: taskGpuPick(row),
      placement: this.taskPlacement(row, lookups.runner(row.project_id)),
      mergeRequest: publicMergeRequest(this.mergeRequestOf(row)),
      pushState: json<PushState | null>(row.push_state_json, null),
      icon: isTaskIcon(row.icon) ? row.icon : null,
      batchId: row.batch_id ?? null,
      priority: parsePriority(row.priority),
      stayOpenOnMerge: row.stay_open_on_merge === 1,
      parentTaskId: row.parent_task_id ?? null,
      rootTaskId: row.root_task_id ?? null,
      subtaskDepth: row.subtask_depth ?? 0,
      withParent: row.with_parent === 1,
      lastActiveAt: row.last_active_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** A box as Task.placement shows it: its kind, and for worker boxes who made it and its size. */
  placeOf(boxId: string): Place {
    const kind = placeKindOf(boxId)
    const place: Place = { kind, boxId }
    if (kind === "box") {
      const box = this.db.prepare("SELECT provider, size FROM boxes WHERE id = ?").get(boxId) as { provider: string; size: string } | undefined
      if (box) {
        place.provider = box.provider
        place.size = normalizeBoxSize(box.size)
      }
    }
    return { ...place, ...this.placeExtra?.(boxId) }
  }

  /** Where a task runs now, where it last ran, and where its next turn goes (shared/placement.ts). */
  taskPlacement(row: TaskRow, projectRunner = this.projectRunner(row.project_id)): TaskPlacement {
    const own = taskRunsOn(row)
    return {
      now: row.box_id ? { ...this.placeOf(row.box_id), ...(isBoxPick(row.placed_how) ? { how: row.placed_how } : {}) } : null,
      last: row.box_id ? null : json<(Place & { leftAt: number }) | null>(row.last_place_json ?? null, null),
      runner: own ?? projectRunner,
      chosenBy: own ? "task" : "project",
      projectRunner,
      ...((own ?? projectRunner) === "ssh" ? { machineLabel: this.taskMachineLabel(row) } : {}),
    }
  }

  /**
   * The task's merge request while it is still pending: for the PR the task has now, and either delivered in a
   * turn or still queued (Stop and Close drop queued messages, and the request with them).
   */
  mergeRequestOf(row: TaskRow): StoredMergeRequest | null {
    const req = json<StoredMergeRequest | null>(row.merge_request_json, null)
    if (!req || req.prUrl !== row.pr_url) return null
    if (req.deliveredAt === null && !this.db.prepare("SELECT 1 FROM task_inputs WHERE id = ? AND status != 'cancelled'").get(req.inputId)) return null
    return req
  }

  /** What Mark done closed a task from, when it's still done from that close (TaskRow.done_from_json). */
  doneFromOf(row: Pick<TaskRow, "status" | "done_from_json">): DoneFrom | null {
    if (row.status !== "done") return null
    const from = json<Partial<DoneFrom> | null>(row.done_from_json ?? null, null)
    if (!from || !(TASK_STATUSES as readonly string[]).includes(from.status ?? "")) return null
    return { status: from.status!, question: typeof from.question === "string" ? from.question : null, parent: typeof from.parent === "string" ? from.parent : null }
  }

  getTaskRow(id: string): TaskRow | null {
    return (this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null
  }

  getTask(id: string): Task | null {
    const row = this.getTaskRow(id)
    return row ? this.taskFromRow(row) : null
  }

  listTasks(filter: { projectId?: string; status?: TaskStatus[] } = {}): Task[] {
    const rows = this.listTaskRows(filter)
    const lookups = this.taskLookups(rows)
    return rows.map((r) => this.taskFromRow(r, lookups))
  }

  listTaskRows(filter: { projectId?: string; status?: TaskStatus[]; boxId?: string } = {}): TaskRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.projectId) {
      where.push("project_id = ?")
      args.push(filter.projectId)
    }
    if (filter.boxId) {
      where.push("box_id = ?")
      args.push(filter.boxId)
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`)
      args.push(...filter.status)
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`
    return this.db.prepare(sql).all(...args) as TaskRow[]
  }

  /** Tasks whose pull request may still change: it has a URL and isn't merged or closed yet. */
  listOpenPrRows(ids?: string[]): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE pr_url IS NOT NULL AND pr_url != '' AND (pr_state IS NULL OR pr_state IN ('open', 'draft')) ORDER BY created_at ASC")
      .all() as TaskRow[]
    return ids ? rows.filter((r) => ids.includes(r.id)) : rows
  }

  /** Every pull request a task opened (its "Opened pull request" events), oldest first; its current one included. */
  taskPrUrls(taskId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT json_extract(meta_json, '$.url') AS url FROM task_messages WHERE task_id = ? AND role = 'event' AND json_extract(meta_json, '$.kind') = 'pr' ORDER BY created_at ASC",
      )
      .all(taskId) as { url: unknown }[]
    return rows.map((r) => r.url).filter((u): u is string => typeof u === "string" && u.length > 0)
  }

  /** A merged PR whose named issues are still to be closed (server/mergeFollowUp.ts). Queuing one twice keeps the first. */
  queueIssueClose(prUrl: string, taskId: string) {
    this.db.prepare("INSERT OR IGNORE INTO pr_issue_closes (pr_url, task_id, created_at) VALUES (?, ?, ?)").run(prUrl, taskId, Date.now())
  }

  /** The queued issue closes due by `now`, oldest first. */
  dueIssueCloses(now = Date.now()): { prUrl: string; taskId: string; attempts: number }[] {
    return (
      this.db.prepare("SELECT pr_url, task_id, attempts FROM pr_issue_closes WHERE retry_at <= ? ORDER BY created_at ASC").all(now) as {
        pr_url: string
        task_id: string
        attempts: number
      }[]
    ).map((r) => ({ prUrl: r.pr_url, taskId: r.task_id, attempts: r.attempts }))
  }

  /** A try that failed for now: try again at `retryAt`. */
  retryIssueClose(prUrl: string, retryAt: number) {
    this.db.prepare("UPDATE pr_issue_closes SET attempts = attempts + 1, retry_at = ? WHERE pr_url = ?").run(retryAt, prUrl)
  }

  /** Handled (or given up on): it leaves the queue. */
  finishIssueClose(prUrl: string) {
    this.db.prepare("DELETE FROM pr_issue_closes WHERE pr_url = ?").run(prUrl)
  }

  createTask(input: {
    id?: string
    projectId: string
    title: string
    prompt: string
    env?: Record<string, string>
    branch?: string | null
    scheduleId?: string | null
    model?: string | null
    effort?: Effort | null
    routingRule?: string | null
    routingReason?: string | null
    /** Who started it (TaskRow.source). */
    startedBy?: string | null
    /** Its own runner over the project's (TaskRow.runs_on); omitted follows the project. */
    runsOn?: Runner | null
    boxSize?: BoxSize | null
    /** With runsOn "ssh": the SSH machines it runs on, by label or name (TaskRow.machine_label). */
    machineLabel?: string | null
    /** With runsOn "gpu": its own cloud and GPU (TaskRow.gpu_provider, gpu_type). */
    gpu?: GpuPick | null
    /** The CLI its agent starts on (TaskRow.agent_cli); omitted: Claude Code. */
    agentCli?: AgentCli | null
    /** Its icon (shared/taskIcons.ts); omitted picks one from its title. */
    icon?: TaskIconName | null
    /** The create_tasks call it came from (TaskRow.batch_id), when that started more than one. */
    batchId?: string | null
    /** "high" jumps the queue (shared/priority.ts); omitted is normal. */
    priority?: TaskPriority | null
    /** Never moved to done when its PR merges (TaskRow.stay_open_on_merge). */
    stayOpenOnMerge?: boolean
    /** A sub-task's place in its tree (TaskRow.parent_task_id, root_task_id, subtask_depth, with_parent). */
    subtask?: { parentId: string; rootId: string; depth: number; withParent: boolean } | null
  }): Task {
    if (this.projectDeletionPending(input.projectId)) throw new ConflictError("This project is being deleted; wait for deletion to finish.")
    if (input.subtask) this.assertTaskNotDeleting(input.subtask.parentId)
    const now = Date.now()
    const id = input.id ?? newId("task")
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, prompt, status, session_id, branch, env_json, schedule_id, model, effort, routing_rule, routing_reason, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.title.trim(),
        input.prompt,
        randomUUID(),
        input.branch ?? null,
        JSON.stringify(input.env ?? {}),
        input.scheduleId ?? null,
        input.model ?? null,
        input.effort ?? null,
        input.routingRule ?? null,
        input.routingReason ?? null,
        now,
        now,
        now,
      )
    // Its own statement, so the insert above also works on schemas from before the column (migration tests).
    if (input.startedBy) this.db.prepare("UPDATE tasks SET source = ? WHERE id = ?").run(input.startedBy, id)
    if (input.runsOn) this.db.prepare("UPDATE tasks SET runs_on = ? WHERE id = ?").run(input.runsOn, id)
    if (input.runsOn === "ssh" && normalizeLabel(input.machineLabel)) this.db.prepare("UPDATE tasks SET machine_label = ? WHERE id = ?").run(normalizeLabel(input.machineLabel), id)
    if (input.runsOn === "gpu" && input.gpu) this.db.prepare("UPDATE tasks SET gpu_provider = ?, gpu_type = ? WHERE id = ?").run(input.gpu.provider, input.gpu.type, id)
    if (input.runsOn === "gpu" && input.gpu?.size) this.db.prepare("UPDATE tasks SET gpu_size = ? WHERE id = ?").run(input.gpu.size, id)
    if (input.runsOn === "box" && input.boxSize) this.db.prepare("UPDATE tasks SET box_size = ? WHERE id = ?").run(input.boxSize, id)
    if (input.agentCli) this.db.prepare("UPDATE tasks SET agent_cli = ? WHERE id = ?").run(input.agentCli, id)
    if (input.icon) this.setTaskIcon(id, input.icon)
    if (input.batchId) this.db.prepare("UPDATE tasks SET batch_id = ? WHERE id = ?").run(input.batchId, id)
    if (input.priority === "high") this.db.prepare("UPDATE tasks SET priority = 'high' WHERE id = ?").run(id)
    if (input.stayOpenOnMerge) this.db.prepare("UPDATE tasks SET stay_open_on_merge = 1 WHERE id = ?").run(id)
    if (input.subtask) {
      const { parentId, rootId, depth, withParent } = input.subtask
      this.db.prepare("UPDATE tasks SET parent_task_id = ?, root_task_id = ?, subtask_depth = ?, with_parent = ? WHERE id = ?").run(parentId, rootId, depth, withParent ? 1 : 0, id)
    }
    return this.getTask(id)!
  }

  /** A task's icon (shared/taskIcons.ts); null goes back to the one from its title. */
  setTaskIcon(id: string, icon: TaskIconName | null) {
    this.db.prepare("UPDATE tasks SET icon = ? WHERE id = ?").run(icon, id)
  }

  startTaskTurn(input: {
    id: string
    taskId: string
    turnIndex: number
    model: string | null
    effort: Effort | null
    routingRule: string | null
    routingReason: string | null
    status?: string
    trigger?: TurnTrigger | null
    /** The login it runs on (server/agentLogins.ts). */
    loginId?: string | null
    /** The box it runs on, for splitting box cost between tasks (server/usageLedger.ts). */
    boxId?: string | null
  }) {
    this.db
      .prepare(
        `INSERT INTO task_turns (id, task_id, turn_index, model, effort, routing_rule, routing_reason, status, started_at, trigger, login_id, box_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           model = excluded.model,
           effort = excluded.effort,
           routing_rule = excluded.routing_rule,
           routing_reason = excluded.routing_reason,
           status = excluded.status,
           trigger = excluded.trigger,
           login_id = excluded.login_id,
           box_id = excluded.box_id`,
      )
      .run(input.id, input.taskId, input.turnIndex, input.model, input.effort, input.routingRule, input.routingReason, input.status ?? "started", Date.now(), input.trigger ?? null, input.loginId ?? null, input.boxId ?? null)
  }

  finishTaskTurn(id: string, patch: { status: string; costUsd?: number | null; error?: string | null }) {
    this.db
      .prepare("UPDATE task_turns SET status = ?, finished_at = ?, cost_usd = ?, error = ? WHERE id = ?")
      .run(patch.status, Date.now(), patch.costUsd ?? null, patch.error ?? null, id)
  }

  /** When the task's last turn ended (null before its first). */
  lastTurnFinishedAt(taskId: string): number | null {
    const row = this.db.prepare("SELECT MAX(finished_at) AS at FROM task_turns WHERE task_id = ?").get(taskId) as { at: number | null }
    return row.at ?? null
  }

  /** When this turn started; null before its ledger row is written. */
  turnStartedAt(turnId: string): number | null {
    const row = this.db.prepare("SELECT started_at FROM task_turns WHERE id = ?").get(turnId) as { started_at: number } | undefined
    return row?.started_at ?? null
  }

  /** When the task's last turn started (null before its first). */
  lastTurnStartedAt(taskId: string): number | null {
    const row = this.db.prepare("SELECT MAX(started_at) AS at FROM task_turns WHERE task_id = ?").get(taskId) as { at: number | null }
    return row.at ?? null
  }

  getTaskTurn(id: string): TaskTurnRow | null {
    return (this.db.prepare("SELECT * FROM task_turns WHERE id = ?").get(id) as TaskTurnRow | undefined) ?? null
  }

  listTaskTurns(taskId: string): TaskTurnRow[] {
    return this.db.prepare("SELECT * FROM task_turns WHERE task_id = ? ORDER BY started_at ASC").all(taskId) as TaskTurnRow[]
  }

  taskEnv(id: string): Record<string, string> {
    const row = this.db.prepare("SELECT env_json FROM tasks WHERE id = ?").get(id) as { env_json: string } | undefined
    return json(row?.env_json, {})
  }

  turnFlags(row: TaskRow): TurnFlags {
    return json<TurnFlags>(row.turn_flags_json, {})
  }

  /**
   * `quiet` skips the notification for a status change Cody caused themselves (stop, close).
   * Compaction turns never notify: they hand back the status from before the compaction.
   * `touch: false` keeps updated_at (the "last active" time) as it was.
   */
  updateTask(id: string, patch: TaskPatch, opts: { quiet?: boolean; touch?: boolean } = {}): Task {
    if (patch.currentTurnId || patch.compactPending || patch.compacting || (patch.status && ["queued", "starting", "working"].includes(patch.status))) this.assertTaskNotDeleting(id)
    const before =
      patch.status !== undefined && !opts.quiet
        ? (this.db.prepare("SELECT status, compacting FROM tasks WHERE id = ?").get(id) as { status: TaskStatus; compacting: number } | undefined)
        : undefined
    const sets: string[] = []
    const args: unknown[] = []
    if (patch.boxId !== undefined) {
      const was = (this.db.prepare("SELECT box_id FROM tasks WHERE id = ?").get(id) as { box_id: string | null } | undefined)?.box_id
      // A box letting the task go: remember where it ran, so a resting, archived task still says where (Task.placement.last).
      if (patch.boxId === null && was) {
        sets.push("last_place_json = ?")
        args.push(JSON.stringify({ ...this.placeOf(was), leftAt: Date.now() }))
      }
      // How its box was picked is about that box only.
      if (patch.placedHow === undefined && was !== patch.boxId) sets.push("placed_how = NULL")
    }
    for (const [key, value] of Object.entries(patch) as [keyof TaskPatch, unknown][]) {
      if (value === undefined) continue
      sets.push(`${TASK_COLUMNS[key]} = ?`)
      if (key === "previews" || key === "turnFlags" || key === "prLabels") args.push(JSON.stringify(value))
      else if (key === "waitFor") args.push((value as WaitFor[]).length ? JSON.stringify(value) : null)
      else if (key === "mergeRequest" || key === "pushState" || key === "doneFrom") args.push(value === null ? null : JSON.stringify(value))
      else if (key === "sessionStarted" || key === "compactPending" || key === "compacting" || key === "stayOpenOnMerge") args.push(value ? 1 : 0)
      else if (key === "priority") args.push(value === "high" ? "high" : null)
      else args.push(value)
    }
    // Out of done any other way than Reopen (a message picked it up): what Mark done closed it from is history now.
    if (patch.status !== undefined && patch.status !== "done" && patch.doneFrom === undefined) sets.push("done_from_json = NULL")
    if (opts.touch !== false) {
      sets.push("updated_at = ?")
      args.push(Date.now())
    }
    if (!sets.length) sets.push("id = id")
    args.push(id)
    const res = this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args)
    if (res.changes === 0) throw new NotFoundError(`Task ${id} not found`)
    const task = this.getTask(id)!
    if (before && !before.compacting && shouldNotify(before.status, task.status) && !isQuietRun(task)) this.addNotification(task)
    return task
  }

  /**
   * Agent slots in use on a box: turns that hold a turn id, plus any task starting or working there (a turn
   * id that isn't written yet, or a launch that outlived it, still runs an agent). `except` leaves one task out.
   */
  /** Docker containers' boxes (`docker-…`) with a turn on them or starting. */
  dockerBoxesInUse(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT box_id FROM tasks WHERE box_id LIKE 'docker-%' AND (current_turn_id IS NOT NULL OR status IN ('starting', 'working'))`)
      .all() as { box_id: string }[]
    return rows.map((r) => r.box_id)
  }

  /** GPU boxes (`runpod-…`, `vastai-…`, `daytona-…`) with a turn on them: pods, instances and sandboxes that are up or starting. */
  gpuBoxesInUse(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT box_id FROM tasks WHERE (box_id LIKE 'runpod-%' OR box_id LIKE 'vastai-%' OR box_id LIKE 'daytona-%') AND (current_turn_id IS NOT NULL OR status IN ('starting', 'working'))`)
      .all() as { box_id: string }[]
    return rows.map((r) => r.box_id)
  }

  slotsInUse(boxId: string, except?: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE box_id = ? AND id != ? AND (current_turn_id IS NOT NULL OR status IN ('starting', 'working'))`)
      .get(boxId, except ?? "") as { n: number }
    return row.n
  }

  /** The agents running on a box (or this computer), oldest task first, with their projects' limits (server/agentLimits.ts). */
  boxAgents(boxId: string, except?: string): BoxAgent[] {
    return this.boxAgentRows(
      "t.box_id = ? AND t.id != ? AND (t.current_turn_id IS NOT NULL OR t.status IN ('starting', 'working')) ORDER BY t.created_at ASC, t.rowid ASC",
      boxId,
      except ?? "",
    )
  }

  /** A task as server/agentLimits.ts weighs it, wherever it is now. */
  boxAgent(taskId: string): BoxAgent | null {
    return this.boxAgentRows("t.id = ?", taskId)[0] ?? null
  }

  private boxAgentRows(where: string, ...args: unknown[]): BoxAgent[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.title, t.project_id, p.name, ${AGENTS_PER_BOX} AS agents, p.whole_machine AS whole
         FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${where}`,
      )
      .all(...args) as { id: string; title: string; project_id: string; name: string; agents: number | null; whole: number | null }[]
    return rows.map((r) => ({ taskId: r.id, title: r.title, projectId: r.project_id, projectName: r.name, agentsPerBox: r.agents ?? null, wholeMachine: r.whole === 1 }))
  }

  /**
   * The one way a turn starts: check that `boxId` has a free slot (`slots`) that the projects' own limits let the
   * task take (its project's Agents at once, Needs the whole machine: server/agentLimits.ts) and claim it, in one
   * write transaction (BEGIN IMMEDIATE), so two starts in the same tick, or two servers on one database, can't both
   * take the last slot. Refused (false) when the box is full, a limit holds it back or the task already has a turn;
   * nothing changes then.
   */
  claimTurnSlot(taskId: string, boxId: string, slots: number, patch: TaskPatch): boolean {
    if (this.taskDeletionPending(taskId)) return false
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT current_turn_id, status FROM tasks WHERE id = ?").get(taskId) as { current_turn_id: string | null; status: TaskStatus } | undefined
      if (!row || row.current_turn_id || row.status === "starting" || row.status === "working") return false
      // The box's slots (Settings › Local agents on this computer), and the projects' own limits (server/agentLimits.ts).
      const agent = this.boxAgent(taskId)
      const running = this.boxAgents(boxId, taskId)
      // Infinity: a sub-task in its parent's slot (TaskManager.parentBox), which no box or project limit holds back.
      if (!agent || (slots !== Infinity && (running.length >= slots || limitBlock(agent, running)))) return false
      this.updateTask(taskId, { ...patch, boxId })
      return true
    }).immediate()
  }

  deleteTask(id: string) {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
  }

  /** A task's sub-tasks (its direct children), oldest first (server/subtasks.ts). */
  subtaskRows(parentId: string): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC, rowid ASC").all(parentId) as TaskRow[]
  }

  // ---------- compaction history ----------

  private compactionTaskFromRow(r: OrchestratorCompactionTaskRow): CompactionTaskSnapshot {
    return {
      taskId: r.task_id,
      title: r.title,
      status: r.status,
      projectId: r.project_id,
      projectName: r.project_name,
      branch: r.branch,
      prUrl: r.pr_url,
      sessionId: r.session_id,
      summary: r.summary,
      lastActiveAt: r.last_active_at,
    }
  }

  private taskRowsForCompaction(id: string): CompactionTaskSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestrator_compaction_tasks WHERE compaction_id = ? ORDER BY last_active_at DESC, task_id ASC")
      .all(id) as OrchestratorCompactionTaskRow[]
    return rows.map((r) => this.compactionTaskFromRow(r))
  }

  private orchestratorCompactionFromRow(row: OrchestratorCompactionRow, includeMarkdown = false, includeTasks = true): OrchestratorCompactionRecord {
    const tasks = includeTasks ? this.taskRowsForCompaction(row.id) : []
    return {
      id: row.id,
      at: row.at,
      sessionId: row.session_id,
      model: row.model,
      trigger: row.trigger,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
      file: row.markdown_path,
      jsonFile: row.json_path,
      taskCount: row.task_count ?? tasks.length,
      tasks,
      ...(includeMarkdown ? { markdown: row.markdown } : {}),
    }
  }

  addOrchestratorCompaction(input: {
    id: string
    at: number
    sessionId: string
    model: string
    trigger: "button" | "auto"
    tokensBefore: number | null
    tokensAfter?: number | null
    markdownPath: string
    jsonPath: string
    markdown: string
    tasks: CompactionTaskSnapshot[]
  }): OrchestratorCompactionRecord {
    const now = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO orchestrator_compactions
           (id, at, session_id, model, trigger, tokens_before, tokens_after, markdown_path, json_path, markdown, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.at, input.sessionId, input.model, input.trigger, input.tokensBefore, input.tokensAfter ?? null, input.markdownPath, input.jsonPath, input.markdown, now)
      this.db.prepare("DELETE FROM orchestrator_compaction_tasks WHERE compaction_id = ?").run(input.id)
      const stmt = this.db.prepare(
        `INSERT INTO orchestrator_compaction_tasks
         (compaction_id, task_id, title, status, project_id, project_name, branch, pr_url, session_id, summary, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const t of input.tasks) {
        stmt.run(input.id, t.taskId, t.title, t.status, t.projectId, t.projectName, t.branch, t.prUrl, t.sessionId, t.summary, t.lastActiveAt)
      }
    })()
    return this.getOrchestratorCompaction(input.id, true)!
  }

  finishOrchestratorCompaction(id: string, tokensAfter: number | null, markdown?: string) {
    const sets = ["tokens_after = ?"]
    const args: unknown[] = [tokensAfter]
    if (markdown !== undefined) {
      sets.push("markdown = ?")
      args.push(markdown)
    }
    args.push(id)
    this.db.prepare(`UPDATE orchestrator_compactions SET ${sets.join(", ")} WHERE id = ?`).run(...args)
  }

  /** Newest first; `before` (ms) keeps those older than it, for paging. */
  listOrchestratorCompactions(filter: { taskId?: string; limit?: number; before?: number } = {}): OrchestratorCompactionRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
    const before = filter.before ?? Number.MAX_SAFE_INTEGER
    const rows = filter.taskId
      ? (this.db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM orchestrator_compaction_tasks ct WHERE ct.compaction_id = c.id) AS task_count
             FROM orchestrator_compactions c
             JOIN orchestrator_compaction_tasks ct ON ct.compaction_id = c.id
             WHERE ct.task_id = ? AND c.at < ?
             ORDER BY c.at DESC
             LIMIT ?`,
          )
          .all(filter.taskId, before, limit) as OrchestratorCompactionRow[])
      : (this.db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM orchestrator_compaction_tasks ct WHERE ct.compaction_id = c.id) AS task_count
             FROM orchestrator_compactions c
             WHERE c.at < ?
             ORDER BY c.at DESC
             LIMIT ?`,
          )
          .all(before, limit) as OrchestratorCompactionRow[])
    return rows.map((r) => this.orchestratorCompactionFromRow(r, false, true))
  }

  getOrchestratorCompaction(id: string, includeMarkdown = true): OrchestratorCompactionRecord | null {
    const row = this.db.prepare("SELECT * FROM orchestrator_compactions WHERE id = ?").get(id) as OrchestratorCompactionRow | undefined
    return row ? this.orchestratorCompactionFromRow(row, includeMarkdown, true) : null
  }

  private taskCompactionFromRow(r: TaskCompactionRow): TaskCompactionRecord {
    return {
      id: r.id,
      taskId: r.task_id,
      sessionId: r.session_id,
      at: r.at,
      statusBefore: r.status_before,
      statusAfter: r.status_after,
      tokensBefore: r.tokens_before,
      tokensAfter: r.tokens_after,
      summary: r.summary,
      archivePath: r.archive_path,
      archiveAvailable: Boolean(r.archive_available),
      archiveNote: r.archive_note,
    }
  }

  addTaskCompaction(input: {
    taskId: string
    sessionId: string
    at: number
    statusBefore: TaskStatus | null
    statusAfter: TaskStatus | null
    tokensBefore: number | null
    tokensAfter: number | null
    summary: string
    archivePath: string | null
    archiveAvailable: boolean
    archiveNote?: string | null
  }): TaskCompactionRecord {
    const id = newId("tc")
    this.db
      .prepare(
        `INSERT INTO task_compactions
         (id, task_id, session_id, at, status_before, status_after, tokens_before, tokens_after, summary, archive_path, archive_available, archive_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.sessionId,
        input.at,
        input.statusBefore,
        input.statusAfter,
        input.tokensBefore,
        input.tokensAfter,
        input.summary,
        input.archivePath,
        input.archiveAvailable ? 1 : 0,
        input.archiveNote ?? null,
        Date.now(),
      )
    return this.getTaskCompaction(id)!
  }

  listTaskCompactions(filter: { taskId?: string; sessionId?: string; limit?: number } = {}): TaskCompactionRecord[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.taskId) {
      where.push("task_id = ?")
      args.push(filter.taskId)
    }
    if (filter.sessionId) {
      where.push("session_id = ?")
      args.push(filter.sessionId)
    }
    args.push(Math.min(Math.max(filter.limit ?? 50, 1), 200))
    const rows = this.db
      .prepare(`SELECT * FROM task_compactions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`)
      .all(...args) as TaskCompactionRow[]
    return rows.map((r) => this.taskCompactionFromRow(r))
  }

  getTaskCompaction(id: string): TaskCompactionRecord | null {
    const row = this.db.prepare("SELECT * FROM task_compactions WHERE id = ?").get(id) as TaskCompactionRow | undefined
    return row ? this.taskCompactionFromRow(row) : null
  }

  updateTaskCompactionArchive(id: string, archivePath: string | null, archiveAvailable: boolean, archiveNote: string | null = null) {
    this.db
      .prepare("UPDATE task_compactions SET archive_path = ?, archive_available = ?, archive_note = ? WHERE id = ?")
      .run(archivePath, archiveAvailable ? 1 : 0, archiveNote, id)
  }

  noteTaskArchiveUnavailable(taskId: string, archivePath: string | null, note: string, at = Date.now()) {
    this.db
      .prepare(
        `UPDATE task_compactions
         SET archive_available = 0,
             archive_note = CASE WHEN archive_note IS NULL OR archive_note = '' THEN ? ELSE archive_note || '; ' || ? END
         WHERE task_id = ? AND (? IS NULL OR archive_path = ?) AND (archive_available = 1 OR archive_note IS NULL)`,
      )
      .run(`${new Date(at).toISOString()}: ${note}`, `${new Date(at).toISOString()}: ${note}`, taskId, archivePath, archivePath)
  }

  // pending inputs: messages for a task that wait for its next turn

  /**
   * Returns the input's id. `prefix` goes before the content in the agent's prompt only (a hook's label);
   * `message` is the transcript line's meta, written when the message is delivered (none for agent/system messages).
   */
  queueInput(taskId: string, source: string, content: string, attachments: string[] = [], opts: { prefix?: string; message?: Record<string, unknown> } = {}): string {
    this.assertTaskNotDeleting(taskId)
    const id = newId("in")
    const now = Date.now()
    this.db
      .prepare("INSERT INTO task_inputs (id, task_id, source, content, attachments, prefix, message_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, taskId, source, content, attachments.length ? JSON.stringify(attachments) : null, opts.prefix ?? "", opts.message ? JSON.stringify(opts.message) : null, now, now)
    return id
  }

  /** Queued inputs (not claimed by a starting turn, not cancelled), oldest first, as the agent gets them. */
  peekInputs(taskId: string): PendingInput[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND status = 'queued' ${INPUT_ORDER}`)
      .all(taskId) as InputRow[]
    return rows.map(pendingInput)
  }

  /**
   * Claim every queued input for the turn `turnId` that is starting (status delivering): from now on they can't
   * be edited or cancelled. deliverInputs removes them once the turn has started, releaseInputs hands them back
   * if it couldn't. Also drops inputs cancelled long enough ago that Undo is over.
   */
  claimInputs(taskId: string, turnId: string): PendingInput[] {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM task_inputs WHERE task_id = ? AND status = 'cancelled' AND updated_at < ?").run(taskId, Date.now() - CANCELLED_INPUT_KEEP_MS)
      // A hand-off (see lockInput) or a steer (claimSteer) the last turn didn't take goes in with this one.
      this.db.prepare("UPDATE task_inputs SET status = 'queued', claim = NULL WHERE task_id = ? AND status = 'delivering' AND (claim LIKE 'handoff:%' OR claim LIKE 'steer:%')").run(taskId)
      this.db.prepare("UPDATE task_inputs SET status = 'delivering', claim = ? WHERE task_id = ? AND status = 'queued'").run(turnId, taskId)
      return (this.db.prepare(`SELECT * FROM task_inputs WHERE claim = ? AND status = 'delivering' ${INPUT_ORDER}`).all(turnId) as InputRow[]).map(pendingInput)
    })()
  }

  /** The turn started: remove its claimed inputs and write their transcript lines, all at once. */
  deliverInputs(turnId: string): TaskMessage[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM task_inputs WHERE claim = ? AND status = 'delivering' ${INPUT_ORDER}`).all(turnId) as InputRow[]
      this.db.prepare("DELETE FROM task_inputs WHERE claim = ? AND status = 'delivering'").run(turnId)
      // meta.queuedAt: when it was sent, like the chats' queued messages (see deliverQueued).
      return rows.flatMap((r) =>
        r.message_json ? [this.addTaskMessage(r.task_id, "user", r.content, { ...(JSON.parse(r.message_json) as Record<string, unknown>), queuedAt: r.created_at })] : [],
      )
    })()
  }

  /**
   * The input was handed to the agent mid-turn (a Captain's reply to an agent waiting on message_captain): lock it
   * like a turn's claim, so an edit can't be lost, until the agent takes it (takeInput) or the turn ends without
   * taking it (releaseInputs(claim), or the next claimInputs). False when it isn't queued any more.
   */
  lockInput(taskId: string, id: string, claim: string): boolean {
    return this.db.prepare("UPDATE task_inputs SET status = 'delivering', claim = ? WHERE id = ? AND task_id = ? AND status = 'queued'").run(claim, id, taskId).changes > 0
  }

  /**
   * The agent took this input mid-turn (see lockInput): remove it and write its transcript line, as deliverInputs
   * would. Compare-and-set: only while it is queued or locked by a hand-off; null when cancelled, claimed by a
   * turn or gone.
   */
  takeInput(taskId: string, id: string): { message: TaskMessage | null } | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM task_inputs WHERE id = ? AND task_id = ? AND (status = 'queued' OR (status = 'delivering' AND claim LIKE 'handoff:%'))")
        .get(id, taskId) as InputRow | undefined
      if (!row) return null
      this.db.prepare("DELETE FROM task_inputs WHERE id = ?").run(id)
      const message = row.message_json ? this.addTaskMessage(taskId, "user", row.content, { ...(JSON.parse(row.message_json) as Record<string, unknown>), queuedAt: row.created_at }) : null
      return { message }
    })()
  }

  /**
   * The turn couldn't start: its claimed inputs are queued (and editable) again. Without a turn id: every claim
   * (startup) but steers, which belong to a turn that may still be running; its end settles them (releaseSteer).
   */
  releaseInputs(turnId?: string) {
    if (turnId) this.db.prepare("UPDATE task_inputs SET status = 'queued', claim = NULL WHERE claim = ? AND status = 'delivering'").run(turnId)
    else this.db.prepare("UPDATE task_inputs SET status = 'queued', claim = NULL WHERE status = 'delivering' AND (claim IS NULL OR (claim NOT LIKE 'steer:%' AND claim NOT LIKE 'codex-%'))").run()
  }

  /**
   * Claim every queued input for a steer into the running turn (`claim` is steer:<turnId>): locked against edits and
   * cancels like a starting turn's claim, until the agent gets them (takeSteer) or the turn ends first
   * (releaseSteer, or the next claimInputs).
   */
  claimSteer(taskId: string, claim: string): PendingInput[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND status = 'queued' ${INPUT_ORDER}`).all(taskId) as InputRow[]
      const lock = this.db.prepare("UPDATE task_inputs SET status = 'delivering', claim = ? WHERE id = ? AND status = 'queued'")
      for (const r of rows) lock.run(claim, r.id)
      return rows.map(pendingInput)
    })()
  }

  /** Persistent publication order, including batches queued in the same millisecond and across restarts. */
  nextSteerSequence(): number {
    const row = this.db.prepare("INSERT INTO kv (key, value) VALUES ('steer_sequence', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value").get() as { value: string }
    return Number(row.value)
  }

  /**
   * The agent got these steered inputs mid-turn: remove the ones still under `claim` and write their transcript
   * lines, as deliverInputs would, marked steered.
   */
  takeSteer(taskId: string, claim: string, ids: string[]): TaskMessage[] {
    if (!ids.length) return []
    return this.db.transaction(() => {
      const rows = (this.db.prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND claim = ? AND status = 'delivering' ${INPUT_ORDER}`).all(taskId, claim) as InputRow[]).filter((r) =>
        ids.includes(r.id),
      )
      const drop = this.db.prepare("DELETE FROM task_inputs WHERE id = ?")
      for (const r of rows) drop.run(r.id)
      return rows.flatMap((r) =>
        r.message_json ? [this.addTaskMessage(taskId, "user", r.content, { ...(JSON.parse(r.message_json) as Record<string, unknown>), queuedAt: r.created_at, steered: true })] : [],
      )
    })()
  }

  /** Steered inputs the agent never got (the turn ended first, or the steer couldn't be sent): queued again. How many. */
  releaseSteer(claim: string, ids?: string[]): number {
    const rows = this.db.prepare("SELECT id FROM task_inputs WHERE claim = ? AND status = 'delivering'").all(claim) as { id: string }[]
    const back = this.db.prepare("UPDATE task_inputs SET status = 'queued', claim = NULL WHERE id = ? AND claim = ? AND status = 'delivering'")
    let n = 0
    for (const r of rows) if (!ids || ids.includes(r.id)) n += back.run(r.id, claim).changes
    return n
  }

  /** Durable Codex states survive startup claim release. Acceptance records a transcript line once. */
  codexDelivery(taskId: string, turnId: string, ids: string[], delivery: "submitted" | "accepted" | "uncertain" | "settled" | "rejected"): TaskMessage[] {
    return this.db.transaction(() => {
      const rows = (this.db.prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND status = 'delivering' ${INPUT_ORDER}`).all(taskId) as InputRow[])
        .filter((r) => ids.includes(r.id) && (r.claim === `steer:${turnId}` || r.claim?.match(/^codex-(submitted|accepted|uncertain):/) && r.claim.endsWith(`:${turnId}`)))
      const messages: TaskMessage[] = []
      for (const r of rows) {
        const accepted = r.claim === `codex-accepted:${turnId}` || Boolean(r.message_json && JSON.parse(r.message_json).steerAccepted)
        if ((delivery === "accepted" || delivery === "settled") && !accepted && r.message_json) {
          const meta = { ...JSON.parse(r.message_json), queuedAt: r.created_at, steered: true, steerAccepted: true }
          messages.push(this.addTaskMessage(taskId, "user", r.content, meta))
          r.message_json = JSON.stringify(meta)
        }
        // Out-of-order/lost event replay must never downgrade a confirmed acceptance.
        if (delivery === "submitted" && (accepted || r.claim?.startsWith("codex-uncertain:"))) continue
        if (delivery === "rejected" && !accepted) this.db.prepare("UPDATE task_inputs SET status = 'queued', claim = NULL WHERE id = ?").run(r.id)
        else if (delivery === "rejected") continue
        else if (delivery === "settled") this.db.prepare("DELETE FROM task_inputs WHERE id = ?").run(r.id)
        else this.db.prepare("UPDATE task_inputs SET claim = ?, message_json = ? WHERE id = ?").run(`codex-${delivery}:${turnId}`, r.message_json, r.id)
      }
      return messages
    })()
  }

  hasUncertainCodexInput(taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM task_inputs WHERE task_id = ? AND status = 'delivering' AND claim LIKE 'codex-uncertain:%' LIMIT 1").get(taskId))
  }

  /** What the task page shows: queued and delivering inputs, in send order. */
  listQueuedInputs(taskId: string): QueuedInputRow[] {
    return (this.db.prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND status IN ('queued', 'delivering') ${INPUT_ORDER}`).all(taskId) as InputRow[]).map(queuedInputRow)
  }

  getQueuedInput(taskId: string, id: string): QueuedInputRow | null {
    const row = this.db.prepare("SELECT * FROM task_inputs WHERE id = ? AND task_id = ?").get(id, taskId) as InputRow | undefined
    return row ? queuedInputRow(row) : null
  }

  /**
   * Replace a queued input's text, only while it is still queued (and at `version`, when given). Compare-and-set
   * against the delivery claim: an input a turn already took is never changed.
   */
  editInput(taskId: string, id: string, content: string, version?: number): InputChange {
    const res = this.db
      .prepare("UPDATE task_inputs SET content = ?, version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'queued' AND (? IS NULL OR version = ?)")
      .run(content, Date.now(), id, taskId, version ?? null, version ?? null)
    return this.inputChange(taskId, id, res.changes > 0)
  }

  /** Cancel a queued input (kept a while for Undo). Compare-and-set like editInput. */
  cancelInput(taskId: string, id: string): InputChange {
    return this.db.transaction(() => {
      const before = this.getQueuedInput(taskId, id)
      const res = this.db
        .prepare("UPDATE task_inputs SET status = 'cancelled', version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND (status = 'queued' OR (status = 'delivering' AND claim LIKE 'codex-uncertain:%'))")
        .run(Date.now(), id, taskId)
      const change = this.inputChange(taskId, id, res.changes > 0)
      // Removing an ambiguous hold is not an unsend. Keep the original text and its actual delivery status.
      if (change.ok && before?.codexDelivery === "uncertain" && before.message && !before.message.steerAccepted) {
        const message = this.addTaskMessage(taskId, "user", before.content, { ...before.message, queuedAt: before.createdAt, deliveryUncertain: true })
        return { ...change, message }
      }
      return change
    })()
  }

  /** Undo a cancel: the input is queued again, in its old place. */
  restoreInput(taskId: string, id: string): InputChange {
    this.assertTaskNotDeleting(taskId)
    const res = this.db
      .prepare("UPDATE task_inputs SET status = 'queued', version = version + 1, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'cancelled' AND (claim IS NULL OR claim NOT LIKE 'codex-%')")
      .run(Date.now(), id, taskId)
    return this.inputChange(taskId, id, res.changes > 0)
  }

  private inputChange(taskId: string, id: string, ok: boolean): InputChange {
    const row = this.getQueuedInput(taskId, id)
    return ok && row ? { ok: true, row } : { ok: false, row }
  }

  /**
   * The task stopped or closed before a turn read its queue: drop every input. The messages from people get their
   * transcript line anyway, marked undelivered, so nothing Cody sent just vanishes. Returns those lines.
   */
  dropInputs(taskId: string): TaskMessage[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM task_inputs WHERE task_id = ? AND status != 'cancelled' ${INPUT_ORDER}`).all(taskId) as InputRow[]
      this.db.prepare("DELETE FROM task_inputs WHERE task_id = ?").run(taskId)
      return rows.flatMap((r) =>
        r.message_json && !JSON.parse(r.message_json).steerAccepted ? [this.addTaskMessage(taskId, "user", r.content, { ...(JSON.parse(r.message_json) as Record<string, unknown>), undelivered: !r.claim?.startsWith("codex-"), ...(r.claim?.startsWith("codex-") ? { deliveryUncertain: true } : {}) })] : [],
      )
    })()
  }

  /** Drop every input, without transcript lines (see dropInputs for the stop/close path). */
  clearInputs(taskId: string) {
    this.db.prepare("DELETE FROM task_inputs WHERE task_id = ?").run(taskId)
  }

  /** Inputs waiting for a turn (queued or being delivered; cancelled ones don't count). */
  hasInputs(taskId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM task_inputs WHERE task_id = ? AND status != 'cancelled' LIMIT 1").get(taskId))
  }

  // ---------- queued messages ----------
  //
  // (Task feedback waits in task_inputs instead and gets its transcript line at delivery; see claimInputs.)
  // A message sent while the Coordinator or a Captain is mid-turn waits for the next turn. It is stored
  // right away with meta.queued, and the UI shows it under the live turn, labelled "Queued". When the turn that
  // reads it starts, deliverQueued moves it to that moment (created_at = delivery, meta.queuedAt = when it was
  // sent), so it sits right before that turn's output, after the reply it was typed over, and stays there after a reload.

  /**
   * Deliver these queued messages now; returns the ones that moved, with their new createdAt and meta. `thread`
   * names the Captain's project or the task, for captain_messages and task_messages.
   */
  deliverQueued(
    table: "chat_messages" | "captain_messages" | "task_messages",
    ids: string[],
    thread?: string,
    now = Date.now(),
  ): { id: string; createdAt: number; meta: Record<string, unknown> }[] {
    if (!ids.length) return []
    const scope = table === "captain_messages" ? "WHERE project_id = ?" : table === "task_messages" ? "WHERE task_id = ?" : ""
    return this.db.transaction(() => {
      // Strictly after everything already in the thread (the previous turn may have ended in this very millisecond).
      // Later rows that tie still sort after it, by rowid.
      const last = (this.db.prepare(`SELECT MAX(created_at) AS t FROM ${table} ${scope}`).get(...(scope ? [thread] : [])) as { t: number | null }).t ?? 0
      const at = Math.max(now, last + 1)
      const get = this.db.prepare(`SELECT meta_json, created_at FROM ${table} WHERE id = ?`)
      const set = this.db.prepare(`UPDATE ${table} SET meta_json = ?, created_at = ? WHERE id = ?`)
      const moved: { id: string; createdAt: number; meta: Record<string, unknown> }[] = []
      for (const id of ids) {
        const r = get.get(id) as { meta_json: string | null; created_at: number } | undefined
        const prev = json<Record<string, unknown> | null>(r?.meta_json, null)
        if (!r || !prev?.queued) continue
        const { queued: _, ...rest } = prev
        const meta = { ...rest, queuedAt: r.created_at }
        set.run(JSON.stringify(meta), at, id)
        moved.push({ id, createdAt: at, meta })
      }
      return moved
    })()
  }

  /** Projects whose Captain has messages still waiting for a turn (after a restart, say). */
  queuedCaptainProjectIds(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT project_id FROM captain_messages WHERE json_extract(meta_json, '$.queued') = 1").all() as { project_id: string }[]
    ).map((r) => r.project_id)
  }

  /** Ids of Coordinator chat messages still waiting for a turn (after a restart, say). */
  queuedChatIds(): string[] {
    return (this.db.prepare("SELECT id FROM chat_messages WHERE json_extract(meta_json, '$.queued') = 1 ORDER BY created_at ASC, rowid ASC").all() as { id: string }[]).map((r) => r.id)
  }

  // Cody can edit or delete a queued Coordinator/Captain message until the turn that reads it takes it. Each change
  // is a compare-and-set on meta.queued, which deliverQueued clears in the same tick the turn reads the messages,
  // so a change lands either before the read (the turn sees it) or not at all ("delivered"). Deleting is soft
  // (meta.cancelled, queued cleared) so Undo can bring it back; turns skip cancelled messages.

  /** `thread`: the Captain's project, for captain_messages. */
  editQueuedChat(table: QueuedChatTable, id: string, thread: string | null, content: string): QueuedChatChange {
    return this.db.transaction((): QueuedChatChange => {
      const row = this.queuedChatRow(table, id, thread)
      if (!row?.meta.queued) return this.queuedChatRefusal(row)
      if (!content.trim() && !(row.meta.attachments as unknown[] | undefined)?.length) throw new BadRequestError("message is empty")
      this.db.prepare(`UPDATE ${table} SET content = ? WHERE id = ?`).run(content, id)
      return { ok: true, row: { ...row, content } }
    })()
  }

  cancelQueuedChat(table: QueuedChatTable, id: string, thread: string | null): QueuedChatChange {
    return this.db.transaction((): QueuedChatChange => {
      const row = this.queuedChatRow(table, id, thread)
      if (!row?.meta.queued) return this.queuedChatRefusal(row)
      const { queued: _, ...rest } = row.meta
      const meta = { ...rest, cancelled: true }
      this.db.prepare(`UPDATE ${table} SET meta_json = ? WHERE id = ?`).run(JSON.stringify(meta), id)
      return { ok: true, row: { ...row, meta } }
    })()
  }

  /**
   * Undo a delete: the message waits again (`queued` while a turn runs) and moves to `at`, so the next turn's
   * "since the last turn" picks it up even if a turn ran meanwhile.
   */
  restoreQueuedChat(table: QueuedChatTable, id: string, thread: string | null, { queued, at }: { queued: boolean; at: number }): QueuedChatChange {
    return this.db.transaction((): QueuedChatChange => {
      const row = this.queuedChatRow(table, id, thread)
      if (!row) return { ok: false, reason: "missing" }
      if (!row.meta.cancelled) return { ok: false, reason: row.meta.queued ? "deleted" : "delivered" }
      const { cancelled: _, ...rest } = row.meta
      const meta = { ...rest, ...(queued ? { queued: true } : {}) }
      this.db.prepare(`UPDATE ${table} SET meta_json = ?, created_at = ? WHERE id = ?`).run(JSON.stringify(meta), at, id)
      return { ok: true, row: { ...row, meta, createdAt: at } }
    })()
  }

  private queuedChatRow(table: QueuedChatTable, id: string, thread: string | null): QueuedChatRow | null {
    const r = (
      table === "captain_messages"
        ? this.db.prepare("SELECT id, content, meta_json, created_at FROM captain_messages WHERE id = ? AND project_id = ? AND role = 'user'").get(id, thread)
        : this.db.prepare("SELECT id, content, meta_json, created_at FROM chat_messages WHERE id = ? AND role = 'user'").get(id)
    ) as { id: string; content: string; meta_json: string | null; created_at: number } | undefined
    return r ? { id: r.id, content: r.content, meta: json<Record<string, unknown>>(r.meta_json, {}) ?? {}, createdAt: r.created_at } : null
  }

  private queuedChatRefusal(row: QueuedChatRow | null): QueuedChatChange {
    return { ok: false, reason: !row ? "missing" : row.meta.cancelled ? "deleted" : "delivered" }
  }

  // ---------- task transcript ----------

  addTaskMessage(
    taskId: string,
    role: TaskMessageRole,
    content: string,
    meta: Record<string, unknown> | null = null,
  ): TaskMessage {
    ;({ content, meta } = this.scrub(role, content, meta))
    const msg: TaskMessage = { id: newId("tm"), taskId, role, content, meta, createdAt: Date.now() }
    this.db
      .prepare("INSERT INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(msg.id, taskId, role, content, meta ? JSON.stringify(meta) : null, msg.createdAt)
    return msg
  }

  listTaskMessages(taskId: string, limit = 500): TaskMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM task_messages WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)
         ORDER BY created_at ASC, rid ASC`,
      )
      .all(taskId, limit) as {
      id: string
      task_id: string
      role: TaskMessageRole
      content: string
      meta_json: string | null
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      role: r.role,
      content: r.content,
      meta: json(r.meta_json, null),
      createdAt: r.created_at,
    }))
  }

  // ---------- orchestrator chat ----------

  addChat(role: ChatRole, content: string, meta: Record<string, unknown> | null = null, id?: string): ChatMessage {
    ;({ content, meta } = this.scrub(role, content, meta))
    const msg: ChatMessage = { id: id ?? newId("chat"), role, content, meta, createdAt: Date.now() }
    // User messages and the orchestrator's own words are already "seen" by it.
    const seen = role === "notice" ? 0 : 1
    this.db
      .prepare(
        "INSERT INTO chat_messages (id, role, content, meta_json, seen_by_orchestrator, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(msg.id, role, content, meta ? JSON.stringify(meta) : null, seen, msg.createdAt)
    return msg
  }

  /** Replace a chat message's meta (e.g. a tool line learning the id it created). */
  setChatMeta(id: string, meta: Record<string, unknown>): ChatMessage | null {
    meta = this.scrub("meta", "", meta).meta!
    this.db.prepare("UPDATE chat_messages SET meta_json = ? WHERE id = ?").run(JSON.stringify(meta), id)
    const r = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
      | { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }
      | undefined
    return r ? { id: r.id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at } : null
  }

  /** Add meta.timingId (turn_timings) to a Coordinator chat message: its turn's timing chip. */
  setChatTiming(id: string, timingId: string, timingMs: number): ChatMessage | null {
    this.db.prepare("UPDATE chat_messages SET meta_json = json_set(COALESCE(meta_json, '{}'), '$.timingId', ?, '$.timingMs', ?) WHERE id = ?").run(timingId, timingMs, id)
    const r = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as
      | { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }
      | undefined
    return r ? { id: r.id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at } : null
  }

  listChat(limit = 300): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM chat_messages ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rid ASC`,
      )
      .all(limit) as { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      meta: json(r.meta_json, null),
      createdAt: r.created_at,
    }))
  }

  listChatSince(since: number): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_messages WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC")
      .all(since) as { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      meta: json(r.meta_json, null),
      createdAt: r.created_at,
    }))
  }

  /** When the oldest notice the orchestrator hasn't been told about was written, or null when there is none. */
  oldestUnseenNoticeAt(): number | null {
    const r = this.db.prepare(`SELECT MIN(created_at) AS at FROM chat_messages WHERE seen_by_orchestrator = 0 AND ${WAKES}`).get() as { at: number | null }
    return r.at
  }

  /** Notices the orchestrator has not been told about yet; marks them seen. FYI Captain replies end with `fyiNote`. */
  takeUnseenNotices(fyiNote = ""): string[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT content, NOT (${WAKES}) AS fyi FROM chat_messages WHERE seen_by_orchestrator = 0 ORDER BY created_at ASC`)
        .all() as { content: string; fyi: number }[]
      this.db.prepare("UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE seen_by_orchestrator = 0").run()
      return rows.map((r) => (r.fyi && fyiNote ? `${r.content} ${fyiNote}` : r.content))
    })()
  }

  /** The projects whose Captains the Coordinator messaged in one turn (captain message meta.coordinatorTurn), around `at`. */
  coordinatorTurnProjects(turn: string, at: number): string[] {
    const day = 24 * 60 * 60_000
    const rows = this.db
      .prepare(
        "SELECT DISTINCT project_id FROM captain_messages WHERE role = 'user' AND created_at BETWEEN ? AND ? AND json_extract(meta_json, '$.coordinatorTurn') = ?",
      )
      .all(at - day, at + day, turn) as { project_id: string }[]
    return rows.map((r) => r.project_id)
  }

  /** Task ids of notices the orchestrator hasn't seen and should wake for (null for notices not about a task). */
  unseenNoticeTasks(): (string | null)[] {
    const rows = this.db
      .prepare(`SELECT json_extract(meta_json, '$.taskId') AS task_id FROM chat_messages WHERE seen_by_orchestrator = 0 AND ${WAKES}`)
      .all() as { task_id: string | null }[]
    return rows.map((r) => r.task_id)
  }

  hasUnseenNotices(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM chat_messages WHERE seen_by_orchestrator = 0 LIMIT 1").get())
  }

  /** Mark notices about these tasks as seen (the orchestrator already looked at the tasks). */
  markNoticesSeen(taskIds: string[]) {
    if (!taskIds.length) return
    const stmt = this.db.prepare(
      "UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE seen_by_orchestrator = 0 AND role = 'notice' AND json_extract(meta_json, '$.taskId') = ?",
    )
    this.db.transaction(() => {
      for (const id of taskIds) stmt.run(id)
    })()
  }

  // ---------- side threads ----------

  /**
   * A chat's messages up to and including `anchorId`, oldest first (at most the last `limit`): the Coordinator chat
   * for projectId null, else that project's Captain chat. A side thread's context is cut here: nothing after the
   * anchor. null when the chat has no such message.
   */
  chatUpTo(projectId: string | null, anchorId: string, limit = 60): ChatMessage[] | null {
    const table = projectId ? "captain_messages" : "chat_messages"
    const scope = projectId ? "AND project_id = ?" : ""
    const args = projectId ? [projectId] : []
    const anchor = this.db.prepare(`SELECT created_at, rowid AS rid FROM ${table} WHERE id = ? ${scope}`).get(anchorId, ...args) as { created_at: number; rid: number } | undefined
    if (!anchor) return null
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM ${table} WHERE (created_at < ? OR (created_at = ? AND rowid <= ?)) ${scope}
         ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rid ASC`,
      )
      .all(anchor.created_at, anchor.created_at, anchor.rid, ...args, limit) as { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at }))
  }

  createSideThread(input: { id?: string; projectId: string | null; anchorId: string; quote: string; sessionId: string; kind?: SideThreadKind }): SideThread {
    const now = Date.now()
    const id = input.id ?? newId("thr")
    this.db
      .prepare("INSERT INTO side_threads (id, project_id, anchor_id, kind, quote, session_id, started, context, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)")
      .run(id, input.projectId, input.anchorId, input.kind ?? "ask", input.quote, input.sessionId, now, now, now)
    return this.getSideThread(id)!
  }

  getSideThread(id: string): SideThread | null {
    const r = this.db.prepare(`${SIDE_THREAD_SELECT} WHERE t.id = ?`).get(id) as SideThreadRow | undefined
    return r ? sideThreadFrom(r) : null
  }

  /** The thread of a kind that has one per anchor (a message's reply thread, a task card's thread), if there is one. */
  threadOn(projectId: string | null, anchorId: string, kind: "reply" | "task"): SideThread | null {
    const r = (
      projectId
        ? this.db.prepare(`${SIDE_THREAD_SELECT} WHERE t.anchor_id = ? AND t.kind = ? AND t.project_id = ? ORDER BY t.created_at ASC LIMIT 1`).get(anchorId, kind, projectId)
        : this.db.prepare(`${SIDE_THREAD_SELECT} WHERE t.anchor_id = ? AND t.kind = ? AND t.project_id IS NULL ORDER BY t.created_at ASC LIMIT 1`).get(anchorId, kind)
    ) as SideThreadRow | undefined
    return r ? sideThreadFrom(r) : null
  }

  /** The newest `limit` Coordinator chat notices about any of these tasks (meta.taskId), oldest first. */
  taskNotices(taskIds: readonly string[], limit = 20): ChatMessage[] {
    if (!taskIds.length) return []
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM chat_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') IN (${taskIds.map(() => "?").join(",")})
         ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rid ASC`,
      )
      .all(...taskIds, limit) as { id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at }))
  }

  /** Resolve a thread (folded away under its message), or reopen it. */
  resolveSideThread(id: string, resolved: boolean) {
    this.db.prepare("UPDATE side_threads SET resolved_at = ? WHERE id = ?").run(resolved ? Date.now() : null, id)
  }

  /** Cody has seen the thread up to now: its answers so far aren't unread. */
  seeSideThread(id: string, at = Date.now()) {
    this.db.prepare("UPDATE side_threads SET seen_at = MAX(COALESCE(seen_at, 0), ?) WHERE id = ?").run(at, id)
  }

  /** The thread's Claude session, and whether a run has created it yet. */
  sideThreadSession(id: string): { sessionId: string; started: boolean } | null {
    const r = this.db.prepare("SELECT session_id, started FROM side_threads WHERE id = ?").get(id) as { session_id: string; started: number } | undefined
    return r ? { sessionId: r.session_id, started: r.started === 1 } : null
  }

  /** A chat's side threads, oldest first. */
  listSideThreads(projectId: string | null): SideThread[] {
    const rows = (
      projectId
        ? this.db.prepare(`${SIDE_THREAD_SELECT} WHERE t.project_id = ? ORDER BY t.created_at ASC, t.rowid ASC`).all(projectId)
        : this.db.prepare(`${SIDE_THREAD_SELECT} WHERE t.project_id IS NULL ORDER BY t.created_at ASC, t.rowid ASC`).all()
    ) as SideThreadRow[]
    return rows.map(sideThreadFrom)
  }

  /** A run created the thread's session (and how it got its context). */
  startSideThread(id: string, context: "fork" | "summary", sessionId?: string) {
    this.db
      .prepare("UPDATE side_threads SET started = 1, context = ?, session_id = COALESCE(?, session_id), updated_at = ? WHERE id = ?")
      .run(context, sessionId ?? null, Date.now(), id)
  }

  deleteSideThread(id: string): boolean {
    return this.db.prepare("DELETE FROM side_threads WHERE id = ?").run(id).changes > 0
  }

  addSideThreadMessage(threadId: string, role: SideThreadRole, content: string, meta: Record<string, unknown> | null = null, id?: string): SideThreadMessage {
    ;({ content, meta } = this.scrub(role, content, meta))
    const msg: SideThreadMessage = { id: id ?? newId("thm"), threadId, role, content, meta, createdAt: Date.now() }
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO side_thread_messages (id, thread_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(msg.id, threadId, role, content, meta ? JSON.stringify(meta) : null, msg.createdAt)
      this.db.prepare("UPDATE side_threads SET updated_at = ? WHERE id = ?").run(msg.createdAt, threadId)
    })()
    return msg
  }

  getSideThreadMessage(id: string): SideThreadMessage | null {
    const r = this.db.prepare("SELECT * FROM side_thread_messages WHERE id = ?").get(id) as
      | { id: string; thread_id: string; role: SideThreadRole; content: string; meta_json: string | null; created_at: number }
      | undefined
    return r ? { id: r.id, threadId: r.thread_id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at } : null
  }

  /** Merge `patch` into a thread message's meta (a reply thread's route for it). */
  patchSideThreadMessage(id: string, patch: Record<string, unknown>): SideThreadMessage | null {
    const m = this.getSideThreadMessage(id)
    if (!m) return null
    this.db.prepare("UPDATE side_thread_messages SET meta_json = ? WHERE id = ?").run(JSON.stringify({ ...m.meta, ...patch }), id)
    return this.getSideThreadMessage(id)
  }

  /** The task a chat message is about (meta.taskId: a task's update, or what Cody sent it), or null. */
  chatMessageTaskId(projectId: string | null, messageId: string): string | null {
    const r = (
      projectId
        ? this.db.prepare("SELECT json_extract(meta_json, '$.taskId') AS task_id FROM captain_messages WHERE id = ? AND project_id = ?").get(messageId, projectId)
        : this.db.prepare("SELECT json_extract(meta_json, '$.taskId') AS task_id FROM chat_messages WHERE id = ?").get(messageId)
    ) as { task_id: unknown } | undefined
    return typeof r?.task_id === "string" && r.task_id ? r.task_id : null
  }

  listSideThreadMessages(threadId: string): SideThreadMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM side_thread_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(threadId) as { id: string; thread_id: string; role: SideThreadRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({ id: r.id, threadId: r.thread_id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at }))
  }

  // ---------- project captains ----------

  addCaptainMessage(projectId: string, role: ChatRole, content: string, meta: Record<string, unknown> | null = null, id?: string): CaptainMessage {
    if (!this.getProject(projectId)) throw new NotFoundError(`Project ${projectId} not found`)
    ;({ content, meta } = this.scrub(role, content, meta))
    const msg: CaptainMessage = { id: id ?? newId("cap"), projectId, role, content, meta, createdAt: Date.now() }
    const seen = role === "notice" ? 0 : 1
    this.db
      .prepare(
        "INSERT INTO captain_messages (id, project_id, role, content, meta_json, seen_by_captain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(msg.id, projectId, role, content, meta ? JSON.stringify(meta) : null, seen, msg.createdAt)
    return msg
  }

  /** Add meta.timingId (turn_timings) to a Captain chat message: its turn's timing chip. */
  setCaptainMessageTiming(id: string, timingId: string, timingMs: number, finalReply = false): CaptainMessage | null {
    this.db.prepare("UPDATE captain_messages SET meta_json = json_set(COALESCE(meta_json, '{}'), '$.timingId', ?, '$.timingMs', ?, '$.finalReply', json(?)) WHERE id = ?").run(timingId, timingMs, JSON.stringify(finalReply), id)
    const r = this.db.prepare("SELECT * FROM captain_messages WHERE id = ?").get(id) as
      | { id: string; project_id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }
      | undefined
    return r ? { id: r.id, projectId: r.project_id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at } : null
  }

  listCaptainMessages(projectId: string, limit = 300): CaptainMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid FROM captain_messages WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)
         ORDER BY created_at ASC, rid ASC`,
      )
      .all(projectId, limit) as { id: string; project_id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      role: r.role,
      content: r.content,
      meta: json(r.meta_json, null),
      createdAt: r.created_at,
    }))
  }

  /** Pending turn inputs only: informational agent logs must not crowd out Cody's messages in a bounded transcript. */
  captainTurnInputs(projectId: string, since: number): CaptainMessage[] {
    const rows = this.db.prepare(`SELECT * FROM captain_messages
      WHERE project_id = ? AND role = 'user' AND created_at >= ?
        AND json_extract(meta_json, '$.cancelled') IS NOT 1
        AND json_extract(meta_json, '$.ownerAction') IS NOT 'close_task'
        AND NOT (json_extract(meta_json, '$.source') IS 'agent' AND json_extract(meta_json, '$.fyi') IS 1)
      ORDER BY created_at ASC, rowid ASC`).all(projectId, since) as
      { id: string; project_id: string; role: ChatRole; content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, role: r.role, content: r.content, meta: json(r.meta_json, null), createdAt: r.created_at }))
  }

  takeUnseenCaptainNotices(projectId: string): string[] {
    return this.takeUnseenCaptainNoticeEntries(projectId).map((n) => n.content)
  }

  peekUnseenCaptainNotices(projectId: string): string[] {
    return this.peekUnseenCaptainNoticeEntries(projectId).map((n) => n.content)
  }

  /**
   * Unseen notices with the key the Captain's WakeLoopGuard counts them by: meta.loopKey when the notice has one
   * (a notes retro is keyed by its tasks, since its text changes every time), else the text itself.
   */
  takeUnseenCaptainNoticeEntries(projectId: string): CaptainNoticeEntry[] {
    return this.db.transaction(() => {
      const entries = this.peekUnseenCaptainNoticeEntries(projectId)
      this.db.prepare("UPDATE captain_messages SET seen_by_captain = 1 WHERE project_id = ? AND seen_by_captain = 0").run(projectId)
      return entries
    })()
  }

  peekUnseenCaptainNoticeEntries(projectId: string): CaptainNoticeEntry[] {
    const rows = this.db
      .prepare("SELECT content, meta_json, created_at FROM captain_messages WHERE project_id = ? AND seen_by_captain = 0 ORDER BY created_at ASC, rowid ASC")
      .all(projectId) as { content: string; meta_json: string | null; created_at: number }[]
    return rows.map((r) => {
      const meta = json<Record<string, unknown> | null>(r.meta_json, null)
      const loopKey = typeof meta?.loopKey === "string" && meta.loopKey ? meta.loopKey : r.content
      return { content: r.content, loopKey, meta, createdAt: r.created_at }
    })
  }

  unseenCaptainNoticeTasks(projectId: string): (string | null)[] {
    const rows = this.db
      .prepare("SELECT json_extract(meta_json, '$.taskId') AS task_id FROM captain_messages WHERE project_id = ? AND seen_by_captain = 0")
      .all(projectId) as { task_id: string | null }[]
    return rows.map((r) => r.task_id)
  }

  markCaptainNoticesSeen(projectId: string, taskIds: string[]) {
    if (!taskIds.length) return
    const stmt = this.db.prepare(
      "UPDATE captain_messages SET seen_by_captain = 1 WHERE project_id = ? AND seen_by_captain = 0 AND role = 'notice' AND json_extract(meta_json, '$.taskId') = ?",
    )
    this.db.transaction(() => {
      for (const id of taskIds) stmt.run(projectId, id)
    })()
  }

  /**
   * A quiet run's notices (like "Schedule … started a run") are never forwarded: mark every unseen one about
   * the task as seen, for its Captain and for the Coordinator, so neither wakes up or reads them later.
   */
  dropTaskNotices(taskId: string) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE captain_messages SET seen_by_captain = 1 WHERE seen_by_captain = 0 AND role = 'notice' AND json_extract(meta_json, '$.taskId') = ?").run(taskId)
      this.db.prepare("UPDATE chat_messages SET seen_by_orchestrator = 1 WHERE seen_by_orchestrator = 0 AND role = 'notice' AND json_extract(meta_json, '$.taskId') = ?").run(taskId)
    })()
  }

  /** Whether the task's agent ever asked Cody something (the "Asked Cody" events). */
  taskEverAsked(taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM task_messages WHERE task_id = ? AND role = 'event' AND json_extract(meta_json, '$.kind') = 'question' LIMIT 1").get(taskId))
  }

  markCaptainMessageSeen(id: string) {
    this.db.prepare("UPDATE captain_messages SET seen_by_captain = 1 WHERE id = ?").run(id)
  }

  // ---------- artifacts ----------

  addArtifact(input: Omit<Artifact, "id" | "createdAt" | "url"> & { path: string; id?: string }): Artifact {
    // Workers pick the id themselves so they can hand out the URL right away.
    const id = input.id && /^art_[a-f0-9]{12}$/.test(input.id) && !this.getArtifact(input.id) ? input.id : newId("art")
    const createdAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, task_id, title, filename, mime, size, path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, input.taskId, input.title, input.filename, input.mime, input.size, input.path, createdAt)
    return this.getArtifact(id)!
  }

  private artifactFromRow(r: {
    id: string
    project_id: string | null
    task_id: string | null
    title: string
    filename: string
    mime: string
    size: number
    created_at: number
  }): Artifact {
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      title: r.title,
      filename: r.filename,
      mime: r.mime,
      size: r.size,
      url: `/artifacts/${r.id}/${encodeURIComponent(r.filename)}`,
      createdAt: r.created_at,
    }
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any
    return row ? this.artifactFromRow(row) : null
  }

  artifactPath(id: string): string | null {
    const row = this.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(id) as { path: string } | undefined
    return row?.path ?? null
  }

  listArtifacts(filter: { projectId?: string; taskId?: string } = {}): Artifact[] {
    const where: string[] = []
    const args: string[] = []
    if (filter.projectId) {
      where.push("project_id = ?")
      args.push(filter.projectId)
    }
    if (filter.taskId) {
      where.push("task_id = ?")
      args.push(filter.taskId)
    }
    const rows = this.db
      .prepare(`SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`)
      .all(...args) as any[]
    return rows.map((r) => this.artifactFromRow(r))
  }

  // ---------- usage and costs ----------

  /**
   * Log one Claude CLI run and return the cost charged to it. `costUsd` is the CLI's `total_cost_usd` and
   * `sessionUsage` its result's modelUsage (sessionUsageOf): the session's running totals (a resumed session starts
   * from the totals its transcript saved), so the run is charged the step from the session's previous report, in cost
   * and in tokens alike (runShare). Those tokens count the compaction and subagent calls the cost does; the result's
   * `usage` (the main loop's calls only) stands in when the CLI didn't report them or the step can't be known.
   */
  recordClaudeUsage(input: {
    source: ClaudeUsageSource
    runKind: string
    taskId?: string | null
    projectId?: string | null
    turnId?: string | null
    sessionId?: string | null
    model?: string | null
    startedAt: number
    endedAt: number
    durationMs?: number | null
    /** The result's `usage`: this run's main-loop calls. */
    usage?: Partial<TokenUsage> | null
    /** The session's running token totals, every call included (sessionUsageOf). */
    sessionUsage?: Partial<TokenUsage> | null
    costUsd?: number | null
    /** OpenCode reports per-run step sums, rather than Claude session totals. */
    costScope?: "run" | "session"
    /** The run resumed an existing session (so its report includes the session's earlier spend). */
    resumed?: boolean
    /** The login it ran on (server/agentLogins.ts), for usage by login. */
    loginId?: string | null
  }) {
    const u = input.usage ?? {}
    const main = tokenUsage(u)
    const reported = input.sessionUsage ? tokenUsage(input.sessionUsage) : null
    const reportedTokens = reported && sumTokens(reported) > 0 ? reported : null
    const reportedUsd = typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd > 0 ? input.costUsd : 0
    const { costUsd, estimated, tokens } = input.costScope === "run" ? { costUsd: reportedUsd, estimated: false, tokens: main } : this.runShare({ sessionId: input.sessionId ?? null, reportedUsd, reportedTokens, main, model: input.model ?? null, resumed: Boolean(input.resumed) })
    const totalTokens = sumTokens(tokens)
    // Some CLI runs report only cost, or only duration. Keep those rows too.
    if (totalTokens <= 0 && reportedUsd <= 0 && !reportedTokens && !(input.durationMs && input.durationMs > 0)) return 0
    this.db
      .prepare(
        `INSERT INTO claude_usage
          (id, source, run_kind, task_id, project_id, turn_id, session_id, model, started_at, ended_at, duration_ms,
           input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total_tokens, cost_usd, reported_cost_usd, cost_estimated, raw_usage_json, login_id,
           reported_usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("cu"),
        input.source,
        input.runKind,
        input.taskId ?? null,
        input.projectId ?? null,
        input.turnId ?? null,
        input.sessionId ?? null,
        input.model ?? null,
        input.startedAt,
        input.endedAt,
        Math.max(0, Math.round(input.durationMs ?? input.endedAt - input.startedAt)),
        tokens.input_tokens,
        tokens.cache_creation_input_tokens,
        tokens.cache_read_input_tokens,
        tokens.output_tokens,
        totalTokens,
        costUsd,
        reportedUsd,
        estimated ? 1 : 0,
        JSON.stringify(u),
        input.loginId ?? null,
        reportedTokens ? JSON.stringify(reportedTokens) : null,
      )
    return costUsd
  }

  /**
   * This run's share of its session's running totals (see recordClaudeUsage): the step in cost and in tokens from the
   * session's previous report. A session with no earlier report starts with this run, unless the run resumed it (then
   * its main-loop tokens at the model's recent rate, at most what was reported). A report lower than the previous one
   * came back from an older save (a process that never saved its totals) or restarted from about zero (a new box, or
   * another session took the CLI's saved totals): the step from the latest earlier report it still covers in cost and
   * every token category, else all of it. Without token totals to tell, all of it, as before they were kept.
   */
  private runShare(r: { sessionId: string | null; reportedUsd: number; reportedTokens: TokenUsage | null; main: TokenUsage; model: string | null; resumed: boolean }): {
    costUsd: number
    estimated: boolean
    tokens: TokenUsage
  } {
    const own = { costUsd: r.reportedUsd, estimated: false, tokens: r.reportedTokens ?? r.main }
    if (!r.sessionId) return own
    const prev = this.db
      .prepare(
        `SELECT reported_cost_usd AS r, reported_usage_json AS u FROM claude_usage
         WHERE session_id = ? AND (reported_cost_usd > 0 OR reported_usage_json IS NOT NULL) ORDER BY ended_at DESC, rowid DESC LIMIT 1`,
      )
      .get(r.sessionId) as { r: number; u: string | null } | undefined
    if (!prev) return r.resumed ? this.estimatedShare(r) : own
    const before = prev.u ? tokenUsage(json<unknown>(prev.u, null)) : null
    const dropped = (r.reportedUsd > 0 && r.reportedUsd < prev.r) || (r.reportedTokens && before && TOKEN_KEYS.some((k) => r.reportedTokens![k] < before[k]))
    if (!dropped) return { costUsd: r.reportedUsd > 0 ? r.reportedUsd - prev.r : 0, estimated: false, tokens: r.reportedTokens && before ? tokenStep(r.reportedTokens, before) : r.main }
    const from = r.reportedTokens ? this.restorePoint(r.sessionId, r.reportedUsd, r.reportedTokens) : null
    return from ? { costUsd: r.reportedUsd - from.r, estimated: false, tokens: tokenStep(r.reportedTokens!, tokenUsage(json<unknown>(from.u, null))) } : own
  }

  /** The session's latest report that `usd` and `tokens` still cover in every category (runShare), if any. */
  private restorePoint(sessionId: string, usd: number, tokens: TokenUsage): { r: number; u: string } | null {
    const row = this.db
      .prepare(
        `SELECT reported_cost_usd AS r, reported_usage_json AS u FROM claude_usage
         WHERE session_id = ? AND reported_usage_json IS NOT NULL AND reported_cost_usd <= ?
           AND json_extract(reported_usage_json, '$.input_tokens') <= ? AND json_extract(reported_usage_json, '$.cache_creation_input_tokens') <= ?
           AND json_extract(reported_usage_json, '$.cache_read_input_tokens') <= ? AND json_extract(reported_usage_json, '$.output_tokens') <= ?
         ORDER BY ended_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId, usd, tokens.input_tokens, tokens.cache_creation_input_tokens, tokens.cache_read_input_tokens, tokens.output_tokens) as { r: number; u: string } | undefined
    return row ?? null
  }

  /** A resumed session's first logged run (runShare): its main-loop tokens at the model's recent rate. */
  private estimatedShare(r: { reportedUsd: number; main: TokenUsage; model: string | null }): { costUsd: number; estimated: boolean; tokens: TokenUsage } {
    if (r.reportedUsd <= 0) return { costUsd: 0, estimated: false, tokens: r.main }
    const total = sumTokens(r.main)
    const rate = this.tokenRate(r.model)
    if (total > 0 && rate === null) return { costUsd: r.reportedUsd, estimated: false, tokens: r.main }
    return { costUsd: Math.min(r.reportedUsd, total * (rate ?? 0)), estimated: true, tokens: r.main }
  }

  /** Recent $/token for a model (else any model) from exactly priced runs, or null with no data. */
  private tokenRate(model: string | null): number | null {
    const since = Date.now() - 30 * 24 * 3_600_000
    const q = this.db.prepare(
      `SELECT SUM(cost_usd) AS c, SUM(total_tokens) AS t FROM claude_usage
       WHERE cost_estimated = 0 AND total_tokens > 0 AND started_at >= ? AND (? IS NULL OR model = ?)`,
    )
    for (const m of model ? [model, null] : [null]) {
      const row = q.get(since, m, m) as { c: number | null; t: number | null }
      if (row.c && row.t) return row.c / row.t
    }
    return null
  }

  /** When the box's latest usage interval ended (ms since epoch), or null when it has none. */
  lastBoxUsageEnd(boxId: string): number | null {
    const r = this.db.prepare("SELECT MAX(ended_at) AS e FROM box_usage_intervals WHERE box_id = ?").get(boxId) as { e: number | null } | undefined
    return r?.e ?? null
  }

  recordBoxUsageInterval(input: {
    boxId: string
    provider: string
    size: BoxSize
    keepAlive: boolean
    startedAt: number
    endedAt: number
    activeMs: number
    uptimeMs: number
    diskBytes?: number | null
    source: UsageSource
    /** The provider's own compute cost for the interval, when it reports one. */
    computeUsd?: number | null
  }) {
    if (input.endedAt <= input.startedAt || input.uptimeMs <= 0) return
    const row: BoxUsageIntervalRow = {
      id: newId("bu"),
      box_id: input.boxId,
      provider: input.provider,
      size: input.size,
      keep_alive: input.keepAlive ? 1 : 0,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      active_ms: Math.max(0, Math.round(input.activeMs)),
      uptime_ms: Math.max(0, Math.round(input.uptimeMs)),
      disk_bytes: input.diskBytes ?? null,
      source: input.source,
      compute_usd: typeof input.computeUsd === "number" && Number.isFinite(input.computeUsd) ? Math.max(0, input.computeUsd) : null,
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO box_usage_intervals
            (id, box_id, provider, size, keep_alive, started_at, ended_at, active_ms, uptime_ms, disk_bytes, source, compute_usd)
           VALUES (@id, @box_id, @provider, @size, @keep_alive, @started_at, @ended_at, @active_ms, @uptime_ms, @disk_bytes, @source, @compute_usd)`,
        )
        .run(row)
      this.addBoxUsageSlots(row)
    })()
  }

  /** Add an interval's share of each 15-minute slot it overlaps to box_usage_slots (see its migration, which backfilled it the same way). */
  private addBoxUsageSlots(r: BoxUsageIntervalRow) {
    const add = this.db.prepare(
      `INSERT INTO box_usage_slots (slot, box_id, size, keep_alive, started_at, ended_at, active_ms, cpu_ms, compute_usd, uptime_ms, disk_byte_ms, max_disk_bytes, disk_bytes, disk_at, source_rank)
       VALUES (@slot, @box_id, @size, @keep_alive, @s, @e, @active_ms, @cpu_ms, @compute_usd, @uptime_ms, @disk_byte_ms, @max_disk_bytes, @disk_bytes, @disk_at, @source_rank)
       ON CONFLICT (slot, box_id, size, keep_alive) DO UPDATE SET
        started_at = MIN(started_at, excluded.started_at),
        ended_at = MAX(ended_at, excluded.ended_at),
        active_ms = active_ms + excluded.active_ms,
        cpu_ms = cpu_ms + excluded.cpu_ms,
        compute_usd = compute_usd + excluded.compute_usd,
        uptime_ms = uptime_ms + excluded.uptime_ms,
        disk_byte_ms = disk_byte_ms + excluded.disk_byte_ms,
        max_disk_bytes = MAX(max_disk_bytes, excluded.max_disk_bytes),
        disk_bytes = CASE WHEN excluded.disk_at >= COALESCE(disk_at, 0) THEN excluded.disk_bytes ELSE disk_bytes END,
        disk_at = CASE WHEN excluded.disk_at >= COALESCE(disk_at, 0) THEN excluded.disk_at ELSE disk_at END,
        source_rank = MAX(source_rank, excluded.source_rank)`,
    )
    const span = r.ended_at - r.started_at
    const disk = r.disk_bytes ?? 0
    for (let slot = r.started_at - (r.started_at % SLOT_MS); slot < r.ended_at; slot += SLOT_MS) {
      const s = Math.max(r.started_at, slot)
      const e = Math.min(r.ended_at, slot + SLOT_MS)
      const share = (e - s) / span
      add.run({
        slot,
        box_id: r.box_id,
        size: r.size,
        keep_alive: r.keep_alive,
        s,
        e,
        active_ms: r.active_ms * share,
        cpu_ms: r.compute_usd === null ? r.active_ms * share : 0,
        compute_usd: (r.compute_usd ?? 0) * share,
        uptime_ms: r.uptime_ms * share,
        disk_byte_ms: disk * r.uptime_ms * share,
        max_disk_bytes: disk,
        disk_bytes: disk > 0 ? disk : null,
        disk_at: disk > 0 ? e : null,
        source_rank: SOURCE_RANKS.indexOf(sourceOf(r.source)),
      })
    }
  }

  /**
   * A cumulative CPU reading for a box: its cgroup's (cpu.stat usage_usec, in µs) or the provider's total
   * (Box.list total_cpu_ns, in ns). Each reading adds what the counter grew by since the last one to the box's pending CPU, which TaskManager.meterBoxes moves into the next interval. A counter
   * that went down (the box restarted) counts from zero. The cgroup is the box's whole CPU, so once Box Yard reads
   * it, the provider's CPU total (which may count less) only moves its own baseline.
   */
  accrueBoxCpu(id: string, from: "cgroup" | "provider", reading: number, now = Date.now()) {
    if (!Number.isFinite(reading) || reading < 0) return
    const row = this.getBox(id)
    if (!row) return
    const last = from === "cgroup" ? row.cgroup_cpu_usec : row.provider_cpu_ns
    const counts = from === "cgroup" || row.cgroup_cpu_usec === null || row.cgroup_cpu_usec === undefined
    const grew = !counts ? 0 : last !== null && last !== undefined ? (reading >= last ? reading - last : reading) : freshBox(row, now) ? reading : 0
    const ms = from === "cgroup" ? grew / 1000 : grew / 1e6
    this.db
      .prepare(`UPDATE boxes SET ${from === "cgroup" ? "cgroup_cpu_usec" : "provider_cpu_ns"} = ?, pending_cpu_ms = pending_cpu_ms + ? WHERE id = ?`)
      .run(Math.round(reading), ms, id)
  }

  /** The provider's cumulative compute cost for a box (Box.list total_compute_cost_usd): like accrueBoxCpu, in $. */
  accrueBoxCompute(id: string, totalUsd: number, now = Date.now()) {
    if (!Number.isFinite(totalUsd) || totalUsd < 0) return
    const row = this.getBox(id)
    if (!row) return
    const last = row.provider_compute_usd
    const grew = last !== null && last !== undefined ? (totalUsd >= last ? totalUsd - last : totalUsd) : freshBox(row, now) ? totalUsd : 0
    this.db.prepare("UPDATE boxes SET provider_compute_usd = ?, pending_compute_usd = pending_compute_usd + ? WHERE id = ?").run(totalUsd, grew, id)
  }

  usageReport(settings: { costRates: CostRates; budget: BudgetSettings }, now = Date.now(), period?: { from: number; to: number }): UsageReport {
    const windows = usageWindows(now).map((w) => this.usageWindow(w, settings.costRates))
    const projects = this.usageProjects()
    const tasks = this.usageTasks()
    const boxes = this.listBoxes().map((b) => this.boxUsageTotal(b, settings.costRates, now))
    const orchestrator = this.claudeTotals(COORDINATOR_USAGE_WHERE)
    const captains = this.claudeTotals(CAPTAIN_USAGE_WHERE)
    return {
      generatedAt: now,
      rates: settings.costRates,
      budget: budgetStatus(settings.budget, windows.find((w) => w.key === "today")!.boxes.costUsd, windows.find((w) => w.key === "30d")!.boxes.costUsd, todaysRaise(this, now)),
      windows,
      projects,
      tasks,
      boxes,
      orchestrator,
      captains,
      ...(period ? { period: this.usagePeriod(period.from, period.to, settings.costRates) } : {}),
    }
  }

  /** Spend in [from, to): claude runs by start time, box intervals by their overlap. See usagePeriod.ts. */
  usagePeriod(from: number, to: number, rates: CostRates): UsagePeriodReport {
    const claude = this.db
      .prepare(
        `SELECT u.source, u.project_id AS projectId, p.name AS projectName, u.task_id AS taskId, t.title AS taskTitle,
          t.schedule_id AS scheduleId, s.name AS scheduleName, u.model, u.started_at AS startedAt, u.duration_ms AS durationMs,
          u.cost_usd AS costUsd, u.input_tokens AS inputTokens, u.cache_creation_input_tokens AS cacheCreationInputTokens,
          u.cache_read_input_tokens AS cacheReadInputTokens, u.output_tokens AS outputTokens, u.total_tokens AS totalTokens,
          u.login_id AS loginId, COALESCE(l.label, ls.label) AS loginLabel, COALESCE(l.last4, ls.last4) AS loginLast4
         FROM claude_usage u
         LEFT JOIN projects p ON p.id = u.project_id
         LEFT JOIN tasks t ON t.id = u.task_id
         LEFT JOIN schedules s ON s.id = t.schedule_id
         LEFT JOIN agent_logins l ON l.id = u.login_id
         LEFT JOIN agent_login_status ls ON ls.login_id = u.login_id
         WHERE u.started_at >= ? AND u.started_at < ?`,
      )
      .all(from, to) as PeriodClaudeRow[]
    // A slot fills one bucket only when the buckets start on a slot edge, as a local midnight does.
    const intervals = this.boxPieces(from, to, rates, from % SLOT_MS === 0)
    const liveBoxes = this.listBoxes().map((b) => ({ boxId: b.id, size: normalizeBoxSize(b.size), keepAlive: Boolean(b.keep_alive), diskBytes: b.disk_bytes }))
    return buildUsagePeriod({ from, to, claude, intervals, liveBoxes })
  }

  /**
   * The Usage modal's ledger for [from, to), by the client's day starts (server/usageLedger.ts). `livePods`: GPU pods up
   * now, so one whose box history has no end yet bills until `to` only while it's up. Each past day's part is kept
   * (server/usageLedgerCache.ts) until a write touches it, so a request builds only today and what changed; GPU pods,
   * which come from the box history, and names are read every time.
   */
  usageLedger(from: number, to: number, days: number[], rates: CostRates, livePods: Set<string> = new Set(), now = Date.now()): UsageLedger {
    const cache = usageLedgerCache(this.db)
    cache.sync()
    const ratesKey = JSON.stringify(rates)
    const ends = [...days.slice(1), to]
    // The range's last day ends at `to`, which moves with every request, so only the days before it are kept.
    const keep = (i: number) => i < days.length - 1 && ends[i]! <= now
    const parts = days.map((d, i) => (keep(i) ? cache.get(d, ends[i]!, ratesKey) : undefined))
    const missing = parts.flatMap((p, i) => (p ? [] : [i]))
    if (missing.length) {
      const turns = this.ledgerTurns(days[missing[0]!]!, ends[missing.at(-1)!]!)
      for (const i of missing) {
        parts[i] = this.ledgerDay(days[i]!, ends[i]!, rates, turns)
        if (keep(i)) cache.set(ratesKey, parts[i]!)
      }
    }

    const llm: UsageLlmRow[] = []
    const compute = new Map<string, UsageComputeRow>()
    const addCompute = (r: UsageComputeRow) => {
      const key = [r.day, r.provider, r.boxId, r.projectId, r.taskId].join("\u0000")
      const row = compute.get(key)
      if (!row) return void compute.set(key, r)
      row.costUsd += r.costUsd
      row.hours += r.hours
      row.estimated ||= r.estimated
    }
    const repriced = { runs: 0, bookedUsd: 0, chargedUsd: 0 }
    const taskIds = new Set<string>()
    const boxIds = new Set<string>()
    const loginIds = new Set<string>()
    parts.forEach((part, day) => {
      for (const r of part!.llm) llm.push({ ...r, day })
      for (const r of part!.compute) addCompute({ ...r, day })
      repriced.runs += part!.repriced.runs
      repriced.bookedUsd += part!.repriced.bookedUsd
      repriced.chargedUsd += part!.repriced.chargedUsd
      for (const id of part!.taskIds) taskIds.add(id)
      for (const id of part!.boxIds) boxIds.add(id)
      for (const id of part!.loginIds) loginIds.add(id)
    })

    let whole: LedgerTurn[] | undefined
    const turns = () => (whole ??= turnsIn(this.ledgerTurns(from, to), from, to))
    const pods = this.podLives(from, to, livePods, turns)
    if (pods.length) for (const r of attributeCompute({ from, to, days, intervals: [], pods, turns: turns() })) addCompute(r)
    for (const p of pods) boxIds.add(p.boxId)

    return { from, to, days, llm, compute: [...compute.values()], repriced, ...this.ledgerNames(taskIds, boxIds, loginIds), rates: ledgerRates(rates) }
  }

  /** Drop the ledger's kept days that writes have touched since, and forget those writes (TaskManager.maintain). */
  syncUsageLedger() {
    usageLedgerCache(this.db).sync()
  }

  /**
   * Build and keep one past day of the ledger for these day starts that isn't kept yet, as a request for them would.
   * False once every past day is kept. TaskManager calls it a day at a time after a restart, so the Usage modal's
   * first open doesn't build a month.
   */
  warmUsageLedger(days: number[], rates: CostRates, now = Date.now()): boolean {
    const cache = usageLedgerCache(this.db)
    cache.sync()
    const ratesKey = JSON.stringify(rates)
    for (let i = 0; i < days.length - 1; i++) {
      const [from, to] = [days[i]!, days[i + 1]!]
      if (to > now || cache.get(from, to, ratesKey)) continue
      cache.set(ratesKey, this.ledgerDay(from, to, rates, this.ledgerTurns(from, to)))
      return true
    }
    return false
  }

  /** usageLedger read in one pass over the whole range, without the day cache: what the cache is tested against. */
  usageLedgerUncached(from: number, to: number, days: number[], rates: CostRates, livePods: Set<string> = new Set()): UsageLedger {
    const claude = readLedgerClaude(this.db.prepare(`${LEDGER_CLAUDE_SQL} WHERE u.started_at >= ? AND u.started_at < ?`).all(from, to))
    // A dip booking is repriced at its session's $/token, from every run of that session (some may be outside the range).
    const dipSessions = [...new Set(claude.filter(isDipBooking).map((r) => r.sessionId).filter((id): id is string => Boolean(id)))]
    const rates$ = sessionRates(dipSessions.flatMap((id) => readLedgerClaude(this.db.prepare(`${LEDGER_CLAUDE_SQL} WHERE u.session_id = ?`).all(id))))

    const intervals = (this.db.prepare("SELECT * FROM box_usage_intervals WHERE ended_at > ? AND started_at < ?").all(from, to) as BoxUsageIntervalRow[]).map((r) => ledgerInterval(r, rates))
    const turns = turnsIn(this.ledgerTurns(from, to), from, to)
    const pods = this.podLives(from, to, livePods, () => turns)
    const taskIds = new Set([...claude.map((r) => r.taskId), ...turns.map((t) => t.taskId)].filter((id): id is string => Boolean(id)))
    const boxIds = new Set([...intervals.map((i) => i.boxId), ...pods.map((p) => p.boxId)])
    const loginIds = new Set(claude.map((r) => r.loginId).filter((id): id is string => Boolean(id)))
    return buildUsageLedger({
      from,
      to,
      days,
      claude,
      sessionRates: rates$,
      intervals,
      pods,
      turns,
      names: this.ledgerNames(taskIds, boxIds, loginIds),
      rates: ledgerRates(rates),
    })
  }

  /** One day of the ledger, [from, to), as its day 0, from the turns read for a span that covers it. */
  private ledgerDay(from: number, to: number, rates: CostRates, raw: LedgerTurnRow[]): LedgerDay {
    const claude = readLedgerClaude(this.db.prepare(`${LEDGER_CLAUDE_SQL} WHERE u.started_at >= ? AND u.started_at < ?`).all(from, to))
    const dipSessions = new Set(claude.filter(isDipBooking).map((r) => r.sessionId).filter((id): id is string => Boolean(id)))
    const rates$ = sessionRates([...dipSessions].flatMap((id) => readLedgerClaude(this.db.prepare(`${LEDGER_CLAUDE_SQL} WHERE u.session_id = ?`).all(id))))
    // The intervals that overlap the day, read by when they end (see intervalPieces), not every interval since it began.
    const intervals = (
      this.db
        .prepare(
          `SELECT * FROM box_usage_intervals WHERE ended_at > @from AND ended_at < @to + ${SLOT_MS} AND started_at < @to AND ended_at - started_at <= ${SLOT_MS}
           UNION ALL
           SELECT * FROM box_usage_intervals INDEXED BY box_usage_intervals_long WHERE ended_at - started_at > ${SLOT_MS} AND ended_at > @from AND started_at < @to`,
        )
        .all({ from, to }) as BoxUsageIntervalRow[]
    ).map((r) => ledgerInterval(r, rates))
    const turns = turnsIn(raw, from, to)
    const built = buildUsageLedger({ from, to, days: [from], claude, sessionRates: rates$, intervals, pods: [], turns, names: { projects: {}, tasks: {}, boxes: {}, logins: {} }, rates: ledgerRates(rates) })
    return {
      from,
      to,
      llm: built.llm,
      compute: built.compute,
      repriced: built.repriced,
      taskIds: [...new Set([...claude.map((r) => r.taskId), ...turns.map((t) => t.taskId)].filter((id): id is string => Boolean(id)))],
      boxIds: [...new Set(intervals.map((i) => i.boxId))],
      loginIds: [...new Set(claude.map((r) => r.loginId).filter((id): id is string => Boolean(id)))],
      dipSessions,
    }
  }

  /** Turns that overlap [from, to), and the box each ran on: recorded since task_turns.box_id, else the box its probe measured it on. */
  private ledgerTurns(from: number, to: number): LedgerTurnRow[] {
    return (
      this.db
        .prepare(
          `SELECT tt.task_id AS taskId, t.project_id AS projectId, COALESCE(tt.box_id, tp.box_id) AS boxId, tt.started_at AS startedAt,
            tt.finished_at AS finishedAt, t.current_turn_id IS tt.id AS current
           FROM task_turns tt
           JOIN tasks t ON t.id = tt.task_id
           LEFT JOIN turn_peaks tp ON tp.turn_id = tt.id
           WHERE tt.started_at < ? AND (tt.finished_at IS NULL OR tt.finished_at > ?)`,
        )
        .all(to, from) as LedgerTurnRow[]
    )
  }

  /** The names a ledger shows: tasks and boxes it touches, every project, and the logins its runs used. */
  private ledgerNames(taskIds: Iterable<string>, boxIds: Iterable<string>, loginIds: Iterable<string>): Pick<UsageLedger, "projects" | "tasks" | "boxes" | "logins"> {
    const tasks: UsageLedger["tasks"] = {}
    const taskQ = this.db.prepare("SELECT title, project_id AS projectId FROM tasks WHERE id = ?")
    for (const id of taskIds) {
      const t = taskQ.get(id) as { title: string; projectId: string | null } | undefined
      if (t) tasks[id] = t
    }
    const projects = Object.fromEntries((this.db.prepare("SELECT id, name FROM projects").all() as { id: string; name: string }[]).map((p) => [p.id, p.name]))
    const boxes: UsageLedger["boxes"] = {}
    const nameQ = this.db.prepare("SELECT box_name AS name, size FROM box_events WHERE box_id = ? ORDER BY at DESC LIMIT 1")
    for (const id of boxIds) {
      const ev = nameQ.get(id) as { name: string | null; size: string | null } | undefined
      boxes[id] = { label: ev?.name ?? id, size: this.getBox(id)?.size ?? ev?.size ?? null }
    }
    const logins: UsageLedger["logins"] = {}
    const loginQ = this.db.prepare(
      `SELECT COALESCE(l.label, ls.label) AS label, COALESCE(l.last4, ls.last4) AS last4 FROM (SELECT ? AS id) x
       LEFT JOIN agent_logins l ON l.id = x.id LEFT JOIN agent_login_status ls ON ls.login_id = x.id`,
    )
    for (const id of loginIds) {
      const l = loginQ.get(id) as { label: string | null; last4: string | null }
      logins[id] = loginName({ label: l.label ?? "Removed login", last4: l.last4 ?? "" })
    }
    return { projects, tasks, boxes, logins }
  }

  /**
   * RunPod and Vast.ai pods' lives in [from, to) from the box history, which Box Yard doesn't meter: a "created" event
   * names the pod's $/hr, and it bills until the pod is deleted or lost (or made again). One with no end yet bills until
   * `to` while it's up, else until the last turn that ran on it ended.
   */
  private podLives(from: number, to: number, live: Set<string>, turns: () => LedgerTurn[]): LedgerPod[] {
    const events = this.db
      .prepare(
        `SELECT box_id AS boxId, type, at, detail FROM box_events
         WHERE (box_id LIKE 'runpod-%' OR box_id LIKE 'vastai-%') AND at < ? ORDER BY box_id, at, id`,
      )
      .all(to) as { boxId: string; type: string; at: number; detail: string | null }[]
    if (!events.length) return []
    let lastTurn: Map<string, number> | undefined
    const lastTurnOn = (boxId: string) => {
      if (!lastTurn) {
        lastTurn = new Map()
        for (const t of turns()) if (t.boxId) lastTurn.set(t.boxId, Math.max(lastTurn.get(t.boxId) ?? 0, t.endedAt))
      }
      return lastTurn.get(boxId) ?? 0
    }
    const out: LedgerPod[] = []
    let open: { boxId: string; at: number; usd: number } | null = null
    const close = (end: number) => {
      if (open && end > from && end > open.at) out.push({ boxId: open.boxId, provider: open.boxId.startsWith("vastai-") ? "vast" : "runpod", startedAt: open.at, endedAt: end, usdPerHour: open.usd })
      open = null
    }
    const finish = () => {
      if (!open) return
      close(live.has(open.boxId) ? to : Math.max(open.at, lastTurnOn(open.boxId)))
    }
    for (const e of events) {
      if (open && open.boxId !== e.boxId) finish()
      if (e.type === "created") {
        if (open) close(e.at)
        const usd = Number(/\$(\d+(?:\.\d+)?)\/hr/.exec(e.detail ?? "")?.[1])
        open = Number.isFinite(usd) && usd > 0 ? { boxId: e.boxId, at: e.at, usd } : null
      } else if (open && (e.type === "deleted" || e.type === "lost" || e.type === "orphan_deleted")) close(e.at)
    }
    finish()
    return out
  }

  /** usageReport's `budget` alone: box spend today and over the last 30 days, without the report's other totals. */
  usageBudgetStatus(settings: { costRates: CostRates; budget: BudgetSettings }, now = Date.now()): BudgetStatus {
    const since = (key: UsageWindow["key"]) => usageWindows(now).find((w) => w.key === key)!.since
    const boxes = (key: UsageWindow["key"]) => this.boxTotalsSince(since(key), settings.costRates).costUsd
    return budgetStatus(settings.budget, boxes("today"), boxes("30d"), todaysRaise(this, now))
  }

  private usageWindow(w: { key: UsageWindow["key"]; label: string; since: number }, rates: CostRates): UsageWindow {
    const claude = this.claudeTotals("WHERE started_at >= ?", [w.since])
    const boxes = this.boxTotalsSince(w.since, rates)
    return { ...w, claude, boxes, totalCostUsd: claude.costUsd + boxes.costUsd }
  }

  private usageProjects(): UsageProjectTotal[] {
    const rows = this.db
      .prepare(
        `SELECT p.id AS projectId, p.name AS projectName,
          COALESCE(SUM(u.cost_usd), 0) AS costUsd,
          COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
          COALESCE(SUM(u.cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
          COALESCE(SUM(u.cache_read_input_tokens), 0) AS cacheReadInputTokens,
          COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
          COALESCE(SUM(u.total_tokens), 0) AS totalTokens,
          COUNT(u.id) AS turns,
          COALESCE(SUM(u.duration_ms), 0) AS durationMs
         FROM projects p
         JOIN claude_usage u ON u.project_id = p.id
         GROUP BY p.id, p.name
         ORDER BY costUsd DESC, totalTokens DESC`,
      )
      .all() as (ClaudeUsageTotals & { projectId: string; projectName: string })[]
    return rows.map((r) => ({ projectId: r.projectId, projectName: r.projectName, claude: totals(r) }))
  }

  private usageTasks(): UsageTaskTotal[] {
    const rows = this.db
      .prepare(
        `SELECT t.id AS taskId, t.title AS taskTitle, p.id AS projectId, p.name AS projectName,
          COALESCE(SUM(u.cost_usd), 0) AS costUsd,
          COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
          COALESCE(SUM(u.cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
          COALESCE(SUM(u.cache_read_input_tokens), 0) AS cacheReadInputTokens,
          COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
          COALESCE(SUM(u.total_tokens), 0) AS totalTokens,
          COUNT(u.id) AS turns,
          COALESCE(SUM(u.duration_ms), 0) AS durationMs
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN claude_usage u ON u.task_id = t.id
         GROUP BY t.id, t.title, p.id, p.name
         ORDER BY costUsd DESC, totalTokens DESC
         LIMIT 200`,
      )
      .all() as (ClaudeUsageTotals & { taskId: string; taskTitle: string; projectId: string; projectName: string })[]
    return rows.map((r) => ({ taskId: r.taskId, taskTitle: r.taskTitle, projectId: r.projectId, projectName: r.projectName, claude: totals(r) }))
  }

  private claudeTotals(where = "", args: unknown[] = []): ClaudeUsageTotals {
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(cost_usd), 0) AS costUsd,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
          COALESCE(SUM(cache_read_input_tokens), 0) AS cacheReadInputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COUNT(*) AS turns,
          COALESCE(SUM(duration_ms), 0) AS durationMs
         FROM claude_usage ${where}`,
      )
      .get(...args) as ClaudeUsageTotals
    return totals(row)
  }

  private boxTotalsSince(since: number, rates: CostRates): BoxUsageTotals {
    return this.boxSpendSince(since, rates).totals
  }

  /** Box spend since `since`, in total and per box (an interval that started earlier counts its share). */
  boxSpendSince(since: number, rates: CostRates): { totals: BoxUsageTotals; byBox: Map<string, { costUsd: number; activeMs: number; source: UsageSource }> } {
    const out: BoxUsageTotals = { activeMs: 0, uptimeMs: 0, diskBytes: 0, costUsd: 0, source: "actual" }
    const byBox = new Map<string, { costUsd: number; activeMs: number; source: UsageSource }>()
    for (const p of this.boxPieces(since, Infinity, rates)) {
      out.activeMs += p.activeMs
      out.uptimeMs += p.uptimeMs
      out.diskBytes = Math.max(out.diskBytes, p.maxDiskBytes)
      out.costUsd += p.costUsd
      out.source = weakerSource(out.source, p.source)
      const box = byBox.get(p.boxId) ?? byBox.set(p.boxId, { costUsd: 0, activeMs: 0, source: "actual" }).get(p.boxId)!
      box.costUsd += p.costUsd
      box.activeMs += p.activeMs
      box.source = weakerSource(box.source, p.source)
    }
    return { totals: out, byBox }
  }

  /**
   * Box spend in [from, to) as pieces that each lie inside it, in the order they end: whole 15-minute slots from
   * box_usage_slots and, for the ragged ends (or all of it, with `slots` false), each metered interval's share. A box's
   * cost is linear in time, so the pieces cost exactly what the intervals' overlaps do.
   */
  private boxPieces(from: number, to: number, rates: CostRates, slots = true): BoxPiece[] {
    const lo = Math.ceil(from / SLOT_MS) * SLOT_MS
    const hi = Number.isFinite(to) ? Math.floor(to / SLOT_MS) * SLOT_MS : Infinity
    if (!slots || lo >= hi) return this.intervalPieces(from, to, rates)
    const whole = this.db
      .prepare("SELECT * FROM box_usage_slots WHERE slot >= ? AND slot < ?")
      .all(lo, Number.isFinite(hi) ? hi : Number.MAX_SAFE_INTEGER) as BoxUsageSlotRow[]
    return [...this.intervalPieces(from, lo, rates), ...whole.map((r) => slotPiece(r, rates)), ...this.intervalPieces(hi, to, rates)].sort((a, b) => a.endedAt - b.endedAt)
  }

  /** Each metered interval's share of [from, to). For short stretches: it reads every interval that ends in them. */
  private intervalPieces(from: number, to: number, rates: CostRates): BoxPiece[] {
    if (from >= to) return []
    const end = Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER
    const rows = this.db
      .prepare(
        `SELECT * FROM box_usage_intervals WHERE ended_at > @from AND ended_at < @end + ${SLOT_MS} AND started_at < @end AND ended_at - started_at <= ${SLOT_MS}
         UNION ALL
         SELECT * FROM box_usage_intervals INDEXED BY box_usage_intervals_long WHERE ended_at - started_at > ${SLOT_MS} AND ended_at > @from AND started_at < @end
         ORDER BY ended_at`,
      )
      .all({ from, end }) as BoxUsageIntervalRow[]
    return rows.flatMap((r): BoxPiece[] => {
      const s = Math.max(from, r.started_at)
      const e = Math.min(to, r.ended_at)
      if (e <= s) return []
      const share = Math.min(1, (e - s) / Math.max(1, r.ended_at - r.started_at))
      return [
        {
          boxId: r.box_id,
          size: normalizeBoxSize(r.size),
          keepAlive: Boolean(r.keep_alive),
          startedAt: s,
          endedAt: e,
          activeMs: r.active_ms * share,
          uptimeMs: r.uptime_ms * share,
          diskBytes: r.disk_bytes,
          maxDiskBytes: r.disk_bytes ?? 0,
          costUsd: intervalCost(r, rates, share),
          source: sourceOf(r.source),
        },
      ]
    })
  }

  private boxUsageTotal(row: BoxRow, rates: CostRates, now: number): UsageBoxTotal {
    const uptimeMs = Math.max(0, now - row.created_at)
    return {
      boxId: row.id,
      provider: row.provider,
      size: normalizeBoxSize(row.size),
      keepAlive: Boolean(row.keep_alive),
      activeMs: row.active_ms ?? 0,
      uptimeMs,
      diskBytes: row.disk_bytes ?? null,
      estimatedCostUsd: boxRowCost(row, rates, now),
      usageSource: sourceOf(row.usage_source),
    }
  }

  // ---------- boxes ----------

  listBoxes(): BoxRow[] {
    return this.db.prepare("SELECT * FROM boxes WHERE status != 'deleting' ORDER BY created_at ASC").all() as BoxRow[]
  }

  /** Boxes whose provider delete hasn't gone through yet (left out of listBoxes: nothing may use them). */
  listDeletingBoxes(): BoxRow[] {
    return this.db.prepare("SELECT * FROM boxes WHERE status = 'deleting' ORDER BY created_at ASC").all() as BoxRow[]
  }

  getBox(id: string): BoxRow | null {
    return (this.db.prepare("SELECT * FROM boxes WHERE id = ?").get(id) as BoxRow | undefined) ?? null
  }

  upsertBox(row: Pick<BoxRow, "id" | "provider" | "status" | "created_at" | "last_used_at"> & Partial<Omit<BoxRow, "id" | "provider" | "status" | "created_at" | "last_used_at">>) {
    this.db
      .prepare(
        `INSERT INTO boxes (id, provider, status, created_at, last_used_at, size, keep_alive, active_ms, last_metered_at, disk_bytes, disk_updated_at, usage_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          last_used_at = excluded.last_used_at,
          size = excluded.size,
          keep_alive = excluded.keep_alive,
          usage_source = excluded.usage_source`,
      )
      .run(
        row.id,
        row.provider,
        row.status,
        row.created_at,
        row.last_used_at,
        normalizeBoxSize(row.size),
        row.keep_alive ? 1 : 0,
        row.active_ms ?? 0,
        row.last_metered_at ?? row.created_at,
        row.disk_bytes ?? null,
        row.disk_updated_at ?? null,
        row.usage_source ?? "estimated",
      )
  }

  setBoxStatus(id: string, status: BoxRow["status"]) {
    this.db.prepare("UPDATE boxes SET status = ?, last_used_at = ? WHERE id = ?").run(status, Date.now(), id)
  }

  touchBox(id: string) {
    this.db.prepare("UPDATE boxes SET last_used_at = ? WHERE id = ?").run(Date.now(), id)
  }

  meterBox(
    id: string,
    patch: Partial<{
      activeMs: number
      lastMeteredAt: number
      diskBytes: number | null
      diskUpdatedAt: number | null
      size: BoxSize
      keepAlive: boolean
      usageSource: UsageSource
      diskFreeBytes: number | null
      diskTotalBytes: number | null
      diskCheckedAt: number | null
      rootFreeBytes: number | null
      rootTotalBytes: number | null
      memUsedBytes: number | null
      memTotalBytes: number | null
      loadAvg: number | null
      cpuCount: number | null
      pendingCpuMs: number
      pendingComputeUsd: number
      pricedActiveMs: number
      pricedUsd: number
      providerUsd: number
      measuredUsd: number
    }>,
  ) {
    const sets: string[] = []
    const args: unknown[] = []
    const cols = {
      activeMs: "active_ms",
      lastMeteredAt: "last_metered_at",
      diskBytes: "disk_bytes",
      diskUpdatedAt: "disk_updated_at",
      size: "size",
      keepAlive: "keep_alive",
      usageSource: "usage_source",
      diskFreeBytes: "disk_free_bytes",
      diskTotalBytes: "disk_total_bytes",
      diskCheckedAt: "disk_checked_at",
      rootFreeBytes: "root_free_bytes",
      rootTotalBytes: "root_total_bytes",
      memUsedBytes: "mem_used_bytes",
      memTotalBytes: "mem_total_bytes",
      loadAvg: "load_avg",
      cpuCount: "cpu_count",
      pendingCpuMs: "pending_cpu_ms",
      pendingComputeUsd: "pending_compute_usd",
      pricedActiveMs: "priced_active_ms",
      pricedUsd: "priced_usd",
      providerUsd: "provider_usd",
      measuredUsd: "measured_usd",
    } as const
    for (const [k, v] of Object.entries(patch) as [keyof typeof cols, unknown][]) {
      if (v === undefined) continue
      sets.push(`${cols[k]} = ?`)
      args.push(k === "keepAlive" ? (v ? 1 : 0) : k === "size" ? normalizeBoxSize(v as BoxSize) : v)
    }
    if (sets.length) this.db.prepare(`UPDATE boxes SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
  }

  removeBox(id: string) {
    this.db.prepare("DELETE FROM boxes WHERE id = ?").run(id)
  }

  // ---------- measured turns (auto-sizing) ----------

  /** One measured turn (shared/autoSize.ts). Drops rows past the 14-day window as it goes. */
  recordTurnPeak(row: TurnPeak & { turnId: string; projectId: string; taskId: string; boxId: string }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turn_peaks (turn_id, project_id, task_id, box_id, box_size, at, mem_peak_bytes, cpu_peak_cores, cpu_busy_cores, disk_peak_bytes, oom)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.turnId, row.projectId, row.taskId, row.boxId, row.boxSize, row.at, row.memPeakBytes, row.cpuPeakCores, row.cpuBusyCores, row.diskPeakBytes, row.oom ? 1 : 0)
    this.db.prepare("DELETE FROM turn_peaks WHERE at < ?").run(Date.now() - AUTO_SIZE_WINDOW_MS)
  }

  /** A project's measured turns in the last 14 days, oldest first. */
  turnPeaks(projectId: string): TurnPeak[] {
    const rows = this.db
      .prepare("SELECT * FROM turn_peaks WHERE project_id = ? AND at >= ? ORDER BY at ASC")
      .all(projectId, Date.now() - AUTO_SIZE_WINDOW_MS) as TurnPeakRow[]
    return rows.map((r) => ({
      boxSize: normalizeBoxSize(r.box_size as BoxSize),
      at: r.at,
      memPeakBytes: r.mem_peak_bytes,
      cpuPeakCores: r.cpu_peak_cores,
      cpuBusyCores: r.cpu_busy_cores,
      diskPeakBytes: r.disk_peak_bytes,
      oom: Boolean(r.oom),
    }))
  }

  // ---------- turn timings ----------

  private timingsPrunedAt = 0

  /** One run's timings (shared/turnTimings.ts). Drops rows past the 30-day window, at most every 10 minutes. */
  recordTurnTiming(t: TurnTiming) {
    const { id, role, kind, projectId, taskId, sessionId, model, effort, trigger, resumed, ok, requestedAt, startedAt, endedAt, totalMs, steps, loginId, login: _login, ...stages } = t
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turn_timings (id, role, kind, project_id, task_id, session_id, model, effort, trigger, resumed, ok, requested_at, started_at, ended_at, total_ms, stages_json, steps_json, login_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, role, kind, projectId, taskId, sessionId, model, effort, trigger, resumed ? 1 : 0, ok ? 1 : 0, requestedAt, startedAt, endedAt, Math.round(totalMs), JSON.stringify(stages), JSON.stringify(steps), loginId ?? null)
    const now = Date.now()
    if (now - this.timingsPrunedAt > 10 * 60_000) {
      this.timingsPrunedAt = now
      this.db.prepare("DELETE FROM turn_timings WHERE ended_at < ?").run(now - TURN_TIMINGS_WINDOW_MS)
    }
  }

  getTurnTiming(id: string): TurnTiming | null {
    const r = this.db.prepare("SELECT * FROM turn_timings WHERE id = ?").get(id) as TurnTimingRow | undefined
    return r ? timingFromRow(r) : null
  }

  /** Runs that ended since `since`, newest first. */
  listTurnTimings(filter: { since: number; role?: TurnRole; projectId?: string; taskId?: string; kind?: string; limit?: number }): TurnTiming[] {
    const where = ["ended_at >= ?"]
    const args: (string | number)[] = [filter.since]
    if (filter.role) where.push("role = ?"), args.push(filter.role)
    if (filter.projectId) where.push("project_id = ?"), args.push(filter.projectId)
    if (filter.taskId) where.push("task_id = ?"), args.push(filter.taskId)
    if (filter.kind) where.push("kind = ?"), args.push(filter.kind)
    const rows = this.db
      .prepare(`SELECT * FROM turn_timings WHERE ${where.join(" AND ")} ORDER BY ended_at DESC LIMIT ?`)
      .all(...args, filter.limit ?? 5000) as TurnTimingRow[]
    return rows.map(timingFromRow)
  }

  // ---------- schedules ----------

  private scheduleFromRow(r: ScheduleRow): Schedule {
    return {
      id: r.id,
      target: r.target,
      projectId: r.project_id,
      runsOn: parseRunsOn(r.runs_on),
      name: r.name,
      cron: r.cron,
      timezone: r.timezone,
      prompt: r.prompt,
      enabled: Boolean(r.enabled),
      catchUp: r.catch_up,
      allowOverlap: Boolean(r.allow_overlap),
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastTaskId: r.last_task_id,
      lastSkipReason: r.last_skip_reason,
      runCount: r.run_count,
      qstashId: r.qstash_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  listSchedules(filter: { projectId?: string; target?: ScheduleTarget } = {}): Schedule[] {
    const where: string[] = []
    const args: string[] = []
    if (filter.projectId) (where.push("project_id = ?"), args.push(filter.projectId))
    if (filter.target) (where.push("target = ?"), args.push(filter.target))
    const rows = this.db.prepare(`SELECT * FROM schedules ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`).all(...args)
    return (rows as ScheduleRow[]).map((r) => this.scheduleFromRow(r))
  }

  getSchedule(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined
    return row ? this.scheduleFromRow(row) : null
  }

  findSchedule(idOrName: string): Schedule | null {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE id = ? OR name = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1")
      .get(idOrName, idOrName) as ScheduleRow | undefined
    return row ? this.scheduleFromRow(row) : null
  }

  /** Enabled schedules whose next run is at or before `now`. */
  dueSchedules(now: number): Schedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC")
      .all(now) as ScheduleRow[]
    return rows.map((r) => this.scheduleFromRow(r))
  }

  createSchedule(input: {
    id?: string
    target?: ScheduleTarget
    projectId: string | null
    runsOn?: Runner | null
    name: string
    cron: string
    timezone: string
    prompt: string
    enabled?: boolean
    catchUp?: CatchUp
    allowOverlap?: boolean
    nextRunAt: number | null
  }): Schedule {
    const now = Date.now()
    const id = input.id ?? newId("sch")
    this.db
      .prepare(
        `INSERT INTO schedules (id, target, project_id, runs_on, name, cron, timezone, prompt, enabled, catch_up, allow_overlap, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.target ?? "project",
        input.projectId,
        input.runsOn ?? null,
        input.name.trim(),
        input.cron.trim(),
        input.timezone,
        input.prompt,
        input.enabled === false ? 0 : 1,
        input.catchUp ?? "once",
        input.allowOverlap ? 1 : 0,
        input.nextRunAt,
        now,
        now,
      )
    return this.getSchedule(id)!
  }

  updateSchedule(id: string, patch: SchedulePatch): Schedule {
    const sets: string[] = []
    const args: unknown[] = []
    for (const [key, value] of Object.entries(patch) as [keyof SchedulePatch, unknown][]) {
      if (value === undefined) continue
      sets.push(`${SCHEDULE_COLUMNS[key]} = ?`)
      args.push(typeof value === "boolean" ? (value ? 1 : 0) : value)
    }
    sets.push("updated_at = ?")
    args.push(Date.now(), id)
    const res = this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...args)
    if (res.changes === 0) throw new NotFoundError(`Schedule ${id} not found`)
    return this.getSchedule(id)!
  }

  /**
   * Move a schedule's next run from `expected` to `next`, only if nobody else
   * did first. This is what makes a run fire once even when the local timer
   * and a QStash delivery race each other.
   */
  claimRun(id: string, expected: number | null, next: number | null): boolean {
    const res = this.db
      .prepare("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at IS ?")
      .run(next, Date.now(), id, expected)
    return res.changes === 1
  }

  deleteSchedule(id: string) {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id)
  }

  // ---------- orchestrator schedule runs ----------

  private runFromRow(r: ScheduleRunRow): ScheduleRun {
    return {
      id: r.id,
      scheduleId: r.schedule_id,
      status: r.status,
      reason: r.reason,
      prompt: r.prompt,
      dueAt: r.due_at,
      chatMessageId: r.chat_message_id,
      error: r.error,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }
  }

  createScheduleRun(input: { scheduleId: string; prompt: string; reason: ScheduleRun["reason"]; dueAt: number }): ScheduleRun {
    const id = newId("run")
    this.db
      .prepare("INSERT INTO schedule_runs (id, schedule_id, status, reason, prompt, due_at, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)")
      .run(id, input.scheduleId, input.reason, input.prompt, input.dueAt, Date.now())
    return this.getScheduleRun(id)!
  }

  getScheduleRun(id: string): ScheduleRun | null {
    const row = this.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as ScheduleRunRow | undefined
    return row ? this.runFromRow(row) : null
  }

  updateScheduleRun(id: string, patch: Partial<Pick<ScheduleRun, "status" | "chatMessageId" | "error" | "startedAt" | "finishedAt">>): ScheduleRun {
    const cols = { status: "status", chatMessageId: "chat_message_id", error: "error", startedAt: "started_at", finishedAt: "finished_at" } as const
    const sets: string[] = []
    const args: unknown[] = []
    for (const [k, v] of Object.entries(patch) as [keyof typeof cols, unknown][]) {
      if (v === undefined) continue
      sets.push(`${cols[k]} = ?`)
      args.push(v)
    }
    if (sets.length) this.db.prepare(`UPDATE schedule_runs SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
    return this.getScheduleRun(id)!
  }

  /** Runs of one schedule (or all of them), newest first. */
  listScheduleRuns(filter: { scheduleId?: string; status?: ScheduleRunStatus[]; limit?: number } = {}): ScheduleRun[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.scheduleId) (where.push("schedule_id = ?"), args.push(filter.scheduleId))
    if (filter.status?.length) (where.push(`status IN (${filter.status.map(() => "?").join(",")})`), args.push(...filter.status))
    const rows = this.db
      .prepare(`SELECT * FROM schedule_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...args, filter.limit ?? 200) as ScheduleRunRow[]
    return rows.map((r) => this.runFromRow(r))
  }

  // ---------- subscription limits (server/loginLimits.ts) ----------

  /** Every window's last reading, or one login's. */
  loginLimitRows(loginId?: string): LoginLimitRow[] {
    return (loginId
      ? this.db.prepare("SELECT * FROM login_limits WHERE login_id = ?").all(loginId)
      : this.db.prepare("SELECT * FROM login_limits").all()) as LoginLimitRow[]
  }

  /** A removed login's readings (docs/logins.md): Settings stops showing its limits. */
  forgetLoginLimits(loginId: string) {
    this.db.prepare("DELETE FROM login_limits WHERE login_id = ?").run(loginId)
  }

  /**
   * One window's new reading. A reading without a figure (Claude Code names the window but not how full it is) keeps
   * the figure the window had, while it's the same period (the same reset time).
   */
  saveLoginLimit(r: LoginLimitRow) {
    this.db
      .prepare(
        `INSERT INTO login_limits (login_id, limit_window, harness, kind, source, scope, fingerprint, plan, minutes, used_pct, resets_at, status, as_of)
         VALUES (@login_id, @limit_window, @harness, @kind, @source, @scope, @fingerprint, @plan, @minutes, @used_pct, @resets_at, @status, @as_of)
         ON CONFLICT (login_id, limit_window) DO UPDATE SET
           harness = excluded.harness, kind = excluded.kind, source = excluded.source, scope = excluded.scope, fingerprint = excluded.fingerprint,
           plan = COALESCE(excluded.plan, plan), minutes = COALESCE(excluded.minutes, minutes),
           used_pct = COALESCE(excluded.used_pct, CASE WHEN resets_at IS excluded.resets_at THEN used_pct END),
           resets_at = excluded.resets_at, status = excluded.status, as_of = excluded.as_of
         WHERE excluded.as_of >= as_of`,
      )
      .run(r)
  }

  // ---------- kv ----------

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  // ---------- notifications ----------

  /** `summary` replaces the task's own one-liner, e.g. "PR #23 merged by cody". */
  addNotification(task: Task, summary?: string): AppNotification | null {
    if (!(["done", "pr_ready", "needs_input", "failed", "idle"] as TaskStatus[]).includes(task.status)) return null
    const project = this.db.prepare("SELECT name FROM projects WHERE id = ?").get(task.projectId) as { name: string } | undefined
    const text = task.status === "needs_input" ? task.question : task.status === "failed" ? task.error : task.summary
    const n: AppNotification = {
      id: newId("ntf"),
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      projectName: project?.name ?? "",
      status: task.status as AppNotification["status"],
      summary: oneLine(summary ?? text),
      createdAt: Date.now(),
      readAt: null,
    }
    this.db
      .prepare(
        "INSERT INTO notifications (id, task_id, project_id, title, project_name, status, summary, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(n.id, n.taskId, n.projectId, n.title, n.projectName, n.status, n.summary, n.createdAt)
    this.db
      .prepare("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?)")
      .run(NOTIFICATIONS_KEPT)
    this.onNotification?.(n)
    return n
  }

  /** A notification about a box, not a task (e.g. a resize the Coordinator made). */
  addBoxNotification(input: { boxId: string; title: string; summary: string; status: "done" | "failed"; projectId?: string; projectName?: string; href?: string }): AppNotification {
    const n: AppNotification = {
      id: newId("ntf"),
      taskId: null,
      boxId: input.boxId,
      href: input.href ?? `/boxes#${input.boxId}`,
      projectId: input.projectId ?? "",
      title: input.title,
      projectName: input.projectName ?? "",
      status: input.status,
      summary: oneLine(input.summary),
      createdAt: Date.now(),
      readAt: null,
    }
    this.db
      .prepare(
        "INSERT INTO notifications (id, task_id, box_id, href, project_id, title, project_name, status, summary, created_at, read_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(n.id, n.boxId, n.href, n.projectId, n.title, n.projectName, n.status, n.summary, n.createdAt)
    this.db
      .prepare("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?)")
      .run(NOTIFICATIONS_KEPT)
    this.onNotification?.(n)
    return n
  }

  /** Newest first. */
  listNotifications(limit = 50): AppNotification[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, NOTIFICATIONS_KEPT))) as NotificationRow[]
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      ...(r.box_id ? { boxId: r.box_id } : {}),
      ...(r.href ? { href: r.href } : {}),
      projectId: r.project_id,
      title: r.title,
      projectName: r.project_name,
      status: r.status,
      summary: r.summary,
      createdAt: r.created_at,
      readAt: r.read_at,
    }))
  }

  /** Mark notifications read: by id, every one for a task, or all. Returns the ids that changed. */
  markNotificationsRead(by: { ids?: string[]; taskId?: string; all?: boolean }, at = Date.now()): string[] {
    let rows: { id: string }[]
    if (by.all) rows = this.db.prepare("SELECT id FROM notifications WHERE read_at IS NULL").all() as { id: string }[]
    else if (by.taskId) rows = this.db.prepare("SELECT id FROM notifications WHERE read_at IS NULL AND task_id = ?").all(by.taskId) as { id: string }[]
    else {
      const stmt = this.db.prepare("SELECT id FROM notifications WHERE read_at IS NULL AND id = ?")
      rows = (by.ids ?? []).flatMap((id) => (stmt.get(id) as { id: string } | undefined) ?? [])
    }
    const ids = rows.map((r) => r.id)
    const upd = this.db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?")
    this.db.transaction(() => ids.forEach((id) => upd.run(at, id)))()
    return ids
  }

  setKv(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM kv WHERE key = ?").run(key)
    else
      this.db
        .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value)
  }
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000
const GB = 1024 ** 3

function intToken(n: unknown) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

const TOKEN_KEYS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const

function tokenUsage(u: unknown): TokenUsage {
  const x = (u && typeof u === "object" ? u : {}) as Record<string, unknown>
  return {
    input_tokens: intToken(x.input_tokens),
    cache_creation_input_tokens: intToken(x.cache_creation_input_tokens),
    cache_read_input_tokens: intToken(x.cache_read_input_tokens),
    output_tokens: intToken(x.output_tokens),
  }
}

const sumTokens = (u: TokenUsage) => TOKEN_KEYS.reduce((a, k) => a + u[k], 0)
const tokenStep = (now: TokenUsage, before: TokenUsage): TokenUsage => ({
  input_tokens: now.input_tokens - before.input_tokens,
  cache_creation_input_tokens: now.cache_creation_input_tokens - before.cache_creation_input_tokens,
  cache_read_input_tokens: now.cache_read_input_tokens - before.cache_read_input_tokens,
  output_tokens: now.output_tokens - before.output_tokens,
})

function totals(row: Partial<ClaudeUsageTotals> | undefined | null): ClaudeUsageTotals {
  return {
    costUsd: Number(row?.costUsd ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    cacheCreationInputTokens: Number(row?.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: Number(row?.cacheReadInputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
    turns: Number(row?.turns ?? 0),
    durationMs: Number(row?.durationMs ?? 0),
  }
}

/** A stored usage source; anything unknown (an older build's) reads as estimated. */
export const sourceOf = (s: unknown): UsageSource => (s === "actual" || s === "measured" ? s : "estimated")

export function normalizeBoxSize(size: unknown): BoxSize {
  return typeof size === "string" && (BOX_SIZES as readonly string[]).includes(size) ? (size as BoxSize) : "small"
}

/**
 * What a stretch of a box's life costs at Upstash's prices (https://upstash.com/pricing/box): CPU it used (`activeMs`,
 * core-ms) at its size's rate per active CPU hour, unless the provider priced it itself (`computeUsd`, added as is),
 * plus storage per GB-month. A keep-alive box pays only its fixed monthly fee: "This is the only charge for that Keep
 * Alive box, so you are not billed separately for CPU or storage on it" (https://upstash.com/docs/box/overall/keep-alive).
 * Memory is free. An idle box (no CPU) costs only its storage.
 */
export function boxCost(
  box: { activeMs: number; uptimeMs: number; diskBytes?: number | null; size: BoxSize; keepAlive: boolean; computeUsd?: number | null },
  rates: CostRates,
): number {
  const uptimeMs = Math.max(0, box.uptimeMs)
  return partsCost({ cpuMs: Math.max(0, box.activeMs), computeUsd: Math.max(0, box.computeUsd ?? 0), uptimeMs, diskByteMs: (box.diskBytes ?? 0) * uptimeMs }, box.size, box.keepAlive, rates)
}

/** boxCost from the parts it is linear in, so the parts of many intervals (a box_usage_slots row) price as their sum. */
function partsCost(p: { cpuMs: number; computeUsd: number; uptimeMs: number; diskByteMs: number }, boxSize: BoxSize, keepAlive: boolean, rates: CostRates): number {
  const size = normalizeBoxSize(boxSize)
  if (keepAlive) return (p.uptimeMs / MONTH_MS) * rates.boxKeepAliveMonthlyUsd[size]
  return (p.cpuMs / 3_600_000) * rates.boxActiveCpuHourlyUsd[size] + p.computeUsd + ((p.diskByteMs / GB) * rates.boxStorageGbMonthUsd) / MONTH_MS
}

const slotPiece = (r: BoxUsageSlotRow, rates: CostRates): BoxPiece => ({
  boxId: r.box_id,
  size: normalizeBoxSize(r.size),
  keepAlive: Boolean(r.keep_alive),
  startedAt: r.started_at,
  endedAt: r.ended_at,
  activeMs: r.active_ms,
  uptimeMs: r.uptime_ms,
  diskBytes: r.disk_bytes,
  maxDiskBytes: r.max_disk_bytes,
  costUsd: partsCost({ cpuMs: r.cpu_ms, computeUsd: r.compute_usd, uptimeMs: r.uptime_ms, diskByteMs: r.disk_byte_ms }, r.size, Boolean(r.keep_alive), rates),
  source: SOURCE_RANKS[r.source_rank] ?? "estimated",
})

/** A metered interval's cost: the provider's own compute figure when it has one, else its CPU at Settings' rates. */
/** The ledger's Claude runs, each with the session's report before it (runCost's `prev`), for the dip check. */
const LEDGER_CLAUDE_SQL = `SELECT u.source, u.run_kind AS runKind, u.project_id AS projectId, u.task_id AS taskId, u.session_id AS sessionId, u.model,
    u.login_id AS loginId, u.started_at AS startedAt, u.cost_usd AS costUsd, u.reported_cost_usd AS reportedUsd, u.cost_estimated AS costEstimated,
    u.input_tokens AS inputTokens, u.cache_creation_input_tokens AS cacheCreationInputTokens, u.cache_read_input_tokens AS cacheReadInputTokens,
    u.output_tokens AS outputTokens,
    (SELECT p.reported_cost_usd FROM claude_usage p
      WHERE p.session_id = u.session_id AND p.reported_cost_usd > 0 AND p.ended_at <= u.ended_at AND (p.ended_at < u.ended_at OR (p.ended_at = u.ended_at AND p.rowid < u.rowid))
      ORDER BY p.ended_at DESC, p.rowid DESC LIMIT 1) AS prevReportedUsd
   FROM claude_usage u`

const readLedgerClaude = (rows: unknown[]) =>
  (rows as (Omit<LedgerClaudeRow, "costEstimated"> & { costEstimated: number })[]).map((r): LedgerClaudeRow => ({ ...r, costEstimated: Boolean(r.costEstimated) }))

const ledgerInterval = (r: BoxUsageIntervalRow, rates: CostRates): LedgerInterval => ({
  boxId: r.box_id,
  provider: r.provider,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  costUsd: intervalCost(r, rates),
  source: sourceOf(r.source),
})

const ledgerRates = (rates: CostRates): UsageLedger["rates"] => ({
  upstashCpuHourUsd: { ...rates.boxActiveCpuHourlyUsd },
  daytona: { vcpuHour: DAYTONA_RATES.vcpuHour, memoryGibHour: DAYTONA_RATES.memoryGibHour },
})

/** A task turn as Store.ledgerTurns reads it; `current`: its task's current turn, so unfinished it runs to the range's end. */
interface LedgerTurnRow {
  taskId: string
  projectId: string
  boxId: string | null
  startedAt: number
  finishedAt: number | null
  current: number
}

/** The turns that overlap [from, to), an unfinished current one running to `to` (any other unfinished one, not at all). */
const turnsIn = (rows: LedgerTurnRow[], from: number, to: number): LedgerTurn[] =>
  rows.flatMap((t) =>
    t.startedAt < to && (t.finishedAt === null || t.finishedAt > from)
      ? [{ taskId: t.taskId, projectId: t.projectId, boxId: t.boxId, startedAt: t.startedAt, endedAt: t.finishedAt ?? (t.current ? to : t.startedAt) }]
      : [],
  )

const intervalCost = (r: BoxUsageIntervalRow, rates: CostRates, share = 1) =>
  boxCost(
    {
      activeMs: r.compute_usd === null || r.compute_usd === undefined ? r.active_ms * share : 0,
      computeUsd: r.compute_usd === null || r.compute_usd === undefined ? null : r.compute_usd * share,
      uptimeMs: r.uptime_ms * share,
      diskBytes: r.disk_bytes,
      size: r.size,
      keepAlive: Boolean(r.keep_alive),
    },
    rates,
  )

/** A box's cost over its whole life so far, from its row: the part whose price is fixed, and the rest of its CPU at Settings' rates. */
export function boxRowCost(b: BoxRow, rates: CostRates, now = Date.now()): number {
  return boxCost(
    {
      activeMs: Math.max(0, (b.active_ms ?? 0) - (b.priced_active_ms ?? 0)),
      computeUsd: b.priced_usd ?? 0,
      uptimeMs: Math.max(0, now - b.created_at),
      diskBytes: b.disk_bytes,
      size: normalizeBoxSize(b.size),
      keepAlive: Boolean(b.keep_alive),
    },
    rates,
  )
}

/** A box made this recently started its CPU and cost counters with it, so their first reading is all its own use. */
const FRESH_BOX_MS = 15 * 60_000
const freshBox = (row: Pick<BoxRow, "created_at">, now: number) => now - row.created_at < FRESH_BOX_MS

/**
 * What one meter tick moves out of a box's row into a usage interval (TaskManager.meterBoxes), and how the row changes.
 *
 * - CPU: what the box's counters measured since the last tick ("measured"). A box nothing measured yet (no reading,
 *   or a provider without its own cgroup, like local folders) counts wall-clock time while a turn runs ("estimated").
 * - Price: the CPU at Settings' rate for the box's size, so a change of rates reprices it. Once the provider prices
 *   the box itself (Upstash's total_compute_cost_usd), the interval's price is fixed: whichever of the provider's
 *   total and the measured CPU's price is higher grows by this much. The bill is never under-counted, even if the
 *   provider's total leaves some CPU out. The interval is "actual" while the provider's figure is the higher one.
 */
export function meterTick(b: BoxRow, rateUsdPerCpuHour: number, elapsedMs: number, running: boolean) {
  const measured = (b.cgroup_cpu_usec ?? null) !== null || (b.provider_cpu_ns ?? null) !== null
  const cpuMs = measured ? Math.max(0, b.pending_cpu_ms ?? 0) : running ? elapsedMs : 0
  const base: Parameters<Store["meterBox"]>[1] = { activeMs: (b.active_ms ?? 0) + cpuMs, pendingCpuMs: 0, pendingComputeUsd: 0 }
  if ((b.provider_compute_usd ?? null) === null) {
    const source: UsageSource = measured ? "measured" : "estimated"
    return { activeMs: cpuMs, computeUsd: null, source, patch: { ...base, usageSource: source } }
  }
  const before = Math.max(b.measured_usd ?? 0, b.provider_usd ?? 0)
  // Unmeasured CPU is a guess, so then the provider's figure stands alone.
  const measuredUsd = (b.measured_usd ?? 0) + (measured ? (cpuMs / 3_600_000) * rateUsdPerCpuHour : 0)
  const providerUsd = (b.provider_usd ?? 0) + Math.max(0, b.pending_compute_usd ?? 0)
  const computeUsd = Math.max(0, Math.max(measuredUsd, providerUsd) - before)
  const source: UsageSource = providerUsd >= measuredUsd ? "actual" : "measured"
  return {
    activeMs: cpuMs,
    computeUsd,
    source,
    patch: {
      ...base,
      usageSource: source,
      pricedActiveMs: (b.priced_active_ms ?? 0) + cpuMs,
      pricedUsd: (b.priced_usd ?? 0) + computeUsd,
      providerUsd,
      measuredUsd,
    },
  }
}

function usageWindows(now: number): Pick<UsageWindow, "key" | "label" | "since">[] {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return [
    { key: "today", label: "Today", since: day.getTime() },
    { key: "7d", label: "Last 7 days", since: now - 7 * 24 * 60 * 60 * 1000 },
    { key: "30d", label: "Last 30 days", since: now - 30 * 24 * 60 * 60 * 1000 },
  ]
}

/** The cloud limits (Settings › Daily / Monthly cloud limit) against what boxes cost; today's raises count today. */
function budgetStatus(budget: BudgetSettings, today: number, month: number, raisedToday: number): BudgetStatus {
  const state = (usedUsd: number, limitUsd: number) => ({
    limitUsd,
    usedUsd,
    exceeded: limitUsd > 0 && usedUsd >= limitUsd,
    warning: limitUsd > 0 && usedUsd >= limitUsd * 0.8,
  })
  const daily = state(today, budget.dailyUsd > 0 ? budget.dailyUsd + raisedToday : 0)
  const monthly = state(month, budget.monthlyUsd)
  return { daily, monthly, blocked: daily.exceeded || monthly.exceeded }
}

export class NotFoundError extends Error {
  status = 404
}

export class BadRequestError extends Error {
  status = 400
}

/** The request is fine but the thing is busy or in the way right now (e.g. agents running on a box). */
export class ConflictError extends Error {
  status = 409
}

/** The error for a refused change to a queued chat message (see Store.editQueuedChat). */
export function queuedChatError(reason: "delivered" | "deleted" | "missing", who: string): Error {
  if (reason === "missing") return new NotFoundError("No such message.")
  if (reason === "deleted") return new ConflictError("That message was deleted.")
  return new ConflictError(`That message was already delivered to ${who}, so it can't be changed.`)
}

/** Accept `owner/name`, `github.com/owner/name`, or a full URL. Returns null for empty. */
export function normalizeRepo(repo: string | null | undefined): string | null {
  if (!repo) return null
  let r = repo.trim()
  if (!r) return null
  r = r.replace(/\.git$/, "").replace(/\/+$/, "")
  const gh = r.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)$/i)
  if (gh) return `${gh[1]}/${gh[2]}`
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return r
  if (/^(https?:\/\/|git@)/.test(r)) return r
  throw new BadRequestError(`Can't read repo "${repo}". Use owner/name or a git URL.`)
}

/** A clone URL for a normalized repo. Tokens are never put in the URL. */
export function cloneUrl(repo: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo}.git`
  return repo
}

/** owner/name for GitHub repos, else null. */
export function githubSlug(repo: string | null): string | null {
  if (!repo) return null
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return repo
  const m = repo.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  return m ? `${m[1]}/${m[2]}` : null
}

interface TurnTimingRow {
  id: string
  role: string
  kind: string
  project_id: string | null
  task_id: string | null
  session_id: string | null
  model: string | null
  effort: string | null
  trigger: string | null
  resumed: number
  ok: number
  requested_at: number | null
  started_at: number
  ended_at: number
  total_ms: number
  stages_json: string
  steps_json: string
  login_id: string | null
}

function timingFromRow(r: TurnTimingRow): TurnTiming {
  const parse = <T>(text: string, fallback: T): T => {
    try {
      return JSON.parse(text) as T
    } catch {
      return fallback
    }
  }
  return {
    ...parse<Partial<TurnTiming>>(r.stages_json, {}),
    id: r.id,
    role: r.role as TurnRole,
    kind: r.kind,
    projectId: r.project_id,
    taskId: r.task_id,
    sessionId: r.session_id,
    model: r.model,
    effort: r.effort,
    trigger: r.trigger,
    resumed: Boolean(r.resumed),
    ok: Boolean(r.ok),
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    totalMs: r.total_ms,
    loginId: r.login_id ?? null,
    steps: parse(r.steps_json, []),
  } as TurnTiming
}
