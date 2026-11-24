// The «Агенты» control panel: one row per top-level chat with its helpers folded in, filters, search, groups. Pure:
// the session state and the tree come in as functions (node --test runs it as is, like agentChip.ts).
import type { Session } from '../types'
import type { VisualState } from './sessionState'

/** What a row asks of the person: answer it (you), look at a failure (fail), wait (run), nothing (done). */
export type Cat = 'you' | 'fail' | 'run' | 'done'
export type Filter = 'all' | Cat | 'archive'
export type GroupBy = 'project' | 'status' | 'none'

const CAT: Record<VisualState, Cat> = {
  waiting_answer: 'you', waiting_permission: 'you', auth: 'you', interrupted: 'you',
  error: 'fail', exited: 'fail',
  running: 'run', starting: 'run', stalled: 'run',
  idle: 'done', done: 'done', stopped: 'done', terminal: 'done',
}
export const catOf = (v: VisualState): Cat => CAT[v]
export const RANK: Record<Cat, number> = { you: 0, fail: 1, run: 2, done: 3 }
export const CAT_LABEL: Record<Cat, string> = { you: 'Ждут вас', fail: 'Ошибки', run: 'Работают', done: 'Готовые' }

export interface Row {
  s: Session
  kids: Session[] // every helper started from it (theirs too), archived ones included
  cat: Cat // its own, or «you» when one of its live helpers waits for the person
  who: Session // the chat that sets `cat`: itself or that helper
  finished: number // helpers whose work is over
}

type State = (s: Session) => VisualState

/**
 * One row per top-level chat: a chat whose parent is not listed here. Active: listed chats, minus CLI history nobody
 * continued here (unless it works or waits right now); archive: archived chats.
 */
export function agentRows(sessions: Session[], state: State, kidsOf: (id: string) => Session[], archive: boolean): Row[] {
  const history = (s: Session) => s.origin === 'cli' && !s.cliImportedAt && (catOf(state(s)) === 'done' || catOf(state(s)) === 'fail')
  const listed = sessions.filter((s) => s.kind === 'chat' && !s.virtual && !s.system && !!s.archived === archive && (archive || !history(s)))
  const ids = new Set(listed.map((s) => s.id))
  return listed.filter((s) => !s.parentId || !ids.has(s.parentId)).map((s) => {
    const kids = kidsOf(s.id)
    const own = catOf(state(s))
    const asking = own === 'you' ? undefined : kids.find((k) => !k.archived && catOf(state(k)) === 'you')
    return { s, kids, cat: asking ? 'you' : own, who: asking ?? s, finished: kids.filter((k) => catOf(state(k)) === 'done').length }
  })
}

/** Search over the row and its helpers: every word must be found in their fields (title, project, branch, task, model…). */
export function rowMatches(r: Row, query: string, fields: (s: Session) => (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [r.s, ...r.kids].flatMap(fields).filter(Boolean).join('\n').toLowerCase()
  return words.every((w) => hay.includes(w))
}

export const inFilter = (r: Row, f: Filter) => f === 'all' || f === 'archive' || r.cat === f

/** Needs the person first, then failures, then working; inside a level the latest activity first. */
export const byUrgency = (a: Row, b: Row) => RANK[a.cat] - RANK[b.cat] || b.s.lastActivityAt - a.s.lastActivityAt

export interface Group { key: string; label: string; rows: Row[] }

/** Rows in groups (by project or state; «none»: one group without a label), each sorted by urgency; urgent groups first. */
export function groupRows(rows: Row[], by: GroupBy, project: (s: Session) => string): Group[] {
  const sorted = [...rows].sort(byUrgency)
  if (by === 'none') return sorted.length ? [{ key: 'all', label: '', rows: sorted }] : []
  const map = new Map<string, Group>()
  for (const r of sorted) {
    const key = by === 'status' ? r.cat : project(r.s)
    const g = map.get(key) ?? { key, label: by === 'status' ? CAT_LABEL[r.cat] : key, rows: [] }
    g.rows.push(r)
    map.set(key, g)
  }
  const top = (g: Group) => RANK[g.rows[0].cat]
  return [...map.values()].sort((a, b) => top(a) - top(b) || a.label.localeCompare(b.label, 'ru'))
}

/** Rows per state: the header summary. */
export function countCats(rows: Row[]): Record<Cat, number> {
  const n: Record<Cat, number> = { you: 0, fail: 0, run: 0, done: 0 }
  for (const r of rows) n[r.cat]++
  return n
}

/** Safe to archive in bulk: its work is over, nothing waits (queue, question) and none of its helpers still works. */
export const archivable = (r: Row, state: State) => !r.s.archived && r.cat === 'done' && !r.s.turnClosing && !r.s.queued && !r.s.waitingFor &&
  !r.kids.some((k) => !k.archived && catOf(state(k)) === 'run')
