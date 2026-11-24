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

/** The message that started the chat. */
export const firstTask = (list: Message[]): Message | null => list.find((m) => m.kind === 'user') ?? null

/** One line of the task: «/full-task KEY · title» for a command with a bound task, else the first line. */
export function taskHead(text: string, task?: { key: string; title: string } | null): string {
  const line = firstLine(taskText(text))
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
      out.push({ ...at, kind, text: firstLine(taskText(m.text)), from: m.from })
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
