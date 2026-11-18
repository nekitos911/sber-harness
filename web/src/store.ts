import { useSyncExternalStore } from 'react'
import type { PrListState, PrScope } from './lib/prsMine'
import type { AgentGitJob } from './lib/agentGit'
import type { AgentInfo, AgentMeta, HistoryItem, RecoveryState, GitStatus, SddPlan, Settings, Integrations, Message, Notification, Session, SubAgent, Task, Workspace, Worktree } from './types'
import type { DiffFile } from './lib/diff'
import { normPath } from './lib/format'
import type { PrState } from './lib/pr'

export type Screen = 'board' | 'agents' | 'prs' | 'inbox' | 'settings'

/** A tab always lives in one worktree (cwd): chats and terminals by their session cwd, files and diffs by theirs. */
export type Tab =
  | { kind: 'session'; id: string }
  | { kind: 'file'; cwd: string; path: string }
  | { kind: 'diff'; cwd: string; path: string | null }
  | { kind: 'history'; cwd: string; agent: string; id: string; title: string } // a CLI-recorded chat, read-only

/** Main area: a full-screen global view, or one worktree with its own tab strip. */
export type View = { kind: 'screen'; screen: Screen } | { kind: 'wt'; cwd: string }

export interface WtTabs { cwd: string; tabs: Tab[]; active: string | null }

/** A history entry for back/forward: a screen, or a worktree with the tab shown in it. */
export type Loc = { screen: Screen } | { cwd: string; tab: string | null }

export type DialogRequest =
  | { kind: 'workspace' }
  | { kind: 'chat'; workspaceId?: string; cwd?: string }
  | { kind: 'terminal'; workspaceId?: string; cwd?: string }
  | { kind: 'worktree'; workspaceId?: string }
  | { kind: 'pr'; cwd: string; base?: string }
  | { kind: 'start'; taskId: string }
  | { kind: 'wt-delete'; workspaceId: string; path: string }
  | { kind: 'wt-info'; workspaceId: string; path: string }
  | { kind: 'wt-cleanup'; workspaceId: string }
  | { kind: 'folder-chat' }
  | { kind: 'recovery' }
  | { kind: 'session-delete'; id: string }
  | { kind: 'confirm'; title: string; text: string; ok: string; danger?: boolean; onConfirm: () => void }
  | { kind: 'session-archive'; id: string } // still working: confirm stopping it
  | { kind: 'session-perms'; id: string }

export interface Toast { id: number; text: string; tone: 'info' | 'ok' | 'error'; href?: string; leaving?: boolean }

/** A long operation in flight (lib/jobs): label, the server's current step, error with retry. Inline jobs show in their dialog. */
export interface Job { id: string; label: string; step: string | null; started: number; error: string | null; retry?: () => void; inline?: boolean }

/** Git state of one worktree: status plus the whole-tree diff parsed once (per-file +N −M and inline diffs). */
export interface GitInfo { status: GitStatus | null; error: string | null; files: DiffFile[] | null }

type Theme = 'dark' | 'light'

interface Prefs {
  view: View
  wt: Record<string, WtTabs> // key = normPath(cwd): every worktree remembers its tabs and active tab
  sidebar: boolean
  sidebarWidth: number
  panel: boolean
  panelTab: 'files' | 'changes' | 'verdicts' | 'history'
  theme: Theme | null // null = default (dark)
  drafts: Record<string, string> // unsent composer text per chat session
}

