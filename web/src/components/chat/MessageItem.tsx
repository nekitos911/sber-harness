import { memo, useState, type MouseEvent } from 'react'
import { Check, ChevronRight, Copy, LoaderCircle, X } from 'lucide-react'
import { openSession, useStore } from '../../store'
import { basename, fullTime } from '../../lib/format'
import { fileEdit, summarizeInput, type FileEdit } from '../../lib/toolcall'
import type { Message, ToolCall } from '../../types'
import { Markdown } from '../Markdown'

export const MessageItem = memo(function MessageItem({ m }: { m: Message }) {
  switch (m.kind) {
    case 'user': return <UserMessage m={m} />
    case 'assistant': return <div className="msg msg-assistant"><Markdown text={m.text} /></div>
    case 'thought': return <Thought text={m.text} />
    case 'tool': return m.tool ? <ToolCard tool={m.tool} /> : null
    case 'error': return <div className="msg msg-error" role="alert">{m.text}</div>
    case 'system': return <div className="msg msg-system"><Markdown text={m.text} /></div>
  }
})

function UserMessage({ m }: { m: Message }) {
  const sender = useStore((s) => (m.from && m.from !== 'user' ? s.sessions.find((x) => x.id === m.from) : undefined))
  const fromOther = m.from && m.from !== 'user'
  return (
    <div className="msg msg-user" title={fullTime(m.at)}>
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
    <details className="msg msg-thought">
      <summary>
        <ChevronRight className="chev" aria-hidden />
        Размышления
        <span className="ellipsis">{first}</span>
      </summary>
      <Markdown text={text} />
    </details>
  )
}

const OUTPUT_LIMIT = 20_000

function ToolCard({ tool }: { tool: ToolCall }) {
  const edit = fileEdit(tool.input)
  if (edit) return <EditBlock tool={tool} edit={edit} />
  return <GenericTool tool={tool} />
}

function ToolStatus({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') return <LoaderCircle className="tool-st spinner" data-s="running" aria-label="выполняется" />
  if (status === 'error') return <X className="tool-st" data-s="error" aria-label="ошибка" />
  return <Check className="tool-st" data-s="ok" aria-label="готово" />
}

function GenericTool({ tool }: { tool: ToolCall }) {
  const [full, setFull] = useState(false)
  const out = tool.output ?? ''
  return (
    <details className="msg tool" data-s={tool.status}>
      <summary>
        <ChevronRight className="chev" aria-hidden />
        <ToolStatus status={tool.status} />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-sum ellipsis">{summarizeInput(tool.input)}</span>
      </summary>
      <div className="tool-body">
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
    </details>
  )
}

function EditBlock({ tool, edit }: { tool: ToolCall; edit: FileEdit }) {
  const [copied, setCopied] = useState(false)
  const copy = async (e: MouseEvent) => {
    e.preventDefault()
    try {
      await navigator.clipboard.writeText(edit.lines.filter((l) => l.kind !== '-').map((l) => l.text).join('\n'))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard blocked */ }
  }
  return (
    <details className="msg tool tool-edit" data-s={tool.status} open={edit.lines.length <= 40}>
      <summary>
        <ChevronRight className="chev" aria-hidden />
        <ToolStatus status={tool.status} />
        <span>{edit.created ? 'Записан' : 'Изменён'}</span>
        <span className="tool-name ellipsis" title={edit.file}>{basename(edit.file)}</span>
        <span className="diff-stat num"><span className="add">+{edit.added}</span> <span className="del">−{edit.removed}</span></span>
        <span className="grow" />
        <button type="button" className="icon-btn icon-btn-sm" onClick={copy} aria-label={copied ? 'Скопировано' : 'Копировать новый текст'}>
          {copied ? <Check /> : <Copy />}
        </button>
      </summary>
      <div className="edit-lines">
        {edit.lines.slice(0, 400).map((l, i) => (
          <div key={i} className="dl" data-k={l.kind}><span className="dl-sign">{l.kind}</span>{l.text || ' '}</div>
        ))}
        {edit.lines.length > 400 && <div className="dl muted">… ещё {edit.lines.length - 400} строк</div>}
      </div>
      {tool.status === 'error' && tool.output && <pre className="tool-err">{tool.output.slice(0, OUTPUT_LIMIT)}</pre>}
    </details>
  )
}
