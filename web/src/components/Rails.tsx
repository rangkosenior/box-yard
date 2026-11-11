// The strips on a desktop, only with the sidebar folded (its icon rail): the levels above the item opened that aren't
// showing (lib/columns.ts hierarchyStrips), each 56px wide, just left of the first of its descendants showing. A
// Captain's strip lists its tasks (the sidebar's, in its order) with a tree button for their nesting; a task's, its
// sub-tasks. The level below on the way to the item opened is marked. Each item is a task's tile, saying its state as
// the sidebar's rows do (TaskStatusIcon: it pulses while the task works, a still dot says it asks or failed), and a tap
// opens it the way the sidebar does: just it, beside the pins. The 44px button on top (and the name down the strip)
// opens the level itself. Drawn like the sidebar's rail (Sidebar.tsx). Nothing slides: strips come and go with
// what's opened.
// A task filling the room (the chat hidden) shows its own sub-tasks the same way, in a bar just left of it, so the
// next level is in reach with the sidebar folded; a Captain's chat showing has its tasks in a bar left of the chat
// (ChatBar), so however it was opened its tasks are a tap away. The Coordinator has none: the sidebar's rail lists
// its projects.
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { ListTree, PanelLeftOpen } from "lucide-react"
import type { Project, Task } from "../../../shared/types"
import { useProjects, useTasks } from "../lib/queries"
import { usePendingCloses } from "../lib/inbox"
import { useBarPins } from "../lib/projectBar"
import { setPickedRow, sidebarGroups, taskKey, treeHidden, useTreeFolds, type Selection } from "../lib/sidebar"
import { chatRailGroups, railTreeGroups, taskRailTasks, type RailGroup } from "../lib/rails"
import { chatProject, chatRef, isChatRef, useChatHidden } from "../lib/columns"
import { usePanels, viewOf } from "../lib/panelStack"
import { navigateApp, openChat, taskSessionHref } from "../lib/navigation"
import { focusComposer, pickFocusesComposer } from "../lib/chatSwitch"
import { badgeStatus } from "../lib/prState"
import { badgeLook, cx } from "./ui"
import { ProjectAvatar, TaskStatusIcon, projectColorStyle } from "./TaskIcon"
import { DismissButton, modalDepth } from "./Modal"
import { TREE_STEP, TaskRow, TreeNode } from "./Sidebar"
import { useTiles } from "../lib/taskTiles"

/** Keyboard focus: the sidebar's white outline, never mistaken for the selected item. */
const FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zinc-100"
/** A task open, or on the way to the one opened: the sidebar's fill and yellow bar. */
const SELECTED = "bg-zinc-800 text-zinc-50 shadow-[inset_3px_0_0_var(--color-yard-400)]"
/** 44px to a finger and a mouse alike. */
const ITEM = cx("relative grid h-11 w-11 shrink-0 place-items-center rounded-lg", FOCUS)
/** Only beside the chat: a sheet (a phone, a narrow window) shows one panel at a time and no strips. w-14 is lib/layout.ts' STRIP_WIDTH. */
export const RAIL_COLUMN = "relative flex h-full min-h-0 w-14 flex-none flex-col items-center border-l border-zinc-800 bg-zinc-950 @max-[35.5rem]/coord:hidden"
/** The bar of a task filling the room: inside its column, whose left border it sits on, so its line is on the right. */
export const SUBTASK_BAR = RAIL_COLUMN.replace("border-l", "border-r")
/** The bar of a Captain's chat: between the sidebar's rail and the chat, outside the chat's section. */
export const CHAT_BAR = "relative flex h-full min-h-0 w-14 flex-none flex-col items-center border-r border-zinc-900 bg-zinc-950"

const statusLabel = (t: Task) => {
  const s = badgeStatus(t)
  return badgeLook(s).label
}

const NAME = "mt-1 mb-2 max-h-48 min-h-0 shrink truncate rounded-md px-1 py-2 text-xs text-zinc-500 [writing-mode:vertical-rl] rotate-180"

/**
 * A strip's frame: its open button, its tasks (`children`), and its name written down it. `level`: the ref of what it
 * stands for (lib/columns.ts). Without `onOpen` it's a bar: what it lists is there beside it (a task filling the
 * room, a Captain's chat), so nothing to open; `tools` stand where the button would, else a sub-tasks mark. With
 * `onOpen`, `tools` are buttons under the open button, above the tasks (a Captain's tree). `className`: a bar's place.
 */
