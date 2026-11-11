import { appHref } from "../lib/navigation"
import { openBeside, usePanelPlace } from "../lib/panelStack"
import { Children, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ComponentProps, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react"
import { createPortal, flushSync } from "react-dom"
import renderMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { PluggableList } from "unified"
import { useLocation } from "wouter"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, Box, Check, ChevronDown, ChevronUp, ChevronsUp, Copy, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, HardDrive, Loader2, type LucideIcon } from "lucide-react"
import { hintForHref, useEntityIndex } from "../lib/entities"
import {
  entityLookupsKey,
  followAppLink,
  githubRef,
  linkTarget,
  mayHaveGithubRef,
  MENTIONS,
  newLookups,
  remarkEntityLinks,
  shortGithubLabel,
  shortSha,
  splitGithubRefs,
  type EntityIndex,
  type EntityLookups,
  type RepoScope,
} from "../lib/linkify"
import { RepoContext, repoScopeKey, resolveRepoScope, useRepoScopeKey } from "../lib/repoScope"
import { liveMarkdown, type LiveMarkdown, type RenderMarkdown } from "../lib/liveMarkdown"
import { FileLink, PREVIEW_GROUP, galleryFor } from "./FileLink"
import { CueDot, TaskTile, WORKING_PULSE, agentIconCue, agentIconLabel, projectColorStyle } from "./TaskIcon"
import { Helm } from "./ShipIcons"
import { CaptainIcon, CaptainTile } from "./CaptainIcon"
import { clickImage, imageTarget, openLightbox } from "../lib/lightbox"
import { openPreview } from "../lib/preview"
import { previewKind } from "../lib/filePreview"
import { fetchTasks, keys } from "../lib/queries"
import { copyText } from "../lib/clipboard"
import { toast } from "../lib/toast"
import { prLabel, prNumber, prStateOf, prTooltip, type BadgeStatus, type PrTask } from "../lib/prState"
import { absoluteTime, elapsedLabel, isoTime, timeAgo } from "../lib/time"
import type { BoxSize, PrState, Task, TaskStatus } from "../../../shared/types"
import type { ProjectColor } from "../../../shared/projectColors"
import { thumbUrl } from "../../../shared/thumbs"
import { withoutFormerHome } from "../../../shared/formerHome"

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ")
}

export const STATUS: Record<TaskStatus, { label: string; dot: string; chip: string }> = {
  queued: { label: "Queued", dot: "bg-zinc-500", chip: "bg-zinc-800 text-zinc-300" },
  starting: { label: "Starting", dot: "bg-sky-400 animate-pulse", chip: "bg-sky-500/10 text-sky-300" },
  working: { label: "Working", dot: "bg-sky-400 animate-pulse", chip: "bg-sky-500/10 text-sky-300" },
  needs_input: { label: "Needs you", dot: "bg-amber-400", chip: "bg-amber-500/15 text-amber-300" },
  waiting: { label: "Waiting on agent", dot: "bg-violet-400", chip: "bg-violet-500/10 text-violet-300" },
  idle: { label: "Idle", dot: "bg-zinc-500", chip: "bg-zinc-800 text-zinc-400" },
  pr_ready: { label: "PR ready", dot: "bg-emerald-400", chip: "bg-emerald-500/10 text-emerald-300" },
  done: { label: "Done", dot: "bg-emerald-600", chip: "bg-emerald-500/10 text-emerald-400" },
  failed: { label: "Failed", dot: "bg-red-500", chip: "bg-red-500/10 text-red-300" },
}

/** The pill for a task that is done because its PR merged (see badgeStatus in lib/prState). */
export const MERGED_BADGE = { label: "Merged", dot: "bg-merged", chip: "bg-merged/15 text-merged-fg" }

/** The pill for a task waiting for a usage limit to reset (see badgeStatus in lib/prState). */
export const LIMIT_BADGE = { label: "Waiting for limit", dot: "bg-amber-400", chip: "bg-amber-500/15 text-amber-300" }

/** The label, dot and chip colours a status pill takes. */
export const badgeLook = (status: BadgeStatus) => (status === "merged" ? MERGED_BADGE : status === "limit" ? LIMIT_BADGE : STATUS[status])

/** Pass `badgeStatus(task)` to show a purple Merged pill instead of Done when the task's PR merged. */
/**
 * A row's leading icon, centred on the first line of the text beside it however the text wraps. The box is one
 * line tall (`h-lh`: the line-height it inherits), so use it in an `items-start` row that sets the text's font size
 * and leading, and keep that leading on the text's first line.
 */
export function LineIcon({ icon: Icon, className, box, label }: { icon: LucideIcon; className?: string; box?: string; label?: string }) {
  return (
    <span className={cx("flex h-lh shrink-0 items-center", box)}>
      <Icon className={className} aria-label={label} aria-hidden={label ? undefined : true} />
    </span>
  )
}

/**
 * The icon at the top left of the Coordinator's chat (its helm, in the yard's yellow) and a Captain's (its icon, the
 * cap unless its project or Settings picks another, in its project's colour, as everywhere a Captain shows), as in
 * their boxes (ChatIcons.tsx, CaptainIcon.tsx). It is the header's status: while the agent works (or a Captain
 * compacts) it pulses gently (WORKING_PULSE), with a still sky dot in either motion mode. An error takes precedence
 * over working for the dot; the glyph keeps pulsing if still busy. Tooltips and screen readers say the state too.
 */
