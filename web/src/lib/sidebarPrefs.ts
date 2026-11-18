/** «Параметры рабочих пространств» (the sidebar's sliders popover): defaults, filters, grouping, ordering — pure. */

export type GroupBy = 'none' | 'status' | 'pr' | 'project'
export type SortBy = 'activity' | 'name' | 'new' | 'changes'
export type ProjectOrder = 'manual' | 'alpha' | 'activity'

export interface SbPrefs {
  hiddenProjects: string[] // «Показать → Проекты»: unchecked ones
  folders: boolean // «Все проекты» and plain folders
  group: GroupBy
  sort: SortBy // worktrees inside a project / group
  order: ProjectOrder
  projectOrder: string[] // the dragged order (manual), project ids
  cards: 'compact' | 'detailed'
  showAction: boolean
  showModel: boolean
  showTime: boolean
  hideSleeping: boolean
  hideMain: boolean
  hideAgentMade: boolean
  hideExternal: boolean
  hideDetached: boolean
  hideEmpty: boolean // without sessions and changes
  showCli: boolean // chats adopted from the CLI history
}

export const DEFAULT_PREFS: SbPrefs = {
  hiddenProjects: [], folders: true, group: 'project', sort: 'activity', order: 'manual', projectOrder: [],
  cards: 'compact', showAction: true, showModel: true, showTime: true,
  hideSleeping: false, hideMain: false, hideAgentMade: false, hideExternal: false, hideDetached: false, hideEmpty: false,
  showCli: true,
}

/** Something is hidden by the choice: the dot on the sliders button. */
export const hidesSomething = (p: SbPrefs) =>
  p.hiddenProjects.length > 0 || !p.folders || !p.showCli || p.hideSleeping || p.hideMain || p.hideAgentMade || p.hideExternal || p.hideDetached || p.hideEmpty

/** Every setting at its default (the manual order is the user's arrangement, not a setting). */
export const isDefault = (p: SbPrefs) =>
  (Object.keys(DEFAULT_PREFS) as (keyof SbPrefs)[]).every((k) => k === 'projectOrder' || JSON.stringify(p[k]) === JSON.stringify(DEFAULT_PREFS[k]))

export interface WtFacts { main: boolean; detached: boolean; sleeping: boolean; createdBy?: string | null; empty: boolean }

/** A worktree the filters hide; the caller keeps the ones needing attention and the one on screen. */
export function filteredOut(p: SbPrefs, w: WtFacts): boolean {
  return (p.hideSleeping && w.sleeping) || (p.hideMain && w.main) || (p.hideAgentMade && w.createdBy === 'agent') ||
    (p.hideExternal && !w.main && (!w.createdBy || w.createdBy === 'external')) || // older ones count as made outside
    (p.hideDetached && w.detached) || (p.hideEmpty && w.empty)
}

export type StatusGroup = 'attention' | 'busy' | 'idle' | 'done' | 'error'
export const STATUS_GROUPS: [StatusGroup, string][] = [
  ['attention', 'Требуют внимания'], ['busy', 'Работают'], ['idle', 'Свободны'], ['done', 'Готово'], ['error', 'Ошибки'],
]
const WAITING = new Set(['waiting_answer', 'waiting_permission', 'stalled', 'auth'])

/** A worktree's group by the visual states of its chats; `failed` = its own last operation failed. */
export function statusGroup(states: string[], failed: boolean, taskDone: boolean): StatusGroup {
  if (states.some((v) => WAITING.has(v))) return 'attention'
  if (failed || states.includes('error')) return 'error'
  if (states.some((v) => v === 'running' || v === 'starting')) return 'busy'
  if (taskDone || (states.length > 0 && states.every((v) => v === 'done'))) return 'done'
  return 'idle'
}

export type PrGroup = 'none' | 'open' | 'review' | 'merged'
export const PR_GROUPS: [PrGroup, string][] = [['none', 'Без PR'], ['open', 'Открыт'], ['review', 'На ревью'], ['merged', 'Слит']]

export function prGroup(pr: { state: string; reviewers?: unknown[] } | null | undefined, taskStatus?: string | null): PrGroup {
  if (!pr || pr.state === 'declined') return 'none'
  if (pr.state === 'merged') return 'merged'
  return (pr.reviewers?.length ?? 0) > 0 || taskStatus === 'review' ? 'review' : 'open'
}

export interface RowFacts { rank: number; last: number; name: string; created: number; changes: number }
const byName = (a: RowFacts, b: RowFacts) => a.name.localeCompare(b.name, 'ru', { numeric: true })

/** Worktree order: «Активность агентов» = needs you, working, then the latest; the others say what they sort by. */
export function compareRows(sort: SortBy): (a: RowFacts, b: RowFacts) => number {
  switch (sort) {
    case 'name': return byName
    case 'new': return (a, b) => b.created - a.created || byName(a, b)
    case 'changes': return (a, b) => b.changes - a.changes || a.rank - b.rank || b.last - a.last || byName(a, b)
    default: return (a, b) => a.rank - b.rank || b.last - a.last || byName(a, b)
  }
}

/** Projects in the chosen order; manual = the dragged order, projects it does not know yet after, as the server lists them. */
export function orderProjects<T extends { id: string; name: string }>(list: T[], p: SbPrefs, lastOf: (x: T) => number): T[] {
  if (p.order === 'alpha') return [...list].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
  if (p.order === 'activity') return [...list].sort((a, b) => lastOf(b) - lastOf(a))
  const at = (x: T) => { const i = p.projectOrder.indexOf(x.id); return i < 0 ? p.projectOrder.length + list.indexOf(x) : i }
  return [...list].sort((a, b) => at(a) - at(b))
}

/** `id` moved onto `target`'s place: after it when moving down, before it when moving up. */
export function moveTo(ids: string[], id: string, target: string): string[] {
  const from = ids.indexOf(id)
  const to = ids.indexOf(target)
  if (from < 0 || to < 0 || from === to) return ids
  const out = ids.filter((x) => x !== id)
  out.splice(to, 0, id)
  return out
}