function Rail({ level, name, label = name, onOpen, tools, className, children }: { level: string; name: string; label?: string; onOpen?: () => void; tools?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <nav aria-label={label} data-testid="rail" data-column={level} data-bar={onOpen ? undefined : true} className={className ?? (onOpen ? RAIL_COLUMN : SUBTASK_BAR)}>
      {/* Its button level with the sidebar rail's Show button, so the strips' tops read as one row. */}
      <div className="grid h-14 w-full shrink-0 place-items-center">
        {onOpen ? (
          <button type="button" data-testid="rail-open" onClick={onOpen} aria-label={`Open ${name}`} title={`Open ${name}`} className={cx(ITEM, "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100")}>
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          tools ?? (
            <span title={label} className="grid h-11 w-11 place-items-center text-zinc-500">
              <ListTree className="h-4 w-4" aria-hidden />
            </span>
          )
        )}
      </div>
      {onOpen && tools && (
        <>
          <div className="grid w-full shrink-0 place-items-center">{tools}</div>
          <div aria-hidden className="mt-2 h-px w-6 shrink-0 bg-zinc-800" />
        </>
      )}
      {children ? <ul className="scroll-thin flex min-h-0 w-full flex-initial flex-col items-center gap-1 overflow-y-auto py-2">{children}</ul> : <div className="flex-1" />}
      {/* The name, down the strip: a mouse or a finger can open the level from it too (the button above is the keyboard's). */}
      {onOpen ? (
        <button type="button" tabIndex={-1} aria-hidden onClick={onOpen} title={name} className={cx(NAME, "hover:bg-zinc-900 hover:text-zinc-300")}>
          {name}
        </button>
      ) : (
        <span aria-hidden title={label} className={NAME}>
          {name}
        </span>
      )}
    </nav>
  )
}

/** One task on a strip: its tile in its project's colour, saying its state. The button's label says it in words. */
const RailTask = memo(function RailTask({ task, selected, onPick }: { task: Task; selected: boolean; onPick: (id: string) => void }) {
  const label = statusLabel(task)
  const resting = task.status === "idle" || task.status === "done"
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(task.id)}
        data-task={task.id}
        aria-label={`${task.title}, ${label}`}
        aria-current={selected ? "page" : undefined}
        title={`${task.title} · ${label}`}
        className={cx(ITEM, selected ? SELECTED : "hover:bg-zinc-900")}
      >
        <TaskStatusIcon task={task} size="lg" muted={resting} />
      </button>
    </li>
  )
})

/** A task picked on a strip opens as a sidebar pick does: just it, beside the pins. */
const openTask = (id: string) => navigateApp(taskSessionHref(id))

/** The tasks open in panels, marked on the strips and in the tree. */
function useOpenTaskIds(): string[] {
  const panels = usePanels()
  return useMemo(() => panels.flatMap((ref) => {
    const view = viewOf(ref)
    return view.kind === "session" ? [view.id] : []
  }), [panels])
}

/**
 * A level above the item opened (`level`: a Captain's ref or a task's id), as a strip: a Captain's lists its tasks
 * (with a tree button for their nesting), a task's its sub-tasks. `below`: the level under it on the way to the item
 * opened, marked like the tasks open in panels.
 */
export const LevelStrip = memo(function LevelStrip({ level, below }: { level: string; below: string }) {
  const projects = useProjects().data
  const tasks = useTasks().data
  if (isChatRef(level)) {
    const id = chatProject(level)
    const project = projects?.find((p) => p.id === id)
    const name = project ? `${project.name} Captain` : "Captain"
    return (
      <Rail level={level} name={name} onOpen={() => openChat(id)} tools={<TreeButton captain={id} title={project ? `${project.name} tasks` : "Tasks"} />}>
        <ChatRailTasks captain={id} project={project} below={below} />
      </Rail>
    )
  }
  const name = tasks?.find((t) => t.id === level)?.title ?? "Task"
  return (
    <Rail level={level} name={name} label={`${name}: its sub-tasks`} onOpen={() => openTask(level)}>
      <SubtaskItems taskId={level} below={below} />
    </Rail>
  )
})

/** A chat's tasks, as its strip or bar lists them: the sidebar's, in its order, with the ones open (and `below`). */
function useChatRail(captain: string | null, project: Project | undefined, below: string | null) {
  const projects = useProjects().data
  const tasks = useTasks().data
  const pins = useBarPins()
  const closing = usePendingCloses()
  const openIds = useOpenTaskIds()
  const groups = useMemo(() => {
    const all = sidebarGroups(projects ?? [], tasks ?? [], pins, { current: captain, closing })
    // Its own tasks only: a sub-task open has its parent's strip.
    const open = (tasks ?? []).filter((t) => !t.parentTaskId && (openIds.includes(t.id) || t.id === below))
    return chatRailGroups(project ? [...all.shown, ...all.others] : all.shown, project ? project.id : null, open)
  }, [projects, tasks, pins, captain, closing, project, openIds, below])
  return { groups, openIds }
}

function ChatRailTasks({ captain, project, below }: { captain: string | null; project: Project | undefined; below: string }) {
  const { groups, openIds } = useChatRail(captain, project, below)
  return <ChatRailItems groups={groups} openIds={openIds} below={below} />
}

