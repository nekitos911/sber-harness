// «Обзор» of a chat: its original task, the tree of its helpers, where they worked, its key events. Pure: types only
// (node --test runs it as is).
import type { Message, Session } from '../types'
import type { VisualState } from './sessionState'

// the harness's own paragraphs in a message (adopt.js cliTitle drops the same ones)
const HARNESS_BLOCK = /^\s*(\[harness\]|Ты работаешь внутри harness|Субагенты не запускают своих субагентов)/

/** The words of a message without the harness preamble paragraphs (a recorded CLI chat may carry them). */
export function taskText(text: string): string {
  const kept = text.split(/\n\s*\n/).filter((p) => !HARNESS_BLOCK.test(p)).join('\n\n').trim()
  // a GigaCode record opens its first message with the folder on a line of its own
  const lines = kept.split('\n')
  return lines.length > 1 && /^([a-zA-Z]:[\\/]|\/)\S*$/.test(lines[0].trim()) ? lines.slice(1).join('\n').trim() : kept
}

/** Scroll that chat's transcript to a message (ChatView listens; it unfolds «Показать ранее» when needed). */
export const gotoMessage = (sessionId: string, messageId: string) =>
  window.dispatchEvent(new CustomEvent('harness:goto', { detail: { sessionId, messageId } }))

export const firstLine =(text: string) => text.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, ' ') ?? ''

/**
 * One line of a person's markdown as plain text: «**модуль** `ledger/5.ts`» → «модуль ledger/5.ts». Underscores stay
 * (paths and identifiers use them far more often than emphasis does).
 */
export const plainInline = (line: string) => line
  .replace(/^\s*(#{1,6}|>|[-*+])\s+/, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '$1')
  .replace(/(^|[^\w*])\*(\S(?:.*?\S)?)\*(?!\w)/g, '$1$2')

/** The message that started the chat. */
export const firstTask = (list: Message[]): Message | null => list.find((m) => m.kind === 'user') ?? null

/** One line of the task: «/full-task KEY · title» for a command with a bound task, else the first line. */
export function taskHead(text: string, task?: { key: string; title: string } | null): string {
  const line = plainInline(firstLine(taskText(text)))
  if (!line.startsWith('/') || !task) return line
  return `${line.includes(task.key) ? line : `${line} ${task.key}`} · ${task.title}`
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim()

/**
 * The chat of a harness `agent` / `worker_run` call that carries no subSessionId: the sessionId its output names
 * ({ sessionId, placement, background? }), else the newest child started at/after the call whose first message is the
 * call's prompt. `kids`: the calling chat's children with their first user message (undefined: not loaded yet).
 */
export function childOfCall(call: { at: number; prompt: string; output: string | null }, kids: { id: string; createdAt: number; first?: string }[]): string | null {
  const named = /"sessionId"\s*:\s*"([^"]+)"/.exec(call.output ?? '')?.[1]
  if (named) return named
  const want = squash(call.prompt).slice(0, 200)
  if (!want) return null
  const hit = kids.filter((k) => k.createdAt >= call.at - 2000 && k.first !== undefined && squash(taskText(k.first)).startsWith(want))
  return hit.sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null
}

export interface TreeNode{ s: Session; depth: number }

/** Every chat started from `id` (its helpers, theirs, GigaCode's built-in ones), depth-first in start order. */
export function descendants(sessions: Session[], id: string): TreeNode[] {
  const kids = new Map<string, Session[]>()
  for (const s of sessions) {
    if (!s.parentId || s.system || s.kind !== 'chat') continue
    const l = kids.get(s.parentId)
    if (l) l.push(s)
    else kids.set(s.parentId, [s])
  }
  const out: TreeNode[] = []
  const seen = new Set([id]) // a parent loop must not hang the panel
  const walk = (pid: string, depth: number) => {
    for (const s of [...(kids.get(pid) ?? [])].sort((a, b) => a.createdAt - b.createdAt)) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push({ s, depth })
      walk(s.id, depth + 1)
    }
  }
  walk(id, 0)
  return out
}

export type Bucket = 'run' | 'wait' | 'done' | 'fail' | 'stop'

/** A helper's state in the counts at the top: its report decides once it settled, else what it is doing. */
export function bucket(v: VisualState, report?: Session['report']): Bucket {
  if (v === 'waiting_answer' || v === 'waiting_permission' || v === 'auth') return 'wait'
  if (v === 'running' || v === 'starting' || v === 'stalled') return 'run'
  if (v === 'error' || v === 'interrupted' || report?.status === 'failed' || report?.status === 'timeout') return 'fail'
  if (v === 'stopped' || report?.status === 'stopped') return 'stop'
  return 'done'
}

export interface Place { path: string; branch: string | null; sessions: number }

/** The folders (worktrees) the chats worked in, the chat's own first. */
export function places(list: Session[]): Place[] {
  const out = new Map<string, Place>()
  for (const s of list) {
    const path = s.worktreePath || s.cwd
    if (!path) continue
    const k = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const p = out.get(k)
    if (p) { p.sessions++; p.branch ??= s.branch } else out.set(k, { path, branch: s.branch, sessions: 1 })
  }
  return [...out.values()]
}