export interface State extends Prefs {
  conn: 'connecting' | 'open' | 'closed'
  loaded: boolean
  authExpired: boolean // server restarted with a new token: only a reload helps
  scheme: Theme
  tasks: Task[]
  sessions: Session[]
  workspaces: Workspace[]
  notifications: Notification[]
  agents: AgentInfo[]
  defaultAgent: string | null
  shell: string
  integrations: Integrations
  messages: Record<string, Message[]>
  subagents: Record<string, { items: SubAgent[]; problems: string[] }>
  worktrees: Record<string, Worktree[]>
  git: Record<string, GitInfo> // key = normPath(cwd)
  agentMeta: Record<string, AgentMeta | null> // null = this server has no /agents/:id/info
  settings: Settings | null // loaded on demand (pickers need grades; the settings screen edits it)
  prs: Record<string, PrState | undefined> // key = normPath(cwd): PR of the branch checked out there
  prsMine: Partial<Record<PrScope, PrListState>> // GET /api/prs: «Мои» / «По задачам»
  sdd: Record<string, SddPlan[] | null> // key = normPath(cwd): /full-task plans and verdicts (null: server lacks it)
  recentFolders: string[]
  slowStarts: Record<string, number[]> // sessionId -> how long the last turns sat in phase «starting» (ms)
  agentGit: Record<string, AgentGitJob | undefined> // key = normPath(cwd): a commit / push / PR the agent is doing there
  sbOverlay: boolean // narrow window: the sidebar opened over the content from its icon rail
  panelOverlay: boolean // narrow window: the right panel opened over the content
  history: Record<string, HistoryItem[]> // key = normPath(cwd): CLI-recorded chats of that folder
  recovery: RecoveryState | null // interrupted sessions waiting for «продолжить» or «не продолжать»
  features: string[] // optional API groups of this server; an optional endpoint is called only when listed
  dirty: Record<string, boolean>
  toasts: Toast[]
  jobs: Job[]
  focusTaskId: string | null
  dialog: DialogRequest | null
  back: Loc[]
  forward: Loc[]
}

export const tabKey = (t: Tab): string => {
  switch (t.kind) {
    case 'session': return `s:${t.id}`
    case 'file': return `f:${t.path}`
    case 'diff': return `d:${t.path ?? ''}`
    case 'history': return `h:${t.agent}:${t.id}`
  }
}

export const wtKey = (cwd: string) => normPath(cwd)

const PREFS_KEY = 'harness.ui.v2'
const defaultPrefs: Prefs = {
  view: { kind: 'screen', screen: 'board' }, wt: {}, sidebar: true, sidebarWidth: 288, panel: true, panelTab: 'changes', theme: null, drafts: {},
}

const SCREENS = new Set<Screen>(['board', 'agents', 'prs', 'inbox', 'settings'])
const validView = (v: unknown): v is View => {
  const x = v as View | null
  return !!x && ((x.kind === 'screen' && SCREENS.has(x.screen)) || (x.kind === 'wt' && typeof x.cwd === 'string'))
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return defaultPrefs
    const p = JSON.parse(raw) as Partial<Prefs>
    const wt: Record<string, WtTabs> = {}
    for (const [k, e] of Object.entries(p.wt ?? {})) {
      if (e && typeof e.cwd === 'string' && Array.isArray(e.tabs)) wt[k] = { cwd: e.cwd, tabs: e.tabs, active: typeof e.active === 'string' ? e.active : null }
    }
    return { ...defaultPrefs, ...p, view: validView(p.view) ? p.view : defaultPrefs.view, wt }
  } catch {
    return defaultPrefs
  }
}

const resolveScheme = (pref: Theme | null): Theme => pref ?? 'dark'

const prefs = readPrefs()
let state: State = {
  ...prefs,
  conn: 'connecting', loaded: false, authExpired: false, scheme: resolveScheme(prefs.theme),
  tasks: [], sessions: [], workspaces: [], notifications: [], agents: [], defaultAgent: null, shell: '',
  integrations: { tasks: false, pr: false },
  messages: {}, subagents: {}, worktrees: {}, git: {}, agentMeta: {}, settings: null, prs: {}, prsMine: {}, sdd: {}, recentFolders: [], slowStarts: {}, agentGit: {}, sbOverlay: false, panelOverlay: false, history: {}, recovery: null, features: [], dirty: {}, toasts: [], jobs: [], focusTaskId: null, dialog: null, back: [], forward: [],
}

const listeners = new Set<() => void>()

export const getState = () => state

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch
  const prev = state
  state = { ...state, ...next }
  if (state.theme !== prev.theme) state = { ...state, scheme: resolveScheme(state.theme) }
  if (state.scheme !== prev.scheme) document.documentElement.dataset.theme = state.scheme
  savePrefs(prev)
  listeners.forEach((l) => l())
}