export function AgentIcon({ busy, compacting = false, error = false, kind = "captain", color, projectId, tile = false, announce = true }: {
  busy: boolean
  compacting?: boolean
  error?: boolean
  kind?: "coordinator" | "captain"
  color?: ProjectColor | null
  projectId?: string | null
  /** Sidebar/rail tile instead of a bare header/menu glyph; images retain their own shape. */
  tile?: boolean
  /** Headers announce transitions; repeated navigation icons expose an accessible name instead. */
  announce?: boolean
}) {
  const tint = kind === "coordinator" ? "text-yard-400" : color ? "text-(--pc)" : "text-zinc-300"
  const working = busy || compacting
  const model = { busy, compacting, error: error ? "error" : null }
  const cue = agentIconCue(model)
  const state = agentIconLabel(model)
  const className = cx("h-4 w-4", tint, working && WORKING_PULSE)
  return (
    <span data-testid="agent-status-icon" className="relative flex shrink-0" title={state} role={!announce && state ? "img" : undefined} aria-label={!announce ? state : undefined} style={kind === "captain" ? projectColorStyle(color) : undefined}>
      {tile ? (
        <span data-testid="agent-icon" data-busy={working || undefined} className={cx("grid h-5 w-5 place-items-center", working && WORKING_PULSE)}>
          {kind === "captain" && projectId ? (
            <CaptainTile projectId={projectId} className="h-5 w-5" glyph="h-3.5 w-3.5" />
          ) : (
            <span className="grid h-5 w-5 place-items-center rounded-md bg-yard-500/15 text-yard-400"><Helm className="h-3.5 w-3.5" aria-hidden /></span>
          )}
        </span>
      ) : kind === "captain" ? (
        <CaptainIcon projectId={projectId} data-testid="agent-icon" data-busy={working || undefined} data-color={color ?? undefined} className={className} rounded="rounded-[4px]" />
      ) : <Helm data-testid="agent-icon" data-busy={working || undefined} className={className} aria-hidden />}
      <CueDot cue={cue} />
      {announce && <span className="sr-only" aria-live="polite">
        {state ?? ""}
      </span>}
    </span>
  )
}

export function StatusBadge({ status }: { status: BadgeStatus }) {
  const s = badgeLook(status)
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", s.chip)}>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
      {s.label}
    </span>
  )
}

/** A chip outside the task header (cards, published-file notices): 44px tall on phones, 24px from sm. The header uses HEADER_CHIP. */
export const META_CHIP =
  "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition sm:h-6 sm:min-h-0 sm:px-1.5"

/**
 * A compact control's tap area: 44px tall on touch screens (pointer: coarse) without drawing it any bigger. Its row
 * must leave the room (`pointer-coarse:min-h-11`, or a 16px gap between wrapped rows) so two areas never overlap.
 */
export const TAP_AREA =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:-translate-y-1/2"

/** The task header's chips (PR, preview, where it runs, files): 28px tall, 44px to a finger (TAP_AREA). */
export const HEADER_CHIP = cx(
  TAP_AREA,
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none",
)

/**
 * The task header's narrow form (its `@container/head` under 36rem: a phone, a slim panel): a chip folds to its icon,
 * drawn like the header's back and ⓘ buttons (32px, 44px to a finger), so the whole header fits one row. Its words
 * stay for screen readers (`label`), and the tooltip still has them.
 */
export const HEADER_FOLD = {
  chip: "@max-[36rem]/head:h-8 @max-[36rem]/head:min-w-8 @max-[36rem]/head:justify-center @max-[36rem]/head:rounded-lg @max-[36rem]/head:border-transparent @max-[36rem]/head:bg-transparent @max-[36rem]/head:px-1.5 @max-[36rem]/head:hover:bg-zinc-800 pointer-coarse:@max-[36rem]/head:h-11 pointer-coarse:@max-[36rem]/head:min-w-11",
  label: "@max-[36rem]/head:sr-only",
  icon: "@max-[36rem]/head:h-4 @max-[36rem]/head:w-4",
} as const

/** The quiet form of StatusBadge for header meta rows: a colored dot and the label, no pill. */
export function StatusDot({ status, title, children, className, labelClassName }: { status: BadgeStatus; title?: string; children?: ReactNode; className?: string; labelClassName?: string }) {
  const s = badgeLook(status)
  return (
    <span title={title} data-status={status} className={cx("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap", status === "idle" ? "text-zinc-400" : "text-zinc-200", className)}>
      <span className={cx("h-2 w-2 shrink-0 rounded-full", s.dot)} aria-hidden />
      {labelClassName ? <span className={labelClassName}>{s.label}</span> : s.label}
      {children}
    </span>
  )
}

/** Marks a quiet schedule run (the agent found nothing to do; shared/quiet.ts). */
export function QuietPill({ className }: { className?: string }) {
  return (
    <span
      title="Quiet run: the agent found nothing to do and changed nothing, so it's hidden from Recent and notifications."
      className={cx("inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400", className)}
    >
      Quiet
    </span>
  )
}

/** A queued task that jumps the queue (shared/priority.ts): it goes before every normal task waiting for a slot. */
export const waitsHighPriority = (task: Pick<Task, "priority" | "status">) => task.priority === "high" && task.status === "queued"

const PRIORITY_TITLE = "High priority: it goes before every normal task waiting for a slot. Running tasks are never stopped for it."

/**
 * The "High priority" pill on a queued task (nothing otherwise). `compact`: the icon alone, for tight rows; the title
 * and label still say it.
 */
export function PriorityPill({ task, compact, className }: { task: Pick<Task, "priority" | "status">; compact?: boolean; className?: string }) {
  if (!waitsHighPriority(task)) return null
  return (
    <span
      data-testid="priority-pill"
      title={PRIORITY_TITLE}
      aria-label={compact ? "High priority" : undefined}
      className={cx("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-orange-500/15 text-xs font-medium text-orange-300", compact ? "p-0.5" : "py-0.5 pr-2 pl-1.5", className)}
    >
      <ChevronsUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {!compact && "High priority"}
    </span>
  )
}