function ChatRailItems({ groups, openIds, below }: { groups: readonly RailGroup[]; openIds: readonly string[]; below: string | null }) {
  return groups.map((g, i) => [
    i > 0 && <li key={`gap:${g.projectId}`} aria-hidden className="my-1 h-px w-6 shrink-0 bg-zinc-800" />,
    ...g.tasks.map((t) => <RailTask key={t.id} task={t} selected={t.id === below || openIds.includes(t.id)} onPick={openTask} />),
  ])
}

/**
 * The bar of a Captain's chat showing, with the sidebar folded (App puts it between the sidebar's rail and the chat):
 * its tasks, as its strip lists them once a task hides the chat, and their tree. The tasks open beside a pinned chat
 * are marked. None while the chat is hidden (its strip is there then), nor for a Captain with no tasks listed.
 */
export const ChatBar = memo(function ChatBar({ projectId }: { projectId: string }) {
  const project = useProjects().data?.find((p) => p.id === projectId)
  const panels = usePanels()
  const hidden = useChatHidden() && panels.length > 0
  const { groups, openIds } = useChatRail(projectId, project, null)
  if (!project || hidden || groups.every((g) => !g.tasks.length)) return null
  const name = `${project.name} Captain`
  const tasks = `${project.name} tasks`
  return (
    <Rail level={chatRef(projectId)} name={name} label={tasks} className={CHAT_BAR} tools={<TreeButton captain={projectId} title={tasks} />}>
      <ChatRailItems groups={groups} openIds={openIds} below={null} />
    </Rail>
  )
})

function SubtaskItems({ taskId, below = null }: { taskId: string; below?: string | null }) {
  const tasks = useTasks().data
  const openIds = useOpenTaskIds()
  const list = useMemo(() => taskRailTasks(tasks ?? [], taskId), [tasks, taskId])
  return list.map((t) => <RailTask key={t.id} task={t} selected={t.id === below || openIds.includes(t.id)} onPick={openTask} />)
}

/** The bar of a task filling the room, with the sidebar folded: its sub-tasks, when it has any. */
export const SubtaskBar = memo(function SubtaskBar({ taskId }: { taskId: string }) {
  const tasks = useTasks().data
  const task = tasks?.find((t) => t.id === taskId)
  const any = Boolean(tasks?.some((t) => t.parentTaskId === taskId))
  if (!any) return null
  const name = task?.title ?? "Task"
  return (
    <Rail level={taskId} name={name} label={`Sub-tasks of ${name}`}>
      <SubtaskItems taskId={taskId} />
    </Rail>
  )
})

/**
 * The chat strip's tree button: it opens the tree beside the strip, and closes it again. A click or a tap, never a
 * hover. Opened from the keyboard, the tree takes the focus, and Esc or its × gives it back here.
 */
function TreeButton({ captain, title }: { captain: string | null; title: string }) {
  const [open, setOpen] = useState(false)
  const byKey = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus({ preventScroll: true })
  }, [])
  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="rail-tree-button"
        onClick={(e) => {
          byKey.current = e.detail === 0
          setOpen((on) => !on)
        }}
        aria-label="Task tree"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        title={open ? "Close the task tree" : "Task tree: every task with its sub-tasks"}
        className={cx(ITEM, open ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100")}
      >
        <ListTree className="h-4 w-4" aria-hidden />
      </button>
      {open && <RailTree id={id} captain={captain} title={title} anchor={button} takeFocus={byKey.current} onClose={close} />}
    </>
  )
}

/** A project's name over its tasks in the Coordinator's tree, as the sidebar's rail draws its swatch. */
function TreeHead({ project }: { project: Project }) {
  const color = useTiles().colors.get(project.id)
  return (
    <h3 className="flex min-h-9 items-center gap-2 px-2 pt-2 text-xs font-medium text-zinc-400">
      <ProjectAvatar src={project.iconUrl} className="h-4 w-4 rounded">
        <span aria-hidden style={projectColorStyle(color)} className="h-2 w-2 shrink-0 rounded-[3px] bg-(--pc)" />
      </ProjectAvatar>
      <span className="truncate">{project.name}</span>
    </h3>
  )
}

/**
 * The chat strip's tree: its Captain's tasks (every project's, for the Coordinator), each with its sub-tasks nested
 * under it to any depth, drawn by the sidebar's own rows (chevrons, indents, status, counts, Mark done). It stands
 * beside the strip, over the panels, as tall as the strip. The newest task open is marked, or the folded task it's
 * under. A pick opens the task as a sidebar pick does (its box takes the focus) and closes the tree; so do Esc, a
 * press elsewhere, the focus leaving it, and its ×. Its folds are the sidebar's (lib/sidebar.ts treeFolds, in
 * memory only), and only the chevron folds here: a double click would land its second click on the panel the pick
 * uncovered.
 */
