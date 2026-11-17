import { memo, useState, type MouseEvent } from 'react'
import { Check, Copy, GitCompare, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { tryApi } from '../../api'
import { openSession, openTab, useStore } from '../../store'
import { basename, fullTime, normPath } from '../../lib/format'
import { fileEdit, summarizeInput, type FileEdit } from '../../lib/toolcall'
import { parseDiff, type DiffFile, type DiffLine } from '../../lib/diff'
import type { Message, ToolCall } from '../../types'
import { Markdown } from '../Markdown'
import { DiffLines } from '../DiffLines'
import { Disclosure, IconButton } from '../ui'

export const MessageItem = memo(function MessageItem({ m, fresh = false }: { m: Message; fresh?: boolean }) {
  const body = <MessageBody m={m} />
  // Messages that arrive while the chat is open fade in; the loaded history does not replay.
  return (
    <div className="msg-wrap" data-kind={m.kind} data-enter={fresh || undefined}>
      {body}
      {/* `ask` from a worker arrives here with from = worker id: the click answers that worker. */}
      {!!m.options?.length && <ReplyOptions options={m.options} to={m.from && m.from !== 'user' ? m.from : m.sessionId} />}
    </div>
  )
})

function MessageBody({ m }: { m: Message }) {
  switch (m.kind) {
    case 'user': return <UserMessage m={m} />
    case 'assistant': return <div className="msg msg-assistant"><Markdown text={m.text} /></div>
    case 'thought': return <Thought text={m.text} />
    case 'tool': return m.tool ? <ToolCard tool={m.tool} sessionId={m.sessionId} /> : null
    case 'error': return <div className="msg msg-error" role="alert">{m.text}</div>
    case 'system': return <SystemNote text={m.text} />
  }
}

/** One-click answers for an `ask` with options; the chosen text is sent as the reply. */
export function ReplyOptions({ options, to, onSent }: { options: string[]; to: string; onSent?: () => void }) {
  const [sent, setSent] = useState<string | null>(null)
  const pick = async (o: string) => {
    setSent(o)
    const res = await tryApi<{ queued: boolean }>('POST', `/sessions/${encodeURIComponent(to)}/messages`, { text: o })
    if (!res) { setSent(null); return }
    onSent?.()
  }
  return (
    <div className="reply-options" role="group" aria-label="Варианты ответа">
      {options.map((o) => (
        <button key={o} type="button" className="btn btn-sm" aria-pressed={sent === o} disabled={sent !== null} onClick={() => void pick(o)}>
          {sent === o && <Check />}
          {o}
        </button>
      ))}
    </div>
  )
}

function UserMessage({ m }: { m: Message }) {
  const sender = useStore((s) => (m.from && m.from !== 'user' ? s.sessions.find((x) => x.id === m.from) : undefined))
  const fromOther = m.from && m.from !== 'user'
  return (
    <div className="msg msg-user" data-tip={fullTime(m.at)}>
      {fromOther && (
        <div className="msg-from">
          от{' '}
          {sender
            ? <button type="button" className="chip" onClick={() => openSession(sender.id)}>{sender.title}</button>
            : <span className="chip chip-mono">{m.from}</span>}
        </div>
      )}
      <Markdown text={m.text} />
    </div>
  )
}

function Thought({ text }: { text: string }) {
  const first = text.trim().split('\n')[0]
  return (
    <Disclosure className="msg msg-thought" summary={<>Размышления <span className="ellipsis">{first}</span></>}>
      <Markdown text={text} />
    </Disclosure>
  )
}

/** System lines: "⚠ …" is a warning (amber, not an error); "MCP: a ✓, b ✗" is a compact status line. */
function SystemNote({ text }: { text: string }) {
  const t = text.trim()
  if (t.startsWith('⚠')) {
    return (
      <div className="msg msg-warn" role="note">
        <TriangleAlert aria-hidden />
        <span>{t.replace(/^⚠️?\s*/, '')}</span>
      </div>
    )
  }
  const mcp = /^MCP:\s*(.+)$/.exec(t)
  if (mcp && !t.includes('\n')) {
    const items = mcp[1].split(',').map((x) => x.trim()).filter(Boolean)
    return (
      <div className="msg msg-mcp" aria-label="Состояние MCP-серверов">
        <span className="muted">MCP</span>
        {items.map((x) => {
          const bad = /✗|×|fail/i.test(x)
          return (
            <span key={x} className="mcp-item" data-bad={bad || undefined} data-tip={bad ? 'не запустился' : 'работает'}>
              {bad ? <X aria-hidden /> : <Check aria-hidden />}
              {x.replace(/\s*[✓✔✗×]\s*$/, '')}
            </span>
          )
        })}
      </div>
    )
  }
  return <div className="msg msg-system"><Markdown text={text} /></div>
}

const OUTPUT_LIMIT = 20_000

/** A unified diff printed by the tool itself (e.g. an apply_patch result). */
function outputDiff(tool: ToolCall): DiffFile | null {
  const out = tool.output
  if (!out || !/^@@ -\d/m.test(out) || !/^(\+\+\+|---) /m.test(out)) return null
  const [f] = parseDiff(out)
  return f && f.lines.length ? f : null
}

const editLines = (e: FileEdit): DiffLine[] =>
  e.lines.map((l) => ({ kind: l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx', text: l.text, old: null, new: null }))

function ToolCard({ tool, sessionId }: { tool: ToolCall; sessionId: string }) {
  const edit = fileEdit(tool.input)
  if (edit) return <EditBlock tool={tool} sessionId={sessionId} file={edit.file} created={edit.created} added={edit.added} removed={edit.removed} lines={editLines(edit)} />
  const out = outputDiff(tool)
  if (out) return <EditBlock tool={tool} sessionId={sessionId} file={out.path} created={out.status === 'added'} added={out.added} removed={out.removed} lines={out.lines} />
  return <GenericTool tool={tool} />
}

function ToolStatus({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') return <LoaderCircle className="tool-st spinner" data-s="running" aria-label="выполняется" />
  if (status === 'error') return <X className="tool-st" data-s="error" aria-label="ошибка" />
  return <Check className="tool-st" data-s="ok" aria-label="готово" />
}

/** Any other tool: one muted line (name and what it was asked), details on demand. */
function GenericTool({ tool }: { tool: ToolCall }) {
  const [full, setFull] = useState(false)
  const out = tool.output ?? ''
  return (
    <Disclosure
      className="msg tool"
      chevron="end"
      summary={<>
        <ToolStatus status={tool.status} />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-sum ellipsis">{summarizeInput(tool.input)}</span>
      </>}
    >
      <div className="tool-body" data-s={tool.status}>
        <div className="tool-label">Вход</div>
        <pre>{typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)}</pre>
        {tool.output !== null && (
          <>
            <div className="tool-label">Результат</div>
            <pre data-error={tool.status === 'error'}>{full ? out : out.slice(0, OUTPUT_LIMIT)}</pre>
            {!full && out.length > OUTPUT_LIMIT && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFull(true)}>
                Показать полностью ({Math.round(out.length / 1024)} КБ)
              </button>
            )}
          </>
        )}
      </div>
    </Disclosure>
  )
}

/** Path of a file inside the session folder (for the diff tab); null when the tool wrote outside it. */
function relativeTo(cwd: string, file: string): string | null {
  const f = file.replace(/\\/g, '/')
  if (!/^([a-zA-Z]:\/|\/)/.test(f)) return f
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return normPath(f).startsWith(`${normPath(root)}/`) ? f.slice(root.length + 1) : null
}

interface EditProps { tool: ToolCall; sessionId: string; file: string; created: boolean; added: number; removed: number; lines: DiffLine[] }

/** A file edit as a compact diff block: «Изменён file +a −b», expand, copy, open the file's diff in the worktree. */
function EditBlock({ tool, sessionId, file, created, added, removed, lines }: EditProps) {
  const cwd = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.cwd)
  const [copied, setCopied] = useState(false)
  const copy = async (e: MouseEvent) => {
    e.preventDefault()
    try {
      await navigator.clipboard.writeText(lines.filter((l) => l.kind === 'add' || l.kind === 'ctx').map((l) => l.text).join('\n'))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard blocked */ }
  }
  const rel = cwd ? relativeTo(cwd, file) : null
  const openDiff = (e: MouseEvent) => {
    e.preventDefault()
    if (cwd && rel) openTab({ kind: 'diff', cwd, path: rel })
  }
  return (
    <Disclosure
      className="msg tool tool-edit"
      defaultOpen={lines.length <= 16}
      chevron="end"
      summary={<>
        <ToolStatus status={tool.status} />
        <span className="tool-verb">{created ? 'Создан' : 'Изменён'}</span>
        <span className="tool-file ellipsis" data-tip={file}>{basename(file)}</span>
        <span className="diff-stat num"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
      </>}
      actions={<>
        {rel && <IconButton size="sm" label={`Открыть diff ${basename(file)}`} icon={<GitCompare />} onClick={openDiff} />}
        <IconButton size="sm" label={copied ? 'Скопировано' : 'Копировать новый текст'} icon={copied ? <Check /> : <Copy />} onClick={copy} />
      </>}
    >
      <DiffLines lines={lines} numbers={lines.some((l) => l.new !== null)} limit={400} label={`Изменения ${basename(file)}`} />
      {tool.status === 'error' && tool.output && <pre className="tool-err">{tool.output.slice(0, OUTPUT_LIMIT)}</pre>}
    </Disclosure>
  )
}