/** The icon for why a queued task waits: a box when it waits for a box of its project's size, else a disk. */
export const waitIconOf = (task: { waitBoxSize?: BoxSize | null }): LucideIcon => (task.waitBoxSize ? Box : HardDrive)

export function WaitIcon({ task, className }: { task: { waitBoxSize?: BoxSize | null }; className?: string }) {
  const Icon = waitIconOf(task)
  return <Icon className={className} aria-hidden />
}

/** GitHub's PR colors and icons: open green, draft gray, merged purple, closed red. */
export const PR_STYLE: Record<PrState, { icon: LucideIcon; chip: string; link: string }> = {
  open: { icon: GitPullRequest, chip: "border-emerald-900/60 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20", link: "text-emerald-400" },
  draft: { icon: GitPullRequestDraft, chip: "border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800", link: "text-zinc-400" },
  merged: { icon: GitMerge, chip: "border-merged/50 bg-merged/15 text-merged-fg hover:bg-merged/25", link: "text-merged-fg" },
  closed: { icon: GitPullRequestClosed, chip: "border-red-900/60 bg-red-500/10 text-red-300 hover:bg-red-500/15", link: "text-red-400" },
}

/**
 * A task's pull request: "PR #23", "Draft #23", "Merged #23" or "Closed #23" in GitHub's colors. `chip` is the
 * bordered pill (task header), `link` the plain inline link (card footers), `number` just the number and ↗ (compact
 * task rows), with the state in its accessible name. Renders nothing without a PR.
 * `activity` folds a running action into the chip ("PR #23 · merging…" with a spinner) instead of a second pill.
 * `fold`: in the task header, it folds to its glyph when the header is narrow (HEADER_FOLD). `verb` leads the label as
 * an action ("Review PR #23").
 */
export function PrChip({
  task,
  variant = "chip",
  className,
  activity,
  fold,
  verb,
}: {
  task: PrTask
  variant?: "chip" | "link" | "number"
  className?: string
  activity?: { icon: ReactNode; label: string; title: string } | null
  fold?: boolean
  verb?: string
}) {
  const state = prStateOf(task)
  if (!state || !task.prUrl) return null
  const s = PR_STYLE[state]
  const Icon = s.icon
  const tooltip = prTooltip(task)
  const number = prNumber(task.prUrl)
  return (
    <NewTabLink
      href={task.prUrl}
      mark="end"
      markClassName={fold ? HEADER_FOLD.label : undefined}
      title={(activity ? `${activity.title}\n${tooltip}` : tooltip) ?? undefined}
      aria-label={variant === "number" ? `${prLabel(task)} on GitHub (opens in a new tab)` : undefined}
      data-pr-state={state}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap",
        variant === "chip" ? cx("rounded-md border px-1.5 py-0.5 font-medium transition", s.chip) : cx("hover:underline", s.link),
        className,
        fold && HEADER_FOLD.chip,
      )}
    >
      {variant !== "number" && <>{activity ? activity.icon : <Icon className={cx(variant === "chip" ? "h-3 w-3" : "h-3.5 w-3.5", fold && HEADER_FOLD.icon)} />}{" "}</>}
      <span className={cx(fold && HEADER_FOLD.label)}>{variant === "number" && number ? `#${number}` : verb ? `${verb} ${prLabel(task)}` : prLabel(task)}</span>
      {activity && <span className={cx("font-normal", fold && HEADER_FOLD.label)}>· {activity.label}</span>}
    </NewTabLink>
  )
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "ghost" | "danger" | "subtle"
  size?: "sm" | "md"
  loading?: boolean
}

export function Button({ variant = "subtle", size = "md", loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:min-w-0",
        size === "sm" ? "px-3 py-2 text-xs sm:px-2.5 sm:py-1" : "px-3.5 py-2 text-sm",
        variant === "primary" && "bg-action text-on-action hover:bg-action-hover",
        variant === "subtle" && "bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
        variant === "ghost" && "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
        variant === "danger" && "bg-red-500/10 text-red-300 hover:bg-red-500/20",
        className,
      )}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  )
}

// Parsed markdown by source text. Long threads re-mount messages (switching tasks, loading earlier ones),
// and parsing + GFM + entity links is the most expensive part of rendering a message. There's one cache for
// markdown with entity links, keyed by the repo GitHub references link to (InRepo) and the text, and one without.
// Linked output depends on the entity index only through what the text mentions, so each entry keeps what it looked
// up (EntityLookups) and is reused under a newer index when that all comes out the same: an entity added, removed or
// renamed elsewhere (a new task, artifact or box) no longer parses every message on screen again.
type Linked = { out: ReactNode; index: EntityIndex; lookups: EntityLookups; key: string }
const MARKDOWN_CACHE_MAX = 3000
const PLAIN_PLUGINS: PluggableList = [remarkGfm]
const plainCache = new Map<string, ReactNode>()
const linkedCache = new Map<string, Linked>()
// Streamed text's plugins, one list per repo under the newest index: liveMarkdown starts over when they change.
let livePlugins: { index: EntityIndex | null; byRepo: Map<RepoScope, PluggableList> } = { index: null, byRepo: new Map() }

