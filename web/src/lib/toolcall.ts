// Helpers to present agent tool calls compactly. Tool names differ per CLI
// (claude: Edit/MultiEdit/Write, gemini-family: replace/write_file), so we look at input shape.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'absolute_path', 'pattern', 'query', 'url', 'description', 'prompt', 'body', 'title']

/** One line describing what the tool was asked to do. */
export function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return input.split('\n')[0]
  if (!isObj(input)) return ''
  for (const k of SUMMARY_KEYS) {
    const v = str(input[k])
    if (v) return v.split('\n')[0]
  }
  const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined
  if (first) return first.split('\n')[0]
  return Object.keys(input).length ? JSON.stringify(input).slice(0, 160) : '' // {}: the arguments have not come yet
}

/** No arguments to show: null or {} (over ACP a call is announced before its arguments are written). */
export const emptyInput = (v: unknown) => v == null || (isObj(v) && !Object.keys(v).length)

export interface EditLine { kind: ' ' | '+' | '-'; text: string }
export interface FileEdit { file: string; created: boolean; lines: EditLine[]; added: number; removed: number }

function hunk(oldText: string, newText: string): EditLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const ctx = 2
  return [
    ...a.slice(Math.max(0, start - ctx), start).map((text) => ({ kind: ' ' as const, text })),
    ...a.slice(start, endA).map((text) => ({ kind: '-' as const, text })),
    ...b.slice(start, endB).map((text) => ({ kind: '+' as const, text })),
    ...a.slice(endA, endA + ctx).map((text) => ({ kind: ' ' as const, text })),
  ]
}

/** If the tool call edits or writes a file, return a small line diff of it. */
export function fileEdit(input: unknown): FileEdit | null {
  if (!isObj(input)) return null
  const file = str(input.file_path) ?? str(input.path) ?? str(input.absolute_path)
  if (!file) return null
  let lines: EditLine[] | null = null
  let created = false
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    lines = hunk(input.old_string, input.new_string)
  } else if (Array.isArray(input.edits)) {
    lines = input.edits.flatMap((e) => (isObj(e) && typeof e.old_string === 'string' && typeof e.new_string === 'string' ? hunk(e.old_string, e.new_string) : []))
  } else if (typeof input.content === 'string') {
    created = true
    lines = input.content.split('\n').map((text) => ({ kind: '+' as const, text }))
  }
  if (!lines) return null
  return {
    file, created, lines,
    added: lines.filter((l) => l.kind === '+').length,
    removed: lines.filter((l) => l.kind === '-').length,
  }
}

/** The body of an agent's send_message to the person (to: «user»), else null. */
export function toPerson(tool: { name: string; input?: unknown; status?: string }): string | null {
  if (!/(^|__|\.)send_message$/.test(tool.name) || tool.status === 'error') return null
  const input = (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Record<string, unknown>
  return input.to === 'user' && typeof input.body === 'string' && input.body.trim() ? input.body : null
}
