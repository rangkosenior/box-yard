// The open task's state in words when it changes, for screen readers. Its notifications (and their toasts) are
// skipped while it's open (lib/notifications.ts), and the header's dot changes silently, so without this a turn that
// ends, asks something or fails says nothing to someone who can't see the dot.
import { useState } from "react"
import { badgeStatus, type BadgeStatus } from "../lib/prState"
import { badgeLook } from "./ui"
import type { Task } from "../../../shared/types"

/** What it says when the open task moves to `status`; nothing for Starting, which Working follows at once. */
export function taskStatusAnnouncement(title: string, status: BadgeStatus): string {
  if (status === "starting") return ""
  return `${title}: ${badgeLook(status).label}`
}

/** A polite live region, in the page from the start (one added with its text is often not read), silent until the state changes. */
export function TaskStatusAnnouncer({ task }: { task: Pick<Task, "title" | "status" | "prUrl" | "prState"> }) {
  const status = badgeStatus(task)
  // The state it last saw, and what it said then: updated during render when the state moves, as React suggests.
  const [seen, setSeen] = useState({ status, said: "" })
  if (seen.status !== status) setSeen({ status, said: taskStatusAnnouncement(task.title, status) || seen.said })
  return (
    <p aria-live="polite" className="sr-only" data-testid="task-status-announcer">
      {seen.said}
    </p>
  )
}
