import { tryApi } from '../api'
import { getState, openSession, setState, toast, upsert } from '../store'
import { normPath } from './format'
import type { Session } from '../types'

export interface Where { workspaceId?: string | null; cwd?: string | null }

/** Keep the session we just got from the API (the WS echo may arrive later) and open its tab in its worktree. */
export function adoptSession(s: Session) {
  setState((st) => ({ sessions: upsert(st.sessions, s) }))
  openSession(s.id)
}

/** «Новый чат» without a form: default agent, given folder (or a repo-less chat when none). */
export async function newChat(where: Where = {}) {
  const st = getState()
  const enabled = st.agents.filter((a) => a.enabled)
  const agent = enabled.find((a) => a.id === st.defaultAgent)?.id ?? enabled[0]?.id
  if (!agent) {
    toast('Нет включённых агентов — проверьте настройки', 'error')
    return
  }
  const s = await tryApi<Session>('POST', '/sessions', {
    kind: 'chat', agent, cwd: where.cwd ?? undefined, workspaceId: where.workspaceId ?? undefined,
  })
  if (s) adoptSession(s)
}

/** «Новый терминал» without a form: the default shell in the given folder. */
export async function newTerminal(where: Where) {
  const s = await tryApi<Session>('POST', '/sessions', {
    kind: 'terminal', agent: 'shell', cwd: where.cwd ?? undefined, workspaceId: where.workspaceId ?? undefined,
  })
  if (s) adoptSession(s)
}

/** Project a folder belongs to: a known worktree of it, a session there, or the path prefix. */
export function workspaceFor(cwd: string): string | null {
  const st = getState()
  const p = normPath(cwd)
  for (const [id, list] of Object.entries(st.worktrees)) if (list.some((w) => normPath(w.path) === p)) return id
  const s = st.sessions.find((x) => x.workspaceId && normPath(x.cwd) === p)
  if (s) return s.workspaceId
  return st.workspaces.find((w) => p === normPath(w.path) || p.startsWith(`${normPath(w.path)}/`))?.id ?? null
}

/** Folder for «new chat here»: the worktree on screen. */
export function currentWhere(): { workspaceId: string | null; cwd: string | null } {
  const st = getState()
  const cwd = st.view.kind === 'wt' ? st.view.cwd : null
  return cwd ? { workspaceId: workspaceFor(cwd), cwd } : { workspaceId: null, cwd: null }
}
