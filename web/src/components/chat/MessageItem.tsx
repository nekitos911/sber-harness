import { memo, useState, type MouseEvent } from 'react'
import { Check, Copy, ExternalLink, FileText, FolderOpen, GitCompare, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { tryApi } from '../../api'
import { openSession, openTab, useFeature, useStore } from '../../store'
import { openFile } from '../WorktreeMenu'
import { basename, fullTime, normPath } from '../../lib/format'
import { emptyInput, fileEdit, summarizeInput, type FileEdit } from '../../lib/toolcall'
import { parseDiff, type DiffFile, type DiffLine } from '../../lib/diff'
import type { Message, ToolCall } from '../../types'
import { Markdown } from '../Markdown'
import { DiffLines } from '../DiffLines'
import { Disclosure, IconButton } from '../ui'
import { isSubagentTool, SubagentCard } from './SubagentCard'
import { ThoughtBlock, Thumb } from './ToolSteps'
import { isImagePath, splitAttachments } from '../../lib/attachments'
import { toolKind } from '../../lib/toolRun'
import { AskToolCard, isAskCard, MessageQuestion, PermissionCard } from './Attention'

/** `until`: for a thought, when it ended (null = still thinking); the thought shows how long it took. */
export const MessageItem = memo(function MessageItem({ m, fresh = false, until, count }: { m: Message; fresh?: boolean; until?: number | null; count?: number }) {
  // An `ask` with options (from this agent or a worker) is a question card like the CLI's own question tool.
  const body = m.kind === 'thought' ? <ThoughtBlock m={m} until={until === undefined ? m.at : until} />
    : m.options?.length && m.kind !== 'permission' ? <MessageQuestion m={m} />
      : m.kind === 'system' ? <><SystemNote text={m.text} count={count} />{m.link && <LinkButton href={m.link} />}</>
        : <MessageBody m={m} />
  // Messages that arrive while the chat is open fade in; the loaded history does not replay.
  return (
    <div className="msg-wrap" data-kind={m.kind} data-enter={fresh || undefined}>
      {body}
    </div>
  )
})

function MessageBody({ m }: { m: Message }) {
  switch (m.kind) {
    case 'user': return <UserMessage m={m} />
    case 'assistant': return <div className="msg msg-assistant"><Markdown text={m.text} /></div>
    case 'thought': return <ThoughtBlock m={m} until={m.at} />
    case 'tool': return m.tool ? <ToolCard tool={m.tool} sessionId={m.sessionId} m={m} /> : null
    case 'error': return m.action === 'pick-model' ? <PickModelError m={m} /> : <div className="msg msg-error" role="alert">{m.text}{m.link && <LinkButton href={m.link} />}</div>
    case 'system': return <>{<SystemNote text={m.text} />}{m.link && <LinkButton href={m.link} />}</>
    case 'question': return <MessageQuestion m={m} />
    case 'permission': return m.permission ? <PermissionCard m={m} /> : <SystemNote text={m.text} />
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

/** An attached file: a click opens it in its program; the folder button shows where it lies. */
function FileChip({ path, n }: { path: string; n: number }) {
  const can = useFeature('open-file')
  if (!can) return <span className="chip" data-tip={path}><FileText aria-hidden />{basename(path)}</span>
  return (
    <span className="chip file-chip">
      <button type="button" className="file-chip-open" data-tip={`Открыть: ${path}`} onClick={() => openFile(path)}><FileText aria-hidden /><span className="muted num">#{n}</span> {basename(path).replace(/^\d{8}-\d{6}-/, '')}</button>
      <button type="button" className="file-chip-dir" aria-label={`Показать ${basename(path)} в папке`} data-tip="Показать в папке" onClick={() => openFile(path, 'reveal')}><FolderOpen aria-hidden /></button>
    </span>
  )
}

function UserMessage({ m }: { m: Message }) {
  const sender = useStore((s) => (m.from && m.from !== 'user' ? s.sessions.find((x) => x.id === m.from) : undefined))
  const fromOther = m.from && m.from !== 'user'
  const cwd = useStore((s) => s.sessions.find((x) => x.id === m.sessionId)?.cwd ?? '')
  const { text, paths } = splitAttachments(m.text)
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
      {paths.length > 0 && (
        <div className="msg-atts" aria-label="Вложения">
          {paths.map((p) => (isImagePath(p) && cwd
            ? <Thumb key={p} cwd={cwd} path={p} />
            : <FileChip key={p} path={p} n={paths.indexOf(p) + 1} />))}
        </div>
      )}
      {text && <Markdown text={text} />}
    </div>
  )
}

/** System lines: "⚠ …" is a warning (amber, not an error); "MCP: a ✓, b ✗" is a compact status line. */
function SystemNote({ text, count }: { text: string; count?: number }) {
  const t = text.trim()
  if (t.startsWith('⚠')) {
    return (
      <div className="msg msg-warn" role="note">
        <TriangleAlert aria-hidden />
        <span>{t.replace(/^⚠️?\s*/, '')}{count && count > 1 && <span className="warn-count num"> ×{count}</span>}</span>
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

/**
 * A unified diff printed by an edit tool itself (e.g. an apply_patch result). Never a command's output: `git show` /
 * `git diff` of an old commit (the agent reading history) drawn as «Создан …» looked like the agent changing files.
 */
function outputDiff(tool: ToolCall): DiffFile | null {
  const out = tool.output
  if (toolKind(tool.name) !== 'edit') return null
  if (!out || !/^@@ -\d/m.test(out) || !/^(\+\+\+|---) /m.test(out)) return null
  const [f] = parseDiff(out)
  return f && f.lines.length ? f : null
}

const editLines = (e: FileEdit): DiffLine[] =>
  e.lines.map((l) => ({ kind: l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx', text: l.text, old: null, new: null }))

function ToolCard({ tool, sessionId, m }: { tool: ToolCall; sessionId: string; m?: Message }) {
  if (isSubagentTool(tool)) return <SubagentCard tool={tool} />
  if (isAskCard(tool) && m) return <AskToolCard m={m} />
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
        {emptyInput(tool.input)
          ? <p className="muted tool-noinput">{tool.status === 'running' ? 'аргументы ещё не пришли' : 'без аргументов'}</p>
          : <pre>{typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)}</pre>}
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

export function LinkButton({ href, label = 'Открыть ссылку' }: { href: string; label?: string }) {
  return <a className="btn btn-sm link-btn-out" href={href} target="_blank" rel="noreferrer noopener" data-tip={href}><ExternalLink />{label}</a>
}

/** The chosen model is not in the backend catalogue: pick another (opens the composer picker) or retry. */
function PickModelError({ m }: { m: Message }) {
  const lastUser = useStore((s) => [...(s.messages[m.sessionId] ?? [])].reverse().find((x) => x.kind === 'user' && (!x.from || x.from === 'user'))?.text)
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    if (!lastUser) return
    setBusy(true)
    await tryApi('POST', `/sessions/${encodeURIComponent(m.sessionId)}/messages`, { text: lastUser })
    setBusy(false)
  }
  return (
    <div className="msg msg-error error-card" role="alert">
      <span>{m.text}</span>
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('harness:pick-model', { detail: m.sessionId }))}>Выбрать другую модель</button>
        <button type="button" className="btn btn-sm" disabled={!lastUser || busy} onClick={() => void retry()}>{busy ? 'Отправляем…' : 'Повторить'}</button>
      </div>
    </div>
  )
}
