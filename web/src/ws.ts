import { api, errorText, wsUrl } from './api'
import { closeTab, getState, setState, tabKey, toast, upsert, without, type Tab } from './store'
import type { AppState, ClientEvent, Message, ServerEvent, SubAgent, Worktree } from './types'

type TermListener = (data: string, replay: boolean) => void

let socket: WebSocket | null = null
let retry = 0
let retryTimer = 0
const terms = new Map<string, TermListener>()

export function connect() {
  window.clearTimeout(retryTimer)
  setState({ conn: 'connecting' })
  const ws = new WebSocket(wsUrl())
  socket = ws
  ws.onopen = () => {
    retry = 0
    setState({ conn: 'open' })
    void refreshState()
    for (const id of terms.keys()) send({ t: 'term.attach', id })
  }
  ws.onmessage = (e) => {
    let ev: ServerEvent
    try { ev = JSON.parse(String(e.data)) as ServerEvent } catch { return }
    apply(ev)
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    setState({ conn: 'closed' })
    const delay = Math.min(15000, 500 * 2 ** retry++) * (0.8 + Math.random() * 0.4)
    retryTimer = window.setTimeout(connect, delay)
  }
}

export function reconnectNow() {
  if (socket) return
  retry = 0
  connect()
}

export function send(ev: ClientEvent) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ev))
}

/** One live view per terminal session. Re-attached automatically after reconnect. */
export function attachTerm(id: string, listener: TermListener) {
  terms.set(id, listener)
  send({ t: 'term.attach', id })
  return () => {
    if (terms.get(id) === listener) terms.delete(id)
    send({ t: 'term.detach', id })
  }
}

async function refreshState() {
  try {
    const st = await api<AppState>('GET', '/state')
    setState((s) => {
      const ids = new Set(st.sessions.map((x) => x.id))
      const kept = s.tabs.filter((t) => t.kind !== 'session' || ids.has(t.id))
      const tabs: Tab[] = kept.length ? kept : [{ kind: 'board' }]
      const active = tabs.some((t) => tabKey(t) === s.active) ? s.active : tabKey(tabs[0])
      return {
        loaded: true,
        tasks: st.tasks, sessions: st.sessions, workspaces: st.workspaces, notifications: st.notifications,
        agents: st.agents, defaultAgent: st.defaultAgent ?? null,
        shell: st.shell?.command ?? '', integrations: st.integrations ?? { tasks: false, pr: false },
        tabs, active,
      }
    })
    // Messages may have been missed while disconnected: reload the transcripts we hold.
    for (const id of Object.keys(getState().messages)) {
      loadMessages(id).catch(() => undefined)
    }
    for (const s of st.sessions) if (s.kind === 'chat' && s.status === 'running') void loadSubagents(s.id)
  } catch (e) {
    toast(`Не удалось загрузить состояние: ${errorText(e)}`, 'error')
  }
}

const loading = new Map<string, Message[]>() // sessionId -> msg events received while the fetch is in flight

export async function loadMessages(sessionId: string) {
  if (loading.has(sessionId)) return
  loading.set(sessionId, [])
  try {
    let list = await api<Message[]>('GET', `/sessions/${encodeURIComponent(sessionId)}/messages`)
    for (const m of loading.get(sessionId) ?? []) list = upsert(list, m)
    setState((s) => ({ messages: { ...s.messages, [sessionId]: list } }))
  } finally {
    loading.delete(sessionId)
  }
}

/** Agent-internal sub-agents of a session (read-only registry); live updates come over WS. */
export async function loadSubagents(sessionId: string) {
  try {
    const r = await api<{ items: SubAgent[]; problems: string[] }>('GET', `/sessions/${encodeURIComponent(sessionId)}/subagents`)
    setState((s) => ({ subagents: { ...s.subagents, [sessionId]: { items: r.items ?? [], problems: r.problems ?? [] } } }))
  } catch { /* older server or no registry: nothing to show */ }
}

export async function loadWorktrees(workspaceId: string) {
  let list: Worktree[] = []
  try {
    list = await api<Worktree[]>('GET', `/workspaces/${encodeURIComponent(workspaceId)}/worktrees`)
  } catch { /* not a git repo or gone: show none */ }
  setState((s) => ({ worktrees: { ...s.worktrees, [workspaceId]: list } }))
}

function apply(ev: ServerEvent) {
  switch (ev.t) {
    case 'task':
      setState((s) => ({ tasks: upsert(s.tasks, ev.task) }))
      break
    case 'task.del':
      setState((s) => ({ tasks: without(s.tasks, ev.id), focusTaskId: s.focusTaskId === ev.id ? null : s.focusTaskId }))
      break
    case 'session':
      setState((s) => ({ sessions: upsert(s.sessions, ev.session) }))
      break
    case 'session.del':
      closeTab(tabKey({ kind: 'session', id: ev.id }))
      setState((s) => {
        const messages = { ...s.messages }
        const subagents = { ...s.subagents }
        const drafts = { ...s.drafts }
        delete messages[ev.id]
        delete subagents[ev.id]
        delete drafts[ev.id]
        return { sessions: without(s.sessions, ev.id), messages, subagents, drafts }
      })
      break
    case 'msg': {
      const pending = loading.get(ev.sessionId)
      if (pending) pending.push(ev.msg)
      else if (getState().messages[ev.sessionId]) {
        setState((s) => ({ messages: { ...s.messages, [ev.sessionId]: upsert(s.messages[ev.sessionId], ev.msg) } }))
      }
      break
    }
    case 'notify':
      setState((s) => ({ notifications: upsert(s.notifications, ev.n) }))
      break
    case 'workspaces':
      setState({ workspaces: ev.workspaces })
      break
    case 'subagents':
      setState((s) => ({
        subagents: { ...s.subagents, [ev.sessionId]: { items: ev.items, problems: s.subagents[ev.sessionId]?.problems ?? [] } },
      }))
      break
    case 'term':
    case 'term.replay':
      terms.get(ev.id)?.(ev.data, ev.t === 'term.replay')
      break
  }
}