function pluginsFor(index: EntityIndex | null, repo: RepoScope): PluggableList {
  if (!index) return PLAIN_PLUGINS
  if (livePlugins.index !== index) livePlugins = { index, byRepo: new Map() }
  let plugins = livePlugins.byRepo.get(repo)
  if (!plugins) livePlugins.byRepo.set(repo, (plugins = [remarkGfm, [remarkEntityLinks, index, repo]]))
  return plugins
}

const linkedKey = (text: string, repo: RepoScope) => (repo ? `${repo}\u0000${text}` : text)

// Refresh an entry's spot so the cache drops the least recently used one first.
function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  cache.delete(key)
  if (cache.size >= MARKDOWN_CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, value)
  return value
}

/** The cached parse of `text` that's right for `index`, if there is one. */
function linkedHit(key: string, index: EntityIndex): Linked | undefined {
  const hit = linkedCache.get(key)
  if (!hit || hit.index === index) return hit
  if (entityLookupsKey(hit.lookups, index) !== hit.key) return undefined
  hit.index = index
  return hit
}

function parsedMarkdown(text: string, index: EntityIndex | null, repo: RepoScope = null): ReactNode {
  if (!index) return remember(plainCache, text, plainCache.get(text) ?? renderMarkdown({ children: text, remarkPlugins: PLAIN_PLUGINS, components: MARKDOWN_COMPONENTS }))
  const key = linkedKey(text, repo)
  const hit = linkedHit(key, index)
  if (hit) return remember(linkedCache, key, hit).out
  const lookups = newLookups()
  const out = renderMarkdown({ children: text, remarkPlugins: [remarkGfm, [remarkEntityLinks, index, repo, lookups]], components: MARKDOWN_COMPONENTS })
  return remember(linkedCache, key, { out, index, lookups, key: entityLookupsKey(lookups, index) }).out
}

// Texts waiting to be parsed in idle time, by cache key, each with the repo to link it for, and the index for all.
const warmQueue = new Map<string, { text: string; repo: RepoScope }>()
let warmIndex: EntityIndex | null = null
let warming = false
const idle: (cb: (deadline?: { timeRemaining(): number }) => void) => void =
  typeof requestIdleCallback === "function" ? (cb) => requestIdleCallback(cb, { timeout: 2000 }) : (cb) => setTimeout(cb, 50)

/**
 * Parse markdown that isn't on screen yet (older messages, a prefetched Captain's chat) while the browser is idle,
 * so showing it only costs building the DOM. `repo` is the thread's useRepoScope(), as <Markdown> sees it.
 */
export function warmMarkdown(texts: string[], index: EntityIndex, repo: RepoScope = null) {
  if (warmIndex !== index) warmQueue.clear()
  warmIndex = index
  // Newest first: those are the next ones scrolled into. One parsed for an older index is checked when it's shown.
  for (let i = texts.length - 1; i >= 0; i--) {
    const key = linkedKey(texts[i]!, repo)
    if (!linkedCache.has(key)) warmQueue.set(key, { text: texts[i]!, repo })
  }
  if (warming || !warmQueue.size) return
  warming = true
  const step = (deadline?: { timeRemaining(): number }) => {
    const until = performance.now() + (deadline ? Math.min(deadline.timeRemaining(), 12) : 8)
    for (const [key, { text, repo }] of warmQueue) {
      if (performance.now() >= until) break
      warmQueue.delete(key)
      if (warmIndex && !linkedCache.has(key) && linkedCache.size < MARKDOWN_CACHE_MAX - 100) parsedMarkdown(text, warmIndex, repo)
    }
    if (warmQueue.size) idle(step)
    else warming = false
  }
  idle(step)
}

/** The repo <Markdown> under this component links GitHub references to (see InRepo). */
export function useRepoScope(): RepoScope {
  const index = useEntityIndex()
  return resolveRepoScope(useRepoScopeKey(), index)
}

/**
 * Says which repo the text under it is about, so "PR #406", "#12" and "head 5f3a9c1e" in its <Markdown> and
 * <LinkedText> link there: a task's (its project's repo), a project's, or `mentions` for text that spans projects
 * (the Coordinator's replies), where each paragraph links only when the entities it mentions share one repo.
 */
export function InRepo({ taskId, projectId, mentions, children }: { taskId?: string | null; projectId?: string | null; mentions?: boolean; children: ReactNode }) {
  return <RepoContext.Provider value={repoScopeKey({ taskId, projectId, mentions })}>{children}</RepoContext.Provider>
}

const renderLive: RenderMarkdown = (children, remarkPlugins, rehypePlugins) => renderMarkdown({ children, remarkPlugins, rehypePlugins, components: MARKDOWN_COMPONENTS })

/**
 * Rendered markdown, with Box Yard entity mentions and GitHub references (to the InRepo's repo) linked unless
 * `linkify` is off. Memoized on the text, and the parsed output is cached across mounts. `live` text (a reply still
 * streaming in) changes on every chunk, so it skips the cache and parses only what the chunk can change
 * (lib/liveMarkdown.ts).
 */
export const Markdown = memo(function Markdown({ children, linkify = true, live }: { children: string; linkify?: boolean; live?: boolean }) {
  const index = useEntityIndex()
  const scope = useRepoScopeKey()
  const stream = useRef<LiveMarkdown | null>(null)
  const parser = linkify ? index : null
  const repo = linkify ? resolveRepoScope(scope, index) : null
  return (
    <div className="prose-chat wrap-anywhere" {...PREVIEW_GROUP}>
      {live ? (stream.current = liveMarkdown(stream.current, children, pluginsFor(parser, repo), renderLive)).node : parsedMarkdown(children, parser, repo)}
    </div>
  )
})

