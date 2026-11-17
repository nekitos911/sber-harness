import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, Check, LoaderCircle, MessageSquare, X } from 'lucide-react'
import { openSession } from '../../store'
import type { ToolCall } from '../../types'
import { Markdown } from '../Markdown'
import { Disclosure } from '../ui'

type Obj = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** GigaCode's built-in `agent`/`fork` tool (claude: Task): a sub-agent run inside this call. */
export function isSubagentTool(tool: ToolCall) {
  const input = (tool.input ?? {}) as Obj
  return /^(agent|fork|task)$/i.test(tool.name) || typeof input.subagent_type === 'string'
}

/**
 * A built-in sub-agent (e.g. /full-task's reviewer): who it is, what it was asked, its live activity
 * (tool.progress, auto-scrolled while running) and its final answer as markdown. Open while running,
 * folds away once finished.
 */
export function SubagentCard({ tool }: { tool: ToolCall }) {
  const input = (tool.input ?? {}) as Obj
  const type = str(input.subagent_type) || str(input.description) || 'агент'
  const model = str(input.model) || str(input.grade)
  const ask = str(input.prompt) || str(input.description)
  const running = tool.status === 'running'
  const [open, setOpen] = useState(running)
  const feed = useRef<HTMLPreElement>(null)
  const progress = tool.progress ?? []

  useEffect(() => { setOpen(running) }, [running]) // expands for a live run, folds when it ends
  useLayoutEffect(() => {
    const el = feed.current
    if (el && running) el.scrollTop = el.scrollHeight
  }, [progress.length, running])

  return (
    <Disclosure
      className="msg tool tool-agent"
      open={open}
      onToggle={setOpen}
      chevron="end"
      actions={tool.subSessionId ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSession(tool.subSessionId!)}>
          <MessageSquare />Открыть чат субагента
        </button>
      ) : undefined}
      summary={<>
        {running ? <LoaderCircle className="tool-st spinner" data-s="running" aria-label="работает" />
          : tool.status === 'error' ? <X className="tool-st" data-s="error" aria-label="ошибка" />
            : <Check className="tool-st" data-s="ok" aria-label="готово" />}
        <Bot className="agent-ico" aria-hidden />
        <span className="agent-kind">Субагент <strong>{type}</strong></span>
        {model && <span className="mono muted">{model}</span>}
        <span className="tool-sum ellipsis">{ask.split('\n').find((l) => l.trim()) ?? ''}</span>
      </>}
    >
      <div className="agent-body">
        {progress.length > 0 && (
          <pre ref={feed} className="agent-feed" aria-live={running ? 'polite' : undefined}>{progress.join('\n')}</pre>
        )}
        {running && !progress.length && <p className="muted agent-wait">Субагент запущен, ждём первых шагов…</p>}
        {tool.output && (
          <div className="agent-result" data-error={tool.status === 'error' || undefined}>
            <div className="tool-label">Результат</div>
            <Markdown text={tool.output} />
          </div>
        )}
      </div>
    </Disclosure>
  )
}
