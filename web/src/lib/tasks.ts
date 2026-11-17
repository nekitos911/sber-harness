import type { Task } from '../types'

/** Tracker key of the root task (subtasks share it), else the root's local id. */
export function taskKey(task: Task, byId: Map<string, Task>): string {
  let root = task
  for (let i = 0; i < 20 && root.parentId && byId.has(root.parentId); i++) root = byId.get(root.parentId)!
  return root.externalId ?? root.id
}

/** Ids of deps that are not done yet (a dep that no longer exists does not block). */
export const pendingDeps = (task: Task, byId: Map<string, Task>) =>
  task.deps.filter((d) => byId.has(d) && byId.get(d)!.status !== 'done')

const DEFAULT_TARGETS = new Set(['develop', 'main', 'master'])

/** Targets are worth showing on a card only when they are not the plain default branch. */
export const unusualTargets = (task: Task) =>
  task.targets.length > 1 || (task.targets[0] !== undefined && !DEFAULT_TARGETS.has(task.targets[0]))

export const byOrder = (a: Task, b: Task) => a.order - b.order || a.createdAt - b.createdAt


const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')
const COLUMN_NAMES: Record<string, string[]> = {
  backlog: ['backlog', 'бэклог'],
  todo: ['todo', 'кработе'],
  in_progress: ['inprogress', 'вработе'],
  review: ['review', 'inreview', 'ревью', 'наревью'],
  done: ['done', 'готово', 'closed', 'закрыто'],
}

/** Tracker status worth showing on the card: it exists and does not read like the card's column. */
export const trackerDiffers = (t: Task) =>
  !!t.externalStatus && !(COLUMN_NAMES[t.status] ?? []).includes(norm(t.externalStatus))

export const isImported = (t: Task) => !!(t.source || t.externalId)