/** How a link to another site looks outside `.prose-chat` (styles.css): sky and underlined. */
const EXTERNAL_TEXT_LINK = "text-sky-400 underline decoration-sky-400/40 underline-offset-2 hover:decoration-sky-400"

/**
 * Plain text (a card's summary, a question, a chip's preview) with its GitHub references linked to the InRepo's
 * repo, for places that don't render markdown.
 */
export const LinkedText = memo(function LinkedText({ text }: { text: string }) {
  // Most text has no reference: skip the entity index (a card grid has hundreds of these).
  return mayHaveGithubRef(text) ? <GithubRefText text={text} /> : text
})

function GithubRefText({ text }: { text: string }) {
  const repo = useRepoScope()
  const parts = splitGithubRefs(text, repo === MENTIONS ? null : repo)
  if (parts.length === 1 && !parts[0]!.url) return text
  return parts.map((p, i) =>
    p.url ? (
      <GithubTextLink key={i} href={p.url} title={p.label ? p.text : undefined} className={EXTERNAL_TEXT_LINK}>
        {p.label ?? p.text}
      </GithubTextLink>
    ) : (
      p.text
    ),
  )
}

/** A link to a task page (`/tasks/task_…`, maybe with the origin): the task's id. */
const TASK_HREF = /^(?:https?:\/\/[^/]+)?\/tasks\/(task_[A-Za-z0-9-]{6,40})\/?$/

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href = "", title, children }) => {
    const home = withoutFormerHome(href) ?? href
    const taskId = TASK_HREF.exec(href)?.[1] ?? (home.startsWith("/?") ? new URLSearchParams(home.slice(2)).get("task") : null)
    // A whole commit SHA as the link's text reads as its short form, the whole one in its tooltip.
    const sha = typeof children === "string" && isLongSha(children) ? children : null
    return (
      <AppLink href={href} title={title ?? sha ?? undefined}>
        {/* A task link leads with the task's tile, in its project's colour. */}
        {taskId && <TaskTile id={taskId} bare className="mr-0.5 align-[-1px]" />}
        {/* A bare URL the model pasted (GFM autolinks it, text = href): "PR #154" reads better than the whole URL. */}
        {(sha && shortSha(sha)) || (typeof children === "string" && isRawUrl(children, href) && shortGithubLabel(href)) || children}
      </AppLink>
    )
  },
  pre: ({ node, ...props }) => <CodeBlock lines={codeLineCount(node)} {...props} />,
  img: ({ src, alt, title }) => <ChatImage src={typeof src === "string" ? src : ""} alt={alt} title={title} />,
}

/**
 * An image in a chat or a transcript: a click opens it in the lightbox, or in the file preview when Box Yard
 * hosts it (lib/lightbox.ts), with the message's other hosted images as its ←/→ gallery. An image inside a link
 * stays the link's. A hosted image shows as a thumbnail at most 1280 px wide (shared/thumbs.ts); the click and the
 * gallery open the original.
 */