function RailTree({ id, captain, title, anchor, takeFocus, onClose }: {
  id: string
  captain: string | null
  title: string
  anchor: RefObject<HTMLButtonElement | null>
  takeFocus: boolean
  onClose: (refocus: boolean) => void
}) {
  const projects = useProjects().data
  const tasks = useTasks().data
  const pins = useBarPins()
  const closing = usePendingCloses()
  const folds = useTreeFolds()
  const openIds = useOpenTaskIds()
  const newest = openIds.at(-1) ?? null
  const groups = useMemo(() => {
    const project = captain ? projects?.find((p) => p.id === captain) : undefined
    const all = sidebarGroups(projects ?? [], tasks ?? [], pins, { current: captain, closing })
    const open = (tasks ?? []).filter((t) => openIds.includes(t.id))
    return railTreeGroups(project ? [...all.shown, ...all.others] : all.shown, project ? project.id : null, open)
  }, [projects, tasks, pins, captain, closing, openIds])
  const selection = useMemo<Selection>(() => {
    if (!newest) return { selected: null, behind: null, inside: null }
    const under = treeHidden(groups, folds).get(newest)
    return under ? { selected: null, behind: null, inside: taskKey(under, "project") } : { selected: taskKey(newest, "project"), behind: null, inside: null }
  }, [groups, folds, newest])
  // As a pick in the sidebar: the picked task's box takes the focus (lib/chatSwitch.ts).
  const pick = useCallback((taskId: string, _spot: unknown, e?: MouseEvent<HTMLElement>) => {
    setPickedRow(taskId, "project")
    openTask(taskId)
    onClose(false)
    if (pickFocusesComposer(e?.nativeEvent)) focusComposer(taskId)
  }, [onClose])

  // Beside the strip, as tall as it is; a window too narrow for strips (a sheet) has none to stand beside.
  const [box, setBox] = useState<{ left: number; top: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const rail = anchor.current?.closest("nav")?.getBoundingClientRect()
      if (!rail?.width) return onClose(false)
      setBox({ left: rail.right, top: rail.top, height: rail.height })
    }
    place()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [anchor, onClose])

  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Esc closes only the topmost layer: not this while a dialog opened after it sits on top.
    const depth = modalDepth()
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || panel.current?.contains(t) || anchor.current?.contains(t)) return
      onClose(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || modalDepth() > depth) return
      e.preventDefault()
      onClose(Boolean(panel.current?.contains(document.activeElement)) || document.activeElement === anchor.current)
    }
    document.addEventListener("pointerdown", away, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", away, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [anchor, onClose])
  // The newest task open in view; from the keyboard, its row takes the focus (else the first row).
  const shown = box !== null
  useEffect(() => {
    const root = panel.current
    if (!shown || !root) return
    const marked = root.querySelector<HTMLElement>("[data-open-task][aria-current=page]")
    marked?.scrollIntoView?.({ block: "nearest" })
    if (takeFocus) (marked ?? root.querySelector<HTMLElement>("[data-open-task]") ?? root).focus({ preventScroll: true })
    // Only as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])
  const blur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null
    if (to && !e.currentTarget.contains(to) && to !== anchor.current) onClose(false)
  }

  if (!box) return null
  const empty = groups.every((g) => !g.rows.length)
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-label={title}
      data-testid="rail-tree"
      tabIndex={-1}
      onBlur={blur}
      style={{ left: box.left, top: box.top, height: box.height, width: `min(20rem, calc(100vw - ${box.left}px - 0.5rem))` }}
      className="@container/side fixed z-40 flex flex-col border-r border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60 focus:outline-none"
    >
      {/* As high as the strip's top row, so the tree's head and the strip's buttons read as one row. */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-900 pr-1.5 pl-3.5">
        <ListTree className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{title}</h2>
        <DismissButton kind="close" label="Close the task tree" onClick={() => onClose(true)} />
      </div>
      <div className={cx("scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3", TREE_STEP)}>
        {groups.map((g) => (
          <section key={g.project.id} aria-label={g.project.name} className="space-y-px pt-2">
            {captain === null && <TreeHead project={g.project} />}
            {g.rows.map((r) =>
              r.kids ? (
                <TreeNode key={r.task.id} row={r} depth={0} folds={folds} selection={selection} onPick={pick} twice={false} />
              ) : (
                <TaskRow key={r.task.id} row={r} spot="project" selected={selection.selected === taskKey(r.task.id, "project")} onPick={pick} />
              ),
            )}
          </section>
        ))}
        {empty && <p className="px-2 pt-4 text-xs text-zinc-500">No open tasks.</p>}
      </div>
    </div>,
    document.body,
  )
}
