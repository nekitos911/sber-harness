import { tryApi } from '../api'
import { getState, openSession, setState, toast, upsert, upsertSession } from '../store'
import { normPath } from './format'
import type { Session, Workspace } from '../types'

export interface Where { workspaceId?: string | null; cwd?: string | null }

/** Keep the session we just got from the API (the WS echo may arrive later) and open its tab in its worktree. */
export function adoptSession(s: Session) {
  setState((st) => ({ sessions: upsertSession(st.sessions, s) }))
  openSession(s.id)
}

/**
 * One creation at a time: repeated clicks while a chat/terminal is being created reuse the request in flight instead of
 * creating more sessions; a creation that takes longer than a moment shows a toast so the click never looks ignored.
 */
let creating: Promise<void> | null = null
function once(label: string, fn: () => Promise<void>): Promise<void> {
  if (creating) return creating
  const slow = setTimeout(() => toast(`${label}…`, 'info'), 700)
  creating = fn().finally(() => { clearTimeout(slow); creating = null })
  return creating
}

/** «Новый чат» without a form: default agent, given folder (or a repo-less chat when none). */
export function newChat(where: Where = {}, prompt?: string) {
  return once('Создаю чат', () => createChat(where, prompt))
}

async function createChat(where: Where, prompt?: string) {
  const st = getState()
  const enabled = st.agents.filter((a) => a.enabled)
  const agent = enabled.find((a) => a.id === st.defaultAgent)?.id ?? enabled[0]?.id
  if (!agent) {
    toast('Нет включённых агентов — проверьте настройки', 'error')
    return
  }
  const s = await tryApi<Session>('POST', '/sessions', {
    kind: 'chat', agent, cwd: where.cwd ?? undefined, workspaceId: where.workspaceId ?? undefined, prompt,
  })
  if (s) adoptSession(s)
}

/** «Новый терминал» without a form: the default shell in the given folder. */
export function newTerminal(where: Where) {
  return once('Открываю терминал', async () => {
    const s = await tryApi<Session>('POST', '/sessions', {
      kind: 'terminal', agent: 'shell', cwd: where.cwd ?? undefined, workspaceId: where.workspaceId ?? undefined,
    })
    if (s) adoptSession(s)
  })
}

/** The most specific workspace containing a folder (the projects folder contains every project). */
export function ownerWorkspace<W extends { path: string }>(workspaces: W[], cwd: string): W | undefined {
  const p = normPath(cwd)
  return workspaces.filter((w) => p === normPath(w.path) || p.startsWith(`${normPath(w.path)}/`)).sort((a, b) => b.path.length - a.path.length)[0]
}

/** Project a folder belongs to: a known worktree of it, a session there, or the path prefix. */
export function workspaceFor(cwd: string): string | null {
  const st = getState()
  const p = normPath(cwd)
  for (const [id, list] of Object.entries(st.worktrees)) if (list.some((w) => normPath(w.path) === p)) return id
  const s = st.sessions.find((x) => x.workspaceId && normPath(x.cwd) === p)
  if (s) return s.workspaceId
  return ownerWorkspace(st.workspaces, cwd)?.id ?? null
}

/** Folder for «new chat here»: the worktree or folder on screen, else the projects folder (when the server has one). */
export function currentWhere(): { workspaceId: string | null; cwd: string | null } {
  const st = getState()
  const cwd = st.view.kind === 'wt' ? st.view.cwd : null
  if (cwd) return { workspaceId: workspaceFor(cwd), cwd }
  const root = st.workspaces.find((w) => w.kind === 'root')
  return root ? { workspaceId: root.id, cwd: root.path } : { workspaceId: null, cwd: null }
}

/** «Новый чат в папке…»: register the folder (non-git is fine) and start an instant chat there. */
export function newChatInFolder(path: string) {
  return once('Создаю чат', async () => {
    const ws = await tryApi<Workspace>('POST', '/workspaces', { path, kind: 'folder' })
    if (!ws) return
    setState((st) => ({ workspaces: upsert(st.workspaces, ws) }))
    await createChat({ workspaceId: ws.id, cwd: ws.path })
  })
}
