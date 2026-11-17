import { Archive, ArchiveRestore, Pencil, Square, Trash2 } from 'lucide-react'
import { api, ApiError, errorText, tryApi } from '../api'
import { closeSessionTab, getState, openDialog, setState, toast, upsertSession, without } from '../store'
import type { MenuItem } from '../components/ui'
import type { Session } from '../types'

/** Still working: a turn running, or the CLI shutting down after its answer. */
export const isLive = (s: Session) => s.status === 'running' || !!s.turnClosing

/**
 * Archive (or bring back): hidden from the sidebar, transcript kept. Optimistic; says so if the server cannot.
 * A working session asks first («Остановить и убрать в архив»), then goes with stop: true.
 */
export async function archiveSession(s: Session, archived = true, { stop = false } = {}): Promise<boolean> {
  const before = getState().sessions.find((x) => x.id === s.id) ?? s
  if (archived && !stop && isLive(before)) { openDialog({ kind: 'session-archive', id: s.id }); return false }
  setState((st) => ({ sessions: st.sessions.map((x) => (x.id === s.id ? { ...x, archived } : x)) }))
  if (archived) closeSessionTab(s.id)
  try {
    const saved = await api<Session>('PATCH', `/sessions/${encodeURIComponent(s.id)}`, archived && stop ? { archived, stop: true } : { archived })
    if (!!saved?.archived !== archived) throw new Error('этот сервер ещё не умеет архивировать сессии')
    setState((st) => ({ sessions: upsertSession(st.sessions, saved) }))
    if (archived) toast(`«${s.title || s.id}» в архиве — вернуть можно на экране «Агенты»`, 'ok')
    return true
  } catch (e) {
    setState((st) => ({ sessions: st.sessions.map((x) => (x.id === s.id ? before : x)) }))
    // it started working meanwhile: ask, like for a session known to be busy
    if (archived && !stop && e instanceof ApiError && e.status === 409) { openDialog({ kind: 'session-archive', id: s.id }); return false }
    toast(`Не удалось ${archived ? 'убрать в архив' : 'вернуть из архива'}: ${errorText(e)}`, 'error')
    return false
  }
}

export const stopSession = (s: Session) => void tryApi('POST', `/sessions/${encodeURIComponent(s.id)}/stop`)

/** Delete with its history. Called from the confirm dialog, so a working one is stopped by the server (?force=1). */
export async function deleteSession(s: Session) {
  if ((await tryApi<unknown>('DELETE', `/sessions/${encodeURIComponent(s.id)}?force=1`)) === undefined) return false
  closeSessionTab(s.id)
  setState((st) => ({ sessions: without(st.sessions, s.id) }))
  return true
}

/** The one menu of a session (sidebar row, agents card): rename, stop, archive, delete. */
export function sessionMenu(s: Session, rename?: () => void): MenuItem[] {
  return [
    ...(rename ? [{ label: 'Переименовать', icon: <Pencil />, onSelect: rename }] : []),
    ...(s.status === 'running' ? [{ label: 'Остановить', icon: <Square />, onSelect: () => stopSession(s) }] : []),
    s.archived
      ? { label: 'Вернуть из архива', icon: <ArchiveRestore />, onSelect: () => void archiveSession(s, false) }
      : { label: 'В архив', icon: <Archive />, onSelect: () => void archiveSession(s) },
    { label: 'Удалить…', icon: <Trash2 />, danger: true, divider: true, onSelect: () => openDialog({ kind: 'session-delete', id: s.id }) },
  ]
}

/** Rename via PATCH; the WS echo (or the answer) updates the store. */
export async function renameSession(s: Session, title: string) {
  const t = title.trim()
  if (!t || t === s.title) return
  const saved = await tryApi<Session>('PATCH', `/sessions/${encodeURIComponent(s.id)}`, { title: t })
  if (saved) setState((st) => ({ sessions: upsertSession(st.sessions, saved) }))
}
