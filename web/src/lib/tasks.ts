import { tryApi } from '../api'
import { openSession, setState, upsert } from '../store'
import type { Session, Task } from '../types'

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

/** «Взять в работу»: server picks default agent + new worktree, we open the new chat. */
export async function startTask(task: Task) {
  const s = await tryApi<Session>('POST', `/tasks/${encodeURIComponent(task.id)}/start`, {})
  if (s) {
    setState((st) => ({ sessions: upsert(st.sessions, s) }))
    openSession(s.id)
  }
}
