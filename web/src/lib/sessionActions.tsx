import { Archive, ArchiveRestore, Pencil, Pin, PinOff, Square, Trash2 } from 'lucide-react'
import { api, ApiError, errorText, tryApi } from '../api'
import { closeSessionTab, getState, hasFeature, openDialog, setState, toast, upsertSession, without } from '../store'
import type { MenuItem } from '../components/ui'
import type { Session } from '../types'
import { cliLive } from './sessionState'

/** Why delete / archive are off while GigaCode writes this chat in a terminal (the menus' tooltip, the toast). */
export const CLI_LIVE_TIP = 'Этот чат сейчас ведёт GigaCode в терминале — удалить или убрать в архив можно, когда он закончит'

/** «Переподключить MCP»: a new agent process (its MCP servers start again) on the same CLI session — context kept. */
export async function reconnectMcp(s: Pick<Session, 'id'>) {
  if ((await tryApi<unknown>('POST', `/sessions/${encodeURIComponent(s.id)}/restart`, { keepContext: true })) !== undefined)
    toast('Агент перезапускается: MCP-серверы подключатся заново, контекст чата сохранится', 'ok')
}

/** «Новая сессия CLI» (was «Сбросить статус»): a fresh CLI session; the transcript stays, the agent's memory of it does not. */
export const newCliSession = (s: Pick<Session, 'id'>) => void tryApi('POST', `/sessions/${encodeURIComponent(s.id)}/restart`)
export const NEW_CLI_SESSION_TIP = 'Новый процесс и новая сессия CLI: история в чате останется, но агент забудет весь разговор. Чтобы только перезапустить MCP-серверы, есть «Переподключить MCP»'

/** Still working: a turn running, or the CLI shutting down after its answer. */
export const isLive = (s: Session) => s.status === 'running' || !!s.turnClosing

/** A person's own chat whose turn ended after they last looked at it: «Ждут вас» · ответил, until opened. */
export const unseenReply = (s: Session) => s.kind === 'chat' && !s.parentId && !s.virtual && !s.archived && !isLive(s) && !s.waitingFor
  && (s.status === 'idle' || s.status === 'done') && (s.finishedAt ?? 0) > (s.dismissedAt ?? 0)

/** A sub-agent's «задача выполнена» not opened since it finished: a bright check in the sidebar, dimmed once seen. */
export const unseenDone = (s: Session) => s.status === 'done' && (s.finishedAt ?? 0) > (s.dismissedAt ?? 0)

/** Seen: out of «Ждут вас» (its answer, error or cut turn); the chat itself stays. */
export async function dismissSession(s: Session) {
  const r = await tryApi<Session>('PATCH', `/sessions/${encodeURIComponent(s.id)}`, { dismissed: true })
  if (r) setState((st) => ({ sessions: upsertSession(st.sessions, r) }))
}

/**
 * Archive (or bring back): hidden from the sidebar, transcript kept. Optimistic; says so if the server cannot.
 * A working session asks first («Остановить и убрать в архив»), then goes with stop: true.
 */
export async function archiveSession(s: Session, archived = true, { stop = false } = {}): Promise<boolean> {
  const before = getState().sessions.find((x) => x.id === s.id) ?? s
  if (archived && cliLive(before, Date.now())) { toast(CLI_LIVE_TIP, 'info'); return false }
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

/** «В архив» for several chats at once (the agents screen): one toast for all; the server refuses a working one. */
export async function archiveMany(list: Session[]) {
  let done = 0
  for (const s of list) {
    if (cliLive(s, Date.now()) || isLive(s)) continue
    try {
      const saved = await api<Session>('PATCH', `/sessions/${encodeURIComponent(s.id)}`, { archived: true })
      if (!saved?.archived) continue
      closeSessionTab(s.id)
      setState((st) => ({ sessions: upsertSession(st.sessions, saved) }))
      done++
    } catch { /* counted as skipped below */ }
  }
  const skipped = list.length - done
  toast(done ? `В архиве: ${done}${skipped ? ` · пропущено ${skipped} (работают или заняты)` : ''} — вернуть можно в «Архив»` : 'Ничего не убрано: эти чаты работают или заняты', done ? 'ok' : 'info')
}

export const stopSession = (s: Session) => void tryApi('POST', `/sessions/${encodeURIComponent(s.id)}/stop`)

/** Delete with its history. Called from the confirm dialog, so a working one is stopped by the server (?force=1). */
export async function deleteSession(s: Session) {
  if (cliLive(getState().sessions.find((x) => x.id === s.id) ?? s, Date.now())) { toast(CLI_LIVE_TIP, 'info'); return false }
  if ((await tryApi<unknown>('DELETE', `/sessions/${encodeURIComponent(s.id)}?force=1`)) === undefined) return false
  closeSessionTab(s.id)
  setState((st) => ({ sessions: without(st.sessions, s.id) }))
  return true
}

/** The one menu of a session (sidebar row, agents card): rename, stop, archive, delete. */
export function sessionMenu(s: Session, rename?: () => void): MenuItem[] {
  const lock = cliLive(s, Date.now()) ? { disabled: true, tip: CLI_LIVE_TIP } : {} // built when the menu opens: fresh enough
  return [
    ...(rename ? [{ label: 'Переименовать', icon: <Pencil />, onSelect: rename }] : []),
    ...(s.status === 'running' ? [{ label: 'Остановить', icon: <Square />, onSelect: () => stopSession(s) }] : []),
    ...(hasFeature('pin') && !s.archived && !s.virtual
      ? [s.pinnedAt ? { label: 'Открепить', icon: <PinOff />, onSelect: () => void pinSession(s, false) } : { label: 'Закрепить вверху', icon: <Pin />, onSelect: () => void pinSession(s, true) }]
      : []),
    s.archived
      ? { label: 'Вернуть из архива', icon: <ArchiveRestore />, onSelect: () => void archiveSession(s, false) }
      : { label: 'В архив', icon: <Archive />, onSelect: () => void archiveSession(s), ...lock },
    { label: 'Удалить…', icon: <Trash2 />, danger: true, divider: true, onSelect: () => openDialog({ kind: 'session-delete', id: s.id }), ...lock },
  ]
}

/** «Закрепить вверху» / «Открепить»: the sidebar's «Закреплённые». */
export async function pinSession(s: Session, pinned: boolean) {
  const saved = await tryApi<Session>('PATCH', `/sessions/${encodeURIComponent(s.id)}`, { pinned })
  if (saved) setState((st) => ({ sessions: upsertSession(st.sessions, saved) }))
}

/** Rename via PATCH; the WS echo (or the answer) updates the store. */
export async function renameSession(s: Session, title: string) {
  const t = title.trim()
  if (!t || t === s.title) return
  const saved = await tryApi<Session>('PATCH', `/sessions/${encodeURIComponent(s.id)}`, { title: t })
  if (saved) setState((st) => ({ sessions: upsertSession(st.sessions, saved) }))
}