function ChatImage({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const target = imageTarget(src)
  return (
    <img
      src={thumbUrl(src, 1280)}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      decoding="async"
      data-lightbox={target !== null || undefined}
      data-preview={target === "preview" && previewKind({ url: src }) === "image" ? "image" : undefined}
      data-preview-url={target === "preview" ? src : undefined}
      className={target ? "cursor-zoom-in" : undefined}
      onClick={(e) => {
        const el = e.currentTarget
        const preview = (url: string) => openPreview({ url }, galleryFor(el, { url }))
        if (!clickImage(e.nativeEvent, { src, alt }, { preview, lightbox: openLightbox })) return
        // Inside a clickable card (a notice), open the image and not the card.
        e.stopPropagation()
      }}
    />
  )
}

const isLongSha = (text: string) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(text)

const isRawUrl = (text: string, href: string) => text === href || text.replace(/\/$/, "") === href.replace(/\/$/, "")

/** A code block's text as written: markdown adds one newline after a fenced block's last line, which isn't the code's. */
export const codeBlockText = (pre: HTMLElement) => (pre.textContent ?? "").replace(/\n$/, "")

/** A code block with more lines than this folds in chat to its first 12 (`.code-block[data-folded]` in styles.css). */
export const CODE_FOLD_LINES = 20

type HastNode = { type: string; value?: string; children?: HastNode[] }

/** How many lines a fenced code block (its hast `pre`) has, not counting the newline markdown adds after the last. */
export function codeLineCount(node: HastNode | undefined): number {
  let text = ""
  const walk = (n: HastNode) => {
    if (n.type === "text") text += n.value ?? ""
    n.children?.forEach(walk)
  }
  if (node) walk(node)
  return text.replace(/\n$/, "").split("\n").length
}

/**
 * A fenced code block with a copy button in a gutter of its own at the top right, so the button never covers the code,
 * however narrow the panel or far the block is scrolled sideways. The button shows on hover and focus, always on touch.
 * A long block (over CODE_FOLD_LINES) folds to its first lines, with a "Show all N lines" row under it; Copy still
 * copies all of it.
 */
function CodeBlock({ lines, ...props }: ComponentProps<"pre"> & { lines: number }) {
  const block = useRef<HTMLDivElement>(null)
  const pre = useRef<HTMLPreElement>(null)
  const [open, setOpen] = useState(false)
  const folds = lines > CODE_FOLD_LINES
  const toggle = () => {
    if (!open) return setOpen(true)
    flushSync(() => setOpen(false))
    // Folded from its end, the block's top can be far above: bring it back, at once, so the reader stays at the block.
    block.current?.scrollIntoView({ block: "nearest" })
  }
  return (
    <div ref={block} className="code-block group/code" data-folded={(folds && !open) || undefined}>
      <pre ref={pre} {...props} />
      <CopyButton label="Copy code" text={() => (pre.current ? codeBlockText(pre.current) : "")} className="mt-2 mr-1.5 ml-0.5" />
      {folds && (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="code-fold flex basis-full items-center gap-1 rounded-b-lg px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500/60 focus-visible:outline-none pointer-coarse:min-h-11"
        >
          {open ? <ChevronUp className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          {open ? "Show less" : `Show all ${lines} lines`}
        </button>
      )}
    </div>
  )
}

/**
 * A small copy icon that flashes "Copied". Its icon box is one 16px line tall (`leading-4`) with 4px above, so with
 * `mt-2` it sits on the first line of a `p-3` code block. Hidden until its `group/code` is hovered, unless focused,
 * just used, or on a touch screen. `text` is read on click, so the copied text is what's on screen then.
 */
export function CopyButton({ text, label, className }: { text: string | (() => string); label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      aria-label={label}
      title={copied ? "Copied" : label}
      data-copied={copied || undefined}
      onClick={async () => {
        if (!(await copyText(typeof text === "function" ? text() : text))) {
          toast.error("Couldn't copy", "The browser blocked clipboard access.")
          return
        }
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      }}
      className={cx(
        "relative flex shrink-0 self-start rounded-md px-1.5 py-1 text-xs leading-4 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-yard-500/60 focus-visible:outline-none pointer-coarse:opacity-100",
        // 44px to a finger without drawing it any bigger, so the gutter doesn't take more of the code's width.
        "pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-1/2",
        copied ? "opacity-100" : "opacity-0 group-hover/code:opacity-100",
        className,
      )}
    >
      <LineIcon icon={copied ? Check : Copy} className={cx("h-3.5 w-3.5", copied && "text-emerald-400")} />
      {/* Announced, and shown beside the icon while the user's eyes are on it. */}
      <span
        role="status"
        className={
          copied
            ? "pointer-events-none absolute top-1/2 right-full mr-1 -translate-y-1/2 rounded-md bg-zinc-800 px-1.5 py-0.5 font-sans text-[11px] font-medium whitespace-nowrap text-zinc-100 shadow"
            : "sr-only"
        }
      >
        {copied ? "Copied" : ""}
      </span>
    </button>
  )
}

/** How long a copy button says "Copied". */
export const COPIED_MS = 1500

/**
 * The ↗ after every link that leaves Box Yard (NewTabLink), so a link that opens another site in a new tab never
 * looks like one that stays in the app. Screen readers hear "opens in a new tab".
 */
export function ExternalMark({ className }: { className?: string }) {
  return (
    <ArrowUpRight
      data-external-mark=""
      role="img"
      aria-label="(opens in a new tab)"
      aria-hidden={false}
      className={cx("ml-px inline-block h-[0.95em] w-[0.95em] shrink-0 align-[-0.125em]", className)}
    />
  )
}

/** How many trailing characters of a long last word stay glued to the ↗ (a whole long URL can't stay on one line). */
const GLUE_MAX = 12

/**
 * `children` with `mark` glued to the end of the last word, in one nowrap span, so the ↗ never wraps onto a line by
 * itself. A long unbroken word (a URL) keeps only its last few characters with the mark, so it still wraps.
 */
export function glueMark(children: ReactNode, mark: ReactNode): ReactNode {
  const parts = Children.toArray(children)
  const last = parts.pop()
  if (typeof last === "string" || typeof last === "number") {
    const text = String(last)
    const space = text.search(/\s\S*$/) + 1
    let cut = Math.max(space, text.length - GLUE_MAX)
    // Never split a surrogate pair (an emoji).
    if (cut > 0 && cut < text.length && /[\uDC00-\uDFFF]/.test(text[cut]!)) cut--
    return (
      <>
        {parts}
        {text.slice(0, cut)}
        <span className="whitespace-nowrap">
          {text.slice(cut)}
          {mark}
        </span>
      </>
    )
  }
  return (
    <>
      {parts}
      <span className="whitespace-nowrap">
        {last}
        {mark}
      </span>
    </>
  )
}

/**
 * A link to another site (a GitHub PR, a preview, docs): always opens in a new tab without access to this one, ends
 * in the ↗ mark and shows its full URL on hover. `mark`: "glued" (default) for links in running text, "end" for a
 * flex chip or row (the mark is its last item), false for an icon-only button that already says where it goes.
 * Cards are often clickable themselves, so the click stops here and opens the link, not the card.
 */
export function NewTabLink({ onClick, mark = "glued", markClassName, title, href, children, ...rest }: ComponentProps<"a"> & { mark?: "glued" | "end" | false; markClassName?: string }) {
  const tip = !href || (title && title.includes(href)) ? title : title ? `${title}\n${href}` : href
  return (
    <a
      {...rest}
      href={href}
      title={tip}
      target="_blank"
      rel="noopener noreferrer"
      data-external=""
      onClick={(e) => {
        e.stopPropagation()
        onClick?.(e)
      }}
    >
      {mark === "glued" ? (
        glueMark(children, <ExternalMark />)
      ) : mark === "end" ? (
        <>
          {children}
          <ExternalMark className={cx("h-3 w-3", markClassName)} />
        </>
      ) : (
        children
      )}
    </a>
  )
}

/** The task whose PR this is, as a PrState ("" when no task has it), so a PR link in text can wear its state's colors. */
function usePrStateFor(url: string): PrState | "" {
  // A string, so the link re-renders only when that PR's state changes, not on every task update.
  const select = useCallback((tasks: Task[]) => prStateOfUrl(tasks, url) ?? "", [url])
  return useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select }).data ?? ""
}

