import { useSyncExternalStore } from 'react'
import type { AgentInfo, Integrations, Message, Notification, Session, SubAgent, Task, Workspace, Worktree } from './types'

export type Tab =
  | { kind: 'board' }
  | { kind: 'agents' }
  | { kind: 'inbox' }
  | { kind: 'settings' }
  | { kind: 'session'; id: string }
  | { kind: 'file'; cwd: string; path: string }
  | { kind: 'diff'; cwd: string; path: string | null }

export type DialogRequest =
  | { kind: 'workspace' }
  | { kind: 'chat'; workspaceId?: string; cwd?: string }
  | { kind: 'terminal'; workspaceId?: string; cwd?: string }
  | { kind: 'worktree'; workspaceId?: string }
  | { kind: 'pr'; cwd: string }
  | { kind: 'start'; taskId: string }

export interface Toast { id: number; text: string; tone: 'info' | 'ok' | 'error'; href?: string }

type Theme = 'dark' | 'light'

interface Prefs {
  tabs: Tab[]
  active: string
  sidebar: boolean
  sidebarWidth: number
  panel: boolean
  panelTab: 'files' | 'changes'
  theme: Theme | null // null = follow the OS
  cwd: string | null // folder picked in the sidebar; the panel falls back to it
  drafts: Record<string, string> // unsent composer text per chat session
}

export interface State extends Prefs {
  conn: 'connecting' | 'open' | 'closed'
  loaded: boolean
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
  dirty: Record<string, boolean>
  toasts: Toast[]
  focusTaskId: string | null
  dialog: DialogRequest | null
  back: string[] // tab navigation history (keys)
  forward: string[]
}

export const tabKey = (t: Tab): string => {
  switch (t.kind) {
    case 'session': return `s:${t.id}`
    case 'file': return `f:${t.cwd}|${t.path}`
    case 'diff': return `d:${t.cwd}|${t.path ?? ''}`
    default: return t.kind
  }
}

const PREFS_KEY = 'harness.ui.v1'
const defaultPrefs: Prefs = {
  tabs: [{ kind: 'board' }], active: 'board', sidebar: true, sidebarWidth: 300, panel: false, panelTab: 'changes', theme: null, cwd: null, drafts: {},
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return defaultPrefs
    const p = JSON.parse(raw) as Partial<Prefs>
    return { ...defaultPrefs, ...p, tabs: Array.isArray(p.tabs) && p.tabs.length ? p.tabs : defaultPrefs.tabs }
  } catch {
    return defaultPrefs
  }
}

const media = window.matchMedia('(prefers-color-scheme: light)')
const resolveScheme = (pref: Theme | null): Theme => pref ?? (media.matches ? 'light' : 'dark')

const prefs = readPrefs()
let state: State = {
  ...prefs,
  conn: 'connecting', loaded: false, scheme: resolveScheme(prefs.theme),
  tasks: [], sessions: [], workspaces: [], notifications: [], agents: [], defaultAgent: null, shell: '',
  integrations: { tasks: false, pr: false },
  messages: {}, subagents: {}, worktrees: {}, dirty: {}, toasts: [], focusTaskId: null, dialog: null, back: [], forward: [],
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
media.addEventListener('change', () => setState({ scheme: resolveScheme(state.theme) }))

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

// ---------- tabs ----------

const navTo = (s: State, key: string) =>
  s.active === key ? {} : { active: key, back: [...s.back.slice(-49), s.active].filter(Boolean), forward: [] }

export function openTab(tab: Tab) {
  const key = tabKey(tab)
  setState((s) => {
    if (s.tabs.some((t) => tabKey(t) === key)) return navTo(s, key)
    const at = s.tabs.findIndex((t) => tabKey(t) === s.active)
    const tabs = s.tabs.slice()
    tabs.splice(at + 1, 0, tab)
    return { tabs, ...navTo(s, key) }
  })
}

export const activateTab = (key: string) => setState((s) => navTo(s, key))

/** Step through tab history, skipping tabs that were closed since. */
export function navigate(dir: 'back' | 'forward') {
  setState((s) => {
    const open = new Set(s.tabs.map(tabKey))
    const back = s.back.filter((k) => open.has(k))
    const forward = s.forward.filter((k) => open.has(k))
    const [from, to] = dir === 'back' ? [back, forward] : [forward, back]
    const key = from.pop()
    if (!key) return { back, forward }
    if (s.active) to.push(s.active)
    return { active: key, back, forward }
  })
}

export function closeTab(key: string) {
  const s = state
  if (s.dirty[key] && !window.confirm('В файле есть несохранённые изменения. Закрыть без сохранения?')) return
  const i = s.tabs.findIndex((t) => tabKey(t) === key)
  if (i < 0) return
  const tabs = s.tabs.filter((_, j) => j !== i)
  const dirty = { ...s.dirty }
  delete dirty[key]
  if (!tabs.length) {
    setState({ tabs: [{ kind: 'board' }], active: 'board', dirty, back: [], forward: [] })
    return
  }
  if (s.active !== key) { setState({ tabs, dirty }); return }
  // Closing the active tab returns to the one used before it (else the left neighbour).
  const open = new Set(tabs.map(tabKey))
  const back = s.back.filter((k) => open.has(k))
  const next = back.pop() ?? tabKey(tabs[Math.max(0, i - 1)])
  setState({ tabs, dirty, active: next, back })
}

export const openSession = (id: string) => openTab({ kind: 'session', id })

export function tabCwd(tab: Tab | undefined, sessions: Session[]): string | null {
  if (tab?.kind === 'session') return sessions.find((s) => s.id === tab.id)?.cwd ?? null
  if (tab?.kind === 'file' || tab?.kind === 'diff') return tab.cwd
  return null
}

/** Folder the workspace panel is bound to: active tab's cwd, else the sidebar pick, else the first workspace. */
export function useActiveCwd(): string | null {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.active)
  const sessions = useStore((s) => s.sessions)
  const picked = useStore((s) => s.cwd)
  const first = useStore((s) => s.workspaces[0]?.path ?? null)
  return tabCwd(tabs.find((t) => tabKey(t) === active), sessions) ?? picked ?? first
}

export function openTask(id: string) {
  openTab({ kind: 'board' })
  setState({ focusTaskId: id })
}

export function setDirty(key: string, value: boolean) {
  if (!!state.dirty[key] === value) return
  setState((s) => ({ dirty: { ...s.dirty, [key]: value } }))
}

export function showPanel(tab: 'files' | 'changes') {
  setState({ panel: true, panelTab: tab })
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

export function dismissToast(id: number) {
  if (state.toasts.some((t) => t.id === id)) setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}
