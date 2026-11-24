import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, Check, LoaderCircle, MessageSquare, Radio, X } from 'lucide-react'
import { openSession, useStore } from '../../store'
import type { ToolCall } from '../../types'
import { Markdown } from '../Markdown'
import { Disclosure } from '../ui'
import { backgroundRun } from '../../lib/toolRun'
import { relTime } from '../../lib/format'

type Obj = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** GigaCode's built-in `agent`/`fork` tool (claude: Task): a sub-agent run inside this call. Harness's own
 *  `mcp__harness__agent` is the same thing over MCP — its call has a chat of its own, so no card here. */
export function isSubagentTool(tool: ToolCall) {
  const input = (tool.input ?? {}) as Obj
  // by name first: ACP sends the arguments late (or never), and a call must not switch from a step line to a card midway
  return /^(agent|fork|task)$/i.test(tool.name) || /^(mcp__harness__|harness\.)(agent|worker_run)$/.test(tool.name) || typeof input.subagent_type === 'string'
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
  // run_in_background: the call answers at once while the sub-agent works outside this stream — its own output file
  // settles it, and the chat of the sub-agent gets that answer (sessions.js, watchBackground)
  const bg = backgroundRun(tool.output)
  const background = input.run_in_background === true || !!bg
  // the chat of this sub-agent says whether the work goes on: running past the parent's turn means it is still at work
  const chat = useStore((s) => (tool.subSessionId ? s.sessions.find((x) => x.id === tool.subSessionId) : undefined))
  const stillRunning = chat ? chat.status === 'running' : !!tool.stillRunning
  const running = tool.status === 'running' || (background && stillRunning)
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
          : tool.status === 'error' && !chat ? <X className="tool-st" data-s="error" aria-label="ошибка" />
            : background ? <Radio className="tool-st" data-s="bg" aria-label="работал в фоне" />
              : <Check className="tool-st" data-s="ok" aria-label="готово" />}
        <Bot className="agent-ico" aria-hidden />
        <span className="agent-kind">Субагент <strong>{type}</strong>{background && <span className="muted"> · {running ? 'в фоне' : 'работал в фоне'}</span>}</span>
        {model && <span className="mono muted">{model}</span>}
        <span className="tool-sum ellipsis">{ask.split('\n').find((l) => l.trim()) ?? ''}</span>
        {background && chat && <span className="agent-live mono muted" data-tip="его шаги — в чате субагента">
          {chat.status === 'running' ? 'работает' : `закончил · ${relTime(chat.lastActivityAt, Date.now())}`}
        </span>}
      </>}
    >
      <div className="agent-body">
        {background && /harness/.test(tool.name) && <p className="muted agent-bg-note">Работает в фоне отдельным чатом («Открыть чат субагента»). Его результат придёт главному агенту сообщением, а пока главному агенту можно писать.</p>}
        {background && !/harness/.test(tool.name) && <p className="muted agent-bg-note">Запущен в фоне встроенным инструментом GigaCode: ход субагента идёт вне этого потока, его шаги CLI пишет только в свой файл{chat ? ' — ответ появится в чате субагента' : ''}. Харнес прочитает результат, когда субагент закончит.{bg?.outputFile && <> Его вывод пишется в <span className="mono">{bg.outputFile}</span>.</>}</p>}
        {progress.length > 0 && (
          <pre ref={feed} className="agent-feed" aria-live={running ? 'polite' : undefined}>{progress.join('\n')}</pre>
        )}
        {running && !progress.length && <p className="muted agent-wait">{/harness/.test(tool.name) ? 'Работает отдельным чатом: его шаги — в «Открыть чат субагента».' : background ? 'Работает в фоне: его шаги — в «Открыть чат субагента», строки о своей работе CLI в этот поток не пишет.' : 'Субагент запущен, ждём первых шагов…'}</p>}
        {tool.output && (
          <div className="agent-result" data-error={tool.status === 'error' && !chat || undefined}>
            <div className="tool-label">{bg ? 'Ответ субагента' : 'Результат'}</div>
            <Markdown text={tool.output} />
          </div>
        )}
      </div>
    </Disclosure>
  )
}
