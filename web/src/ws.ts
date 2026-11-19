import { api, ApiError, errorText, wsUrl } from './api'
import { batch, closeSessionTab, getState, hasFeature, setState, tabKey, toast, upsert, without, wtKey, type WtTabs } from './store'
import { desktopNotify } from './lib/notify'
import { saveDraft } from './lib/draft'
import { applyJobEvent } from './lib/jobs'
import { loadRecovery } from './lib/recovery'
import { normalizePlans, sddKey } from './lib/sdd'
import type { AppState, ClientEvent, Message, ServerEvent, Session, SubAgent, Worktree } from './types'

type TermListener = (data: string, replay: boolean) => void

/** Server lists may be missing or of the wrong shape on version skew: treat anything else as empty. */
const arr = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : [])

let socket: WebSocket | null = null
let retry = 0
let retryTimer = 0
let wasOpen = false // a socket has been open before: the next open is a reconnect
let failed = 0 // connection attempts that never opened since the last open (the server was down, not a dropped socket)
const terms = new Map<string, TermListener>()

// Server events come in bursts (several agents streaming at once): all that came within ~80 ms are applied together —
// one render instead of one per event.
let pending: ServerEvent[] = []
let timer: number | null = null
let due = 0
function flush() {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  const evs = pending
  pending = []
  batch(() => { for (const ev of evs) apply(ev) })
}

/** The chat on screen (its tab is active), or null. */
function visibleSession(): string | null {
  const st = getState()
  if (st.view.kind !== 'wt') return null
  const active = st.wt[wtKey(st.view.cwd)]?.active
  return active?.startsWith('s:') ? active.slice(2) : null
}
/** What the person watches or waits for right now: the open chat's stream, a terminal, a job, a notification. */
function urgent(ev: ServerEvent): boolean {
  if (ev.t === 'term' || ev.t === 'term.replay' || ev.t === 'job' || ev.t === 'notify') return true
  const open = visibleSession()
  return !!open && ((ev.t === 'msg' && ev.sessionId === open) || (ev.t === 'session' && ev.session.id === open))
}
function queue(ev: ServerEvent) {
  pending.push(ev)
  // the open chat streams at ~12 renders a second; other agents' events (the sidebar, the panels) twice a second — with
  // five agents writing, the page used to redraw for all of them every 80 ms; a hidden tab every 2 s
  const wait = document.visibilityState !== 'visible' ? 2000 : urgent(ev) ? 80 : 500
  const at = Date.now() + wait
  if (timer !== null && due <= at) return
  if (timer !== null) window.clearTimeout(timer)
  due = at
  timer = window.setTimeout(flush, wait)
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && pending.length) flush() })