export type EventKind = 'user' | 'harness' | 'agent' | 'error' | 'question' | 'permission' | 'git' | 'sub-start' | 'sub-end'
export interface ChatEvent { key: string; at: number; kind: EventKind; text: string; messageId?: string; sessionId?: string; from?: string | null }

const GIT_CMD = /\bgit\s+(commit|push)\b/
const PR_TOOL = /pull_?request|create_?pr|pr_create/i

/** The chat's key events: who wrote, its helpers starting and finishing, errors, questions, commits and PRs. */
export function timeline(list: Message[], kids: Session[]): ChatEvent[] {
  const out: ChatEvent[] = []
  for (const m of list) {
    const at = { key: m.id, at: m.at, messageId: m.id }
    if (m.kind === 'user') {
      const kind = !m.from || m.from === 'user' ? 'user' : m.from === 'harness' ? 'harness' : 'agent'
      out.push({ ...at, kind, text: plainInline(firstLine(taskText(m.text))), from: m.from })
    } else if (m.kind === 'error') out.push({ ...at, kind: 'error', text: firstLine(m.text) })
    else if (m.kind === 'question' || (m.options?.length && m.kind !== 'permission')) out.push({ ...at, kind: 'question', text: firstLine(m.question?.text || m.text) })
    else if (m.kind === 'permission') out.push({ ...at, kind: 'permission', text: m.permission?.tool || firstLine(m.text) })
    else if (m.kind === 'tool' && m.tool && m.tool.status !== 'error') {
      const input = m.tool.input as { command?: unknown } | null
      const cmd = typeof input?.command === 'string' ? input.command : ''
      if (GIT_CMD.test(cmd)) out.push({ ...at, kind: 'git', text: firstLine(cmd) })
      else if (PR_TOOL.test(m.tool.name)) out.push({ ...at, kind: 'git', text: m.tool.name })
    }
  }
  for (const s of kids) {
    out.push({ key: `start-${s.id}`, at: s.createdAt, kind: 'sub-start', text: s.title, sessionId: s.id })
    const end = s.report?.at ?? (s.status !== 'running' ? s.finishedAt : null)
    if (end) out.push({ key: `end-${s.id}`, at: end, kind: 'sub-end', text: s.title, sessionId: s.id })
  }
  return out.sort((a, b) => a.at - b.at)
}

// ---------- the running-agents dock above the composer ----------

export interface DockRow { s: Session; indent: number }

/** A chat that is doing something or waits for a person: it stays in the dock's main list. */
export const isLive = (s: Pick<Session, 'status' | 'waitingFor'>) => s.status === 'running' || !!s.waitingFor

/**
 * The dock of chat `id`: its live descendants (indented under a live parent, flat under a finished one) and the finished
 * ones for «История», newest first.
 */
export function dockRows(sessions: Session[], id: string): { live: DockRow[]; done: Session[] } {
  const live: DockRow[] = []
  const done: Session[] = []
  const indent = new Map<string, number>()
  for (const { s } of descendants(sessions, id)) {
    if (!isLive(s)) { done.push(s); continue }
    const up = s.parentId ? indent.get(s.parentId) : undefined
    indent.set(s.id, up === undefined ? 0 : up + 1)
    live.push({ s, indent: indent.get(s.id)! })
  }
  const end = (s: Session) => s.finishedAt ?? s.lastActivityAt
  return { live, done: done.sort((a, b) => end(b) - end(a)) }
}

// the CLIs' shell tools (toolRun.ts KIND 'shell', plus «execute»); toolRun is not imported so this file stays pure
const SHELL = /^(run_shell_command|bash|shell|exec_command|execute)$/i

export interface ShellRun { id: string; command: string; at: number; background: boolean }

/**
 * Shell commands a running agent has going right now: calls still running, and background ones started in its current
 * turn. shortcut: the CLI does not report when a background command ends, so it is listed until the turn ends.
 */
export function runningShells(list: Message[]): ShellRun[] {
  const out: ShellRun[] = []
  const turn = list[list.length - 1]?.turn
  for (let i = Math.max(0, list.length - 80); i < list.length; i++) {
    const t = list[i].tool
    if (list[i].kind !== 'tool' || !t || !SHELL.test(t.name)) continue
    const input = (t.input ?? {}) as { command?: unknown; is_background?: unknown; run_in_background?: unknown }
    const background = input.is_background === true || input.run_in_background === true
    if (t.status !== 'running' && !(background && t.status === 'ok' && list[i].turn === turn)) continue
    out.push({ id: list[i].id, command: typeof input.command === 'string' ? firstLine(input.command) : t.name, at: list[i].at, background })
  }
  return out
}

/** 39 с · 11 мин 39 с · 2 ч 05 мин: a running clock, finer than sessionState's dur(). */
export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин ${String(s % 60).padStart(2, '0')} с`
  return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`
}
