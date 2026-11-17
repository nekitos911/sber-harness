import { tryApi } from '../api'
import { getState, openSession, setState, tabKey, toast, upsert } from '../store'
import { normPath } from './format'
import type { Session } from '../types'

/** Keep the session we just got from the API (the WS echo may arrive later) and open its tab. */
export function adoptSession(s: Session) {
  setState((st) => ({ sessions: upsert(st.sessions, s) }))
  openSession(s.id)
}

/** «Новый чат» without a form: default agent, given folder (or a repo-less chat when none). */
export async function newChat(where: { workspaceId?: string | null; cwd?: string | null } = {}) {
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

/** Folder for "new chat here": the active tab's folder, else the sidebar pick. */
export function currentWhere(): { workspaceId: string | null; cwd: string | null } {
  const st = getState()
  const tab = st.tabs.find((t) => tabKey(t) === st.active)
  const session = tab?.kind === 'session' ? st.sessions.find((s) => s.id === tab.id) : undefined
  const cwd = session?.cwd ?? (tab?.kind === 'file' || tab?.kind === 'diff' ? tab.cwd : null) ?? st.cwd
  if (!cwd) return { workspaceId: null, cwd: null }
  const ws = session?.workspaceId
    ? st.workspaces.find((w) => w.id === session.workspaceId)
    : st.workspaces.find((w) => normPath(cwd).startsWith(normPath(w.path)))
  return { workspaceId: ws?.id ?? null, cwd }
}