/** PR_STYLE's link colors, `!` so they beat `.prose-chat a` (unlayered) and a caller's own color. */
const PR_TEXT: Record<PrState, string> = {
  open: "text-emerald-400!",
  draft: "text-zinc-400!",
  merged: "text-merged-fg!",
  closed: "text-red-400/80!",
}

/** "owner/repo#12" for a GitHub PR or issue URL, lower case: "/issues/12" is the same number as "/pull/12". */
const prKey = (url: string) => {
  const ref = githubRef(url)
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() : null
}
const taskWithPr = (tasks: Task[] | undefined, url: string) => {
  const key = prKey(url)
  return key ? tasks?.find((t) => t.prUrl && prKey(t.prUrl) === key) : undefined
}
function prStateOfUrl(tasks: Task[], url: string): PrState | null {
  const t = taskWithPr(tasks, url)
  return t ? prStateOf(t) : null
}

/**
 * A GitHub pull request or issue mentioned in text. A PR (or an "#12" that a task's PR has) gets the PR glyph and,
 * when a task has it, GitHub's state colors (merged is purple) like PrChip, then the ↗; hovering shows the state and
 * the URL. Any other issue is a plain NewTabLink.
 */
function GithubTextLink({
  href,
  title,
  className,
  children,
}: {
  href: string
  title?: string
  className?: string
  children: ReactNode
}) {
  const qc = useQueryClient()
  const state = usePrStateFor(href)
  if (githubRef(href)?.kind !== "pull" && !state)
    return (
      <NewTabLink href={href} title={title} className={className}>
        {children}
      </NewTabLink>
    )
  const Icon = state ? PR_STYLE[state].icon : GitPullRequest
  const onMouseEnter = (e: MouseEvent<HTMLElement>) => {
    if (title) return
    const task = taskWithPr(qc.getQueryData<Task[]>(keys.tasks), href)
    const tip = task ? prTooltip(task) : null
    if (tip) e.currentTarget.title = tip
  }
  return (
    <NewTabLink
      href={href}
      title={title}
      data-pr-link={state || "unknown"}
      onMouseEnter={onMouseEnter}
      className={cx(
        className,
        // "⎇ PR #154 ↗" stays on one line; longer link text wraps and keeps only its last word with the ↗.
        typeof children === "string" && children.length <= 24 && "whitespace-nowrap",
        state && cx(PR_TEXT[state], "decoration-current/40! hover:decoration-current!"),
      )}
    >
      <Icon aria-hidden className="mr-0.5 inline-block h-[0.95em] w-[0.95em] align-[-0.125em]" />
      {children}
    </NewTabLink>
  )
}

/**
 * A link that knows the app: in-app paths (relative or on Box Yard's own origin) navigate through the router
 * (Cmd/Ctrl/middle-click still open a tab), previewable files open in the preview modal, other files and sites
 * in a new tab. Clicks never reach a clickable card around the link. Hovering an entity link shows its title and current status.
 */
export function AppLink({ href, title, className, children, "aria-label": ariaLabel }: { href: string; title?: string; className?: string; children: ReactNode; "aria-label"?: string }) {
  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const place = usePanelPlace()
  const target = linkTarget(href, window.location.origin)
  const onMouseEnter = (e: MouseEvent<HTMLAnchorElement>) => {
    if (title || target.kind === "external") return
    const hint = hintForHref(qc, target.href, (s) => STATUS[s].label)
    if (hint) e.currentTarget.title = hint
  }
  if (target.kind === "file")
    return (
      <FileLink href={target.href} title={title} className={className} onMouseEnter={onMouseEnter}>
        {children}
      </FileLink>
    )
  if (target.kind !== "app") {
    if (githubRef(target.href))
      return (
        <GithubTextLink href={target.href} title={title} className={className}>
          {children}
        </GithubTextLink>
      )
    return (
      <NewTabLink href={target.href} title={title} className={className}>
        {children}
      </NewTabLink>
    )
  }
  const destination = appHref(target.href, window.location.origin)
  if (destination === null) return <span title={title} className={className}>{children}</span>
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // A link inside a clickable card (a notice, a row) goes where it points, not where the card does.
    e.stopPropagation()
    // On a phone, a task's sub-tasks (and its parent) open in a panel beside it (lib/panelStack.ts). Elsewhere a task, a
    // Captain or a schedule opens in the rightmost unpinned panel's place (lib/columns.ts, via the router).
    if (place && openBeside(e, destination, place.index, qc.getQueryData<Task[]>(keys.tasks), navigate)) return
    if (!followAppLink(e, destination, navigate)) return
    // pushState doesn't fire hashchange; pages that scroll to #id listen for it.
    if (target.href.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange"))
  }
  return (
    <a href={destination} title={title} aria-label={ariaLabel} className={className} onClick={onClick} onMouseEnter={onMouseEnter}>
      {children}
    </a>
  )
}

// The one way the UI says when (lib/time.ts); pages that format a time themselves import it from here.
export { timeAgo }

// One shared clock for every <TimeAgo>, instead of a timer per instance (a long thread has hundreds).
let clockNow = Date.now()
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null

/** The shared clock's time; fresh when nothing is ticking yet (the first mount). */
function clockTime() {
  if (!clockTimer) clockNow = Date.now()
  return clockNow
}