export function connect() {
  window.clearTimeout(retryTimer)
  if (getState().authExpired) return
  setState({ conn: 'connecting' })
  const ws = new WebSocket(wsUrl())
  socket = ws
  let opened = false
  ws.onopen = () => {
    opened = true
    const restarted = wasOpen && failed > 0
    wasOpen = true
    retry = 0
    failed = 0
    setState({ conn: 'open' })
    void refreshState().then((ok) => {
      if (ok && restarted) toast('Сервер перезапущен — всё восстановлено', 'ok')
      if (ok) void loadRecovery()
    })
    for (const id of terms.keys()) send({ t: 'term.attach', id })
  }
  ws.onmessage = (e) => {
    let ev: ServerEvent
    try { ev = JSON.parse(String(e.data)) as ServerEvent } catch { return }
    queue(ev)
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    if (!opened) failed++
    setState({ conn: 'closed' })
    if (getState().authExpired) return
    // A restarted server rejects our old token: the probe flips authExpired and reconnecting stops making sense.
    api('GET', '/state').catch((e) => { if (e instanceof ApiError && e.status === 401) window.clearTimeout(retryTimer) })
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

/** Reload everything the UI holds (state, open transcripts, running sub-agents); false when it failed. */
async function refreshState(): Promise<boolean> {
  try {
    const st = await api<AppState>('GET', '/state')
    setState((s) => {
      // Session tabs of sessions deleted while we were away disappear from their worktrees.
      const ids = new Set(arr(st.sessions).map((x) => x.id))
      const wt: Record<string, WtTabs> = {}
      for (const [k, e] of Object.entries(s.wt)) {
        const tabs = e.tabs.filter((t) => t.kind !== 'session' || ids.has(t.id))
        const active = tabs.some((t) => tabKey(t) === e.active) ? e.active : tabs[0] ? tabKey(tabs[0]) : null
        wt[k] = tabs.length === e.tabs.length ? e : { ...e, tabs, active }
      }
      return {
        loaded: true,
        tasks: arr(st.tasks), sessions: arr(st.sessions), workspaces: arr(st.workspaces), notifications: arr(st.notifications),
        agents: arr(st.agents), defaultAgent: st.defaultAgent ?? null,
        shell: st.shell?.command ?? '', integrations: st.integrations ?? { tasks: false, pr: false },
        features: Array.isArray(st.features) ? st.features : [],
        recentFolders: arr(st.recentFolders),
        wt,
      }
    })
    // Messages may have been missed while disconnected: reload the transcripts we hold.
    for (const id of Object.keys(getState().messages)) {
      loadMessages(id).catch(() => undefined)
    }
    for (const s of arr(st.sessions)) if (s.kind === 'chat' && s.status === 'running') void loadSubagents(s.id)
    return true
  } catch (e) {
    toast(`Не удалось загрузить состояние: ${errorText(e)}`, 'error')
    return false
  }
}

const loading = new Map<string, Message[]>() // sessionId -> msg events received while the fetch is in flight

export async function loadMessages(sessionId: string) {
  if (loading.has(sessionId)) return
  loading.set(sessionId, [])
  try {
    let list = arr(await api<Message[]>('GET', `/sessions/${encodeURIComponent(sessionId)}/messages`))
    for (const m of loading.get(sessionId) ?? []) list = upsert(list, m)
    setState((s) => ({ messages: { ...s.messages, [sessionId]: list } }))
  } finally {
    loading.delete(sessionId)
  }
}

/** Load a transcript once (sidebar and workers panel read the current tool from it); WS keeps it live after. */
export function ensureMessages(sessionId: string) {
  if (getState().messages[sessionId] || loading.has(sessionId)) return
  loadMessages(sessionId).catch(() => undefined)
}

/** Agent-internal sub-agents of a session (read-only registry); live updates come over WS. */
export async function loadSubagents(sessionId: string) {
  if (!hasFeature('subagents')) return
  try {
    const r = await api<{ items: SubAgent[]; problems: string[] }>('GET', `/sessions/${encodeURIComponent(sessionId)}/subagents`)
    setState((s) => ({ subagents: { ...s.subagents, [sessionId]: { items: arr(r?.items), problems: arr(r?.problems) } } }))
  } catch { /* older server or no registry: nothing to show */ }
}

/** A project's worktrees; `enrich` adds dirty/ahead (a git call per worktree, cached on the server) — only for open projects. */
export async function loadWorktrees(workspaceId: string, enrich = false) {
  let list: Worktree[] = []
  try {
    list = arr(await api<Worktree[]>('GET', `/workspaces/${encodeURIComponent(workspaceId)}/worktrees${enrich ? '?enrich=1' : ''}`))
  } catch { /* not a git repo or gone: show none */ }
  setState((s) => ({ worktrees: { ...s.worktrees, [workspaceId]: list } }))
}

const startingSince = new Map<string, number>()

/** How long each turn sat in phase «starting» (CLI + MCP cold start); the last three per session are kept. */
function noteStart(s: Session) {
  const was = startingSince.get(s.id)
  if (s.status === 'running' && s.phase === 'starting') { if (!was) startingSince.set(s.id, Date.now()); return }
  if (!was) return
  startingSince.delete(s.id)
  const ms = Date.now() - was
  setState((st) => ({ slowStarts: { ...st.slowStarts, [s.id]: [...(st.slowStarts[s.id] ?? []), ms].slice(-3) } }))
}

function apply(ev: ServerEvent) {
  switch (ev.t) {
    case 'job':
      applyJobEvent(ev)
      break
    case 'task': {
      const before = getState().tasks.find((t) => t.id === ev.task.id)?.worktrees ?? null
      if (before) {
        for (const w of ev.task.worktrees ?? []) {
          if (before.some((b) => b.path === w.path)) continue
          const repo = getState().workspaces.find((x) => x.id === w.workspaceId)?.name ?? w.path
          toast(`Агент создал рабочее дерево: ${repo}${w.branch ? ` · ${w.branch}` : ''}`, 'ok')
        }
      }
      setState((s) => ({ tasks: upsert(s.tasks, ev.task) }))
      break
    }
    case 'task.del':
      for (const f of ['title', 'branch', 'description']) saveDraft(`task:${ev.id}:${f}`, null)
      setState((s) => ({ tasks: without(s.tasks, ev.id), focusTaskId: s.focusTaskId === ev.id ? null : s.focusTaskId }))
      break
    case 'session':
      noteStart(ev.session)
      setState((s) => ({ sessions: upsert(s.sessions, ev.session) }))
      break
    case 'session.del':
      closeSessionTab(ev.id)
      saveDraft(`scroll:${ev.id}`, null)
      saveDraft(`seen:${ev.id}`, null)
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
      if (!getState().notifications.some((n) => n.id === ev.n.id)) desktopNotify(ev.n)
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
    case 'worktree.meta': {
      // label, pinned, sleeping, lastError, createdBy…: the full meta of one worktree, in place
      const key = wtKey(ev.path)
      setState((s) => ({
        worktrees: Object.fromEntries(Object.entries(s.worktrees).map(([id, list]) =>
          [id, list.some((w) => wtKey(w.path) === key) ? list.map((w) => (wtKey(w.path) === key ? { ...w, meta: ev.meta } : w)) : list])),
      }))
      break
    }
    case 'sdd':
      // with sessionId: only that chat's plans (the server filters them); without: the whole folder
      setState((s) => ({ sdd: { ...s.sdd, [sddKey(ev.cwd, ev.sessionId)]: normalizePlans(ev.plans) } }))
      break
    case 'term':
    case 'term.replay':
      terms.get(ev.id)?.(ev.data, ev.t === 'term.replay')
      break
  }
}