function savePrefs(prev: State) {
  const keys = Object.keys(defaultPrefs) as (keyof Prefs)[]
  if (keys.every((k) => prev[k] === state[k])) return
  try {
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = state[k]
    localStorage.setItem(PREFS_KEY, JSON.stringify(out))
  } catch { /* storage unavailable: prefs stay in memory */ }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Selector must return a stored reference (or a primitive), never a fresh object. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

document.documentElement.dataset.theme = state.scheme

// ---------- server features (client/server version skew) ----------

export type Feature = 'sdd' | 'subagents' | 'virtual-sessions' | 'worker-run' | 'pr-status' | 'branches' | 'fs-search'
  | 'agent-info' | 'models-refresh' | 'tracker-links' | 'worktree-meta' | 'open' | 'board-columns' | 'review-loop' | 'skills-install' | 'demo'
  | 'fs-raw' | 'rework' | 'tracker-import' | 'folders' | 'include-dirs' | 'acp' | 'pr-decline' | 'questions' | 'permissions' | 'activity' | 'recovery' | 'cli-history' | 'prs-mine' | 'git-generate' | 'git-via-agent' | 'git-stage' | 'handoff'

/** Whether this server implements an optional API group (no flag list = an older server = none). */
export const hasFeature = (f: Feature) => state.features.includes(f)
export const useFeature = (f: Feature) => useStore((s) => s.features.includes(f))

// ---------- collections ----------

export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id === item.id) {
      const copy = list.slice()
      copy[i] = item
      return copy
    }
  }
  return [...list, item]
}

export const without = <T extends { id: string }>(list: T[], id: string) => list.filter((x) => x.id !== id)

/**
 * A session from an HTTP answer: kept only if not older than what WS already delivered (a slow response to «send»
 * or «start» must not put a finished turn back to «running»).
 */
export function upsertSession(list: Session[], s: Session): Session[] {
  const cur = list.find((x) => x.id === s.id)
  return cur && cur.lastActivityAt > s.lastActivityAt ? list : upsert(list, s)
}

// ---------- navigation: screens, worktrees, tabs ----------

const locKey = (l: Loc) => ('screen' in l ? `@${l.screen}` : `${wtKey(l.cwd)}#${l.tab ?? ''}`)

const currentLoc = (s: Pick<State, 'view' | 'wt'>): Loc =>
  s.view.kind === 'screen' ? { screen: s.view.screen } : { cwd: s.view.cwd, tab: s.wt[wtKey(s.view.cwd)]?.active ?? null }

/** View + per-worktree active tab for a location; tab null keeps the worktree's remembered tab. */
function applyLoc(wt: Record<string, WtTabs>, loc: Loc): Pick<State, 'view' | 'wt'> {
  if ('screen' in loc) return { view: { kind: 'screen', screen: loc.screen }, wt }
  const k = wtKey(loc.cwd)
  const entry = wt[k] ?? { cwd: loc.cwd, tabs: [], active: null }
  const active = loc.tab ?? entry.active
  return { view: { kind: 'wt', cwd: entry.cwd }, wt: wt[k] && entry.active === active ? wt : { ...wt, [k]: { ...entry, active } } }
}

/** Go somewhere and remember where we came from (unless it is the same place). */
function go(s: State, loc: Loc, wt = s.wt): Partial<State> {
  const from = currentLoc(s)
  const next = applyLoc(wt, loc)
  if (locKey(from) === locKey(currentLoc(next))) return next
  return { ...next, back: [...s.back.slice(-49), from], forward: [] }
}

export const openScreen = (screen: Screen) => setState((s) => go(s, { screen }))
export const openWorktree = (cwd: string) => setState((s) => go(s, { cwd, tab: null }))

export function tabCwd(tab: Tab, sessions: Session[]): string | null {
  return tab.kind === 'session' ? sessions.find((s) => s.id === tab.id)?.cwd ?? null : tab.cwd
}

/** Open a tab in its worktree (created next to the active one) and switch there. */
export function openTab(tab: Tab) {
  setState((s) => {
    const cwd = tabCwd(tab, s.sessions)
    if (!cwd) return {}
    const k = wtKey(cwd)
    const entry = s.wt[k] ?? { cwd, tabs: [], active: null }
    const key = tabKey(tab)
    let tabs = entry.tabs
    if (!tabs.some((t) => tabKey(t) === key)) {
      const at = tabs.findIndex((t) => tabKey(t) === entry.active)
      tabs = at < 0 ? [...tabs, tab] : [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)]
    }
    return go(s, { cwd: entry.cwd, tab: key }, { ...s.wt, [k]: { ...entry, tabs } })
  })
}