function subscribeClock(listener: () => void) {
  clockListeners.add(listener)
  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      clockListeners.forEach((l) => l())
    }, 30_000)
  }
  return () => {
    clockListeners.delete(listener)
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

/** The shared clock to the minute: a list of short ages ("12m") re-renders once a minute at most, not per row. */
export const useMinuteClock = () => useSyncExternalStore(subscribeClock, () => Math.floor(clockTime() / 60_000) * 60_000)

/** "4m ago" that updates itself, and says exactly when on hover or a tap. Re-renders only when its label changes. */
export const TimeAgo = memo(function TimeAgo({ ts }: { ts: number }) {
  const label = useSyncExternalStore(subscribeClock, () => timeAgo(ts, clockTime()))
  return <TimeLabel ts={ts} label={label} />
})

/** "12m", "1h 5m": how long since `since`, on TimeAgo's shared clock. `title` leads the exact time ("Running since …"). */
export const Elapsed = memo(function Elapsed({ since, title, className }: { since: number; title: string; className?: string }) {
  const label = useSyncExternalStore(subscribeClock, () => elapsedLabel(clockTime() - since))
  return <TimeLabel ts={since} label={label} lead={title} className={className} />
})

/** A time inside one of these is part of it: a tap there goes to the link or button, so the time keeps only its tooltip. */
const IN_CONTROL = "a[href], button, summary, label, [role=button], [role=link], [role=option], [role=menuitem], [role=tab]"

/**
 * A time's label with the exact moment (lib/time.ts absoluteTime, the browser's locale and time zone) as its tooltip
 * and, since a phone can't hover, in a bubble on a tap, Enter or Space. A second tap, a tap elsewhere, Escape or
 * tabbing away closes the bubble.
 */
function TimeLabel({ ts, label, lead, className }: { ts: number; label: string; lead?: string; className?: string }) {
  const ref = useRef<HTMLTimeElement>(null)
  const id = useId()
  // Assumed tappable, so the common case (a time on its own) never renders twice.
  const [tappable, setTappable] = useState(true)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => setTappable(!ref.current?.parentElement?.closest(IN_CONTROL)), [])
  const exact = absoluteTime(ts)
  const full = lead ? `${lead} ${exact}` : exact
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    // Its row may be clickable too (a card that opens): this tap was for the time.
    e.preventDefault()
    e.stopPropagation()
    setOpen((o) => !o)
  }
  const tap = tappable ? {
    role: "button",
    tabIndex: 0,
    "aria-expanded": open,
    "aria-describedby": open ? id : undefined,
    onClick: toggle,
    // A tap doesn't focus it: focus would also show the message's toolbar (MessageActions) around it.
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
    onBlur: () => setOpen(false),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") toggle(e)
    },
  } : {}
  return (
    <>
      <time
        ref={ref}
        dateTime={isoTime(ts)}
        title={open ? undefined : full}
        className={cx(className, tappable && cx(TAP_AREA, "cursor-pointer rounded-sm decoration-dotted underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"))}
        {...tap}
      >
        {label}
      </time>
      {open && <TimeBubble id={id} anchor={ref} text={full} onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * The exact time just above its label (below when there's no room), inside the window, following it on scroll. While
 * it's up, Escape closes it and nothing else (not a dialog around it).
 */
function TimeBubble({ id, anchor, text, onClose }: { id: string; anchor: RefObject<HTMLElement | null>; text: string; onClose: () => void }) {
  const bubble = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const el = bubble.current
      if (!a || !el) return
      const vw = document.documentElement.clientWidth || window.innerWidth
      const left = Math.max(8, Math.min(a.left + a.width / 2 - el.offsetWidth / 2, vw - 8 - el.offsetWidth))
      const top = a.top - 6 - el.offsetHeight
      setStyle({ left, top: top >= 8 ? top : a.bottom + 6 })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [anchor])
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) closeRef.current()
    }
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("keydown", key, true)
    return () => {
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("keydown", key, true)
    }
  }, [anchor])
  return createPortal(
    <div
      ref={bubble}
      id={id}
      role="tooltip"
      data-testid="time-bubble"
      style={style}
      className="pointer-events-none fixed z-50 max-w-[calc(100vw-1rem)] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 tabular-nums shadow-lg shadow-black/40"
    >
      {text}
    </div>,
    document.body,
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 px-6 py-12 text-center">
      {icon && <div className="text-zinc-600">{icon}</div>}
      <div className="font-medium text-zinc-300">{title}</div>
      {children && <div className="max-w-md text-sm text-zinc-500">{children}</div>}
    </div>
  )
}

export const inputClass =
  "w-full min-h-11 rounded-lg border border-control bg-zinc-900 px-3 py-2 text-base text-zinc-100 placeholder:text-zinc-600 focus:border-yard-500 focus:outline-none focus:ring-2 focus:ring-yard-500/20 aria-invalid:border-red-500 sm:min-h-0 sm:text-sm"

const SELECT_SIZE = {
  md: "min-h-11 rounded-lg py-2 pr-9 pl-3 text-base sm:min-h-0 sm:text-sm",
  sm: "select-sm min-h-11 rounded-md py-2 pr-8 pl-3 text-sm sm:min-h-0 sm:py-1 sm:pr-7 sm:pl-2 sm:text-xs",
}

/** Native <select> with our own chevron, inset from the right edge, and room so long options never run under it. Pass width via className. */
export function Select({ size = "md", className, ...props }: Omit<ComponentProps<"select">, "size"> & { size?: keyof typeof SELECT_SIZE }) {
  return (
    <select
      {...props}
      className={cx(
        "select-chevron cursor-pointer border border-control bg-zinc-900 text-zinc-100 hover:border-zinc-500 focus:border-yard-500 focus:ring-2 focus:ring-yard-500/20 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        SELECT_SIZE[size],
        className,
      )}
    />
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}

/** Parse KEY=value lines into an env map. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq < 1) continue
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return env
}