export const openSession = (id: string) => openTab({ kind: 'session', id })
export const activateTab = (cwd: string, key: string) => setState((s) => go(s, { cwd, tab: key }))

const hasTab = (s: State, l: Loc) => 'screen' in l || !l.tab || !!s.wt[wtKey(l.cwd)]?.tabs.some((t) => tabKey(t) === l.tab)

/** Step through history across screens and worktree tabs, skipping tabs closed since. */
export function navigate(dir: 'back' | 'forward') {
  setState((s) => {
    const back = s.back.filter((l) => hasTab(s, l))
    const forward = s.forward.filter((l) => hasTab(s, l))
    const [from, to] = dir === 'back' ? [back, forward] : [forward, back]
    const here = locKey(currentLoc(s))
    let loc = from.pop()
    while (loc && locKey(loc) === here) loc = from.pop()
    if (!loc) return { back, forward }
    to.push(currentLoc(s))
    return { ...applyLoc(s.wt, loc), back, forward }
  })
}

/** Unsaved-file flags are per worktree tab. */
export const dirtyKey = (cwd: string, key: string) => `${wtKey(cwd)}|${key}`

/** Close a tab of a worktree; if it was active, the tab used before it there (else its left neighbour) takes over. */
export function closeTab(cwd: string, key: string, force = false) {
  const s = state
  const k = wtKey(cwd)
  const entry = s.wt[k]
  const i = entry ? entry.tabs.findIndex((t) => tabKey(t) === key) : -1
  if (!entry || i < 0) return
  const dk = dirtyKey(cwd, key)
  if (s.dirty[dk] && !force) {
    openDialog({ kind: 'confirm', title: 'Закрыть без сохранения?', text: 'В файле есть несохранённые изменения — они пропадут.', ok: 'Закрыть без сохранения', danger: true, onConfirm: () => closeTab(cwd, key, true) })
    return
  }
  const tabs = entry.tabs.filter((_, j) => j !== i)
  const dirty = { ...s.dirty }
  delete dirty[dk]
  let active = entry.active
  if (active === key) {
    const open = new Set(tabs.map(tabKey))
    const prev = [...s.back].reverse().find((l): l is { cwd: string; tab: string } => 'cwd' in l && wtKey(l.cwd) === k && !!l.tab && open.has(l.tab))
    active = prev?.tab ?? (tabs.length ? tabKey(tabs[Math.max(0, i - 1)]) : null)
  }
  setState({ wt: { ...s.wt, [k]: { ...entry, tabs, active } }, dirty })
}

/** A deleted session disappears from whichever worktree holds its tab. */
export function closeSessionTab(id: string) {
  const key = tabKey({ kind: 'session', id })
  for (const e of Object.values(state.wt)) if (e.tabs.some((t) => tabKey(t) === key)) closeTab(e.cwd, key)
}

/** Folder the workspace panel and «new chat here» are bound to: the worktree on screen. */
export const useActiveCwd = () => useStore((s) => (s.view.kind === 'wt' ? s.view.cwd : null))

export function openTask(id: string) {
  openScreen('board')
  setState({ focusTaskId: id })
}

export function setDirty(key: string, value: boolean) {
  if (!!state.dirty[key] === value) return
  setState((s) => ({ dirty: { ...s.dirty, [key]: value } }))
}

export function showPanel(tab: 'files' | 'changes' | 'verdicts' | 'history') {
  setState({ panel: true, panelOverlay: true, panelTab: tab }) // panelOverlay matters only in a narrow window
}

export function setDraft(sessionId: string, text: string) {
  setState((s) => {
    const drafts = { ...s.drafts }
    if (text) drafts[sessionId] = text
    else delete drafts[sessionId]
    return { drafts }
  })
}

export const openDialog = (dialog: DialogRequest) => setState({ dialog })
export const closeDialog = () => setState({ dialog: null })

// ---------- toasts ----------

let toastSeq = 0
export function toast(text: string, tone: Toast['tone'] = 'info', href?: string) {
  const id = ++toastSeq
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone, href }] }))
  window.setTimeout(() => dismissToast(id), tone === 'error' ? 9000 : 5000)
}

/** Mark as leaving first so the exit transition can run, then drop it. */
export function dismissToast(id: number) {
  if (!state.toasts.some((t) => t.id === id && !t.leaving)) return
  setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
  window.setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 160)
}
