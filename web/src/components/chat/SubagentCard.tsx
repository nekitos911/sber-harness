import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, Check, LoaderCircle, MessageSquare, Radio, X } from 'lucide-react'
import { openSession, useStore } from '../../store'
import { ensureMessages } from '../../ws'
import { childOfCall } from '../../lib/overview'
import type { ToolCall } from '../../types'
import { Markdown } from '../Markdown'
import { Disclosure } from '../ui'
import { backgroundRun } from '../../lib/toolRun'
import { relTime } from '../../lib/format'
import { summarizeInput } from '../../lib/toolcall'

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
export function SubagentCard({ tool, sessionId, at }: { tool: ToolCall; sessionId?: string; at?: number }) {
  const input = (tool.input ?? {}) as Obj
  // a harness call without subSessionId: its chat is found by the id in its output, else by its prompt among the children
  const lookup = !tool.subSessionId && !!sessionId && /^(mcp__harness__|harness\.)(agent|worker_run)$/.test(tool.name)
  const call = { at: at ?? 0, prompt: str(input.prompt) || str(input.spec), output: tool.output } // worker_run asks by «spec»
  const found = useStore((s) => (lookup ? childOfCall(call, s.sessions.filter((x) => x.parentId === sessionId)
    .map((x) => ({ id: x.id, createdAt: x.createdAt, first: s.messages[x.id]?.find((m) => m.kind === 'user')?.text }))) : null))
  // the children started after the call: their first messages are read to match the prompt
  const unread = useStore((s) => (lookup && !found ? s.sessions.filter((x) => x.parentId === sessionId && x.createdAt >= call.at - 2000 && !s.messages[x.id]).map((x) => x.id).join(' ') : ''))
  useEffect(() => { for (const id of unread.split(' ').filter(Boolean)) ensureMessages(id) }, [unread])
  const subId = tool.subSessionId ?? found
  const type = str(input.subagent_type) || str(input.profile) || str(input.description)
  const modelAsked = str(input.model) || str(input.grade)
  const ask = str(input.prompt) || str(input.spec) || str(input.description)
  // run_in_background: the call answers at once while the sub-agent works outside this stream — its own output file
  // settles it, and the chat of the sub-agent gets that answer (sessions.js, watchBackground)
  const bg = backgroundRun(tool.output)
  const background = input.run_in_background === true || !!bg
  // the chat of this sub-agent says whether the work goes on: running past the parent's turn means it is still at work
  const chat = useStore((s) => (subId ? s.sessions.find((x) => x.id === subId) : undefined))
  const stillRunning = chat ? chat.status === 'running' : !!tool.stillRunning
  // not named in the call: the sub-agent chat knows it (its agent file's model)
  const model = modelAsked || chat?.model || null
  const running = tool.status === 'running' || (background && stillRunning)
  const [open, setOpen] = useState(running)
  const feed = useRef<HTMLPreElement>(null)
  // the sub-agent's own chat, read here: its latest steps under this card — the parent's chat shows the work without
  // opening the other one (its whole history stays a click away)
  useEffect(() => { if (open && subId) ensureMessages(subId) }, [open, subId])
  const childSteps = useStore((s) => (subId ? (s.messages[subId] ?? []).filter((x) => x.kind === 'tool' || x.kind === 'assistant').slice(-8)
    .map((x) => (x.kind === 'tool' ? `› ${x.tool?.name ?? x.text} ${summarizeInput(x.tool?.input)}`.trim() : x.text.split('\n').find((l) => l.trim()) ?? ''))
    .map((l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l)).join('\n') : ''))
  const progress = tool.progress?.length ? tool.progress : childSteps ? childSteps.split('\n') : []

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
      actions={subId ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSession(subId)}>
          <MessageSquare />Открыть чат субагента
        </button>
      ) : undefined}
      summary={<>
        {running ? <LoaderCircle className="tool-st spinner" data-s="running" aria-label="работает" />
          : tool.status === 'error' && !chat ? <X className="tool-st" data-s="error" aria-label="ошибка" />
            : background ? <Radio className="tool-st" data-s="bg" aria-label="работал в фоне" />
              : <Check className="tool-st" data-s="ok" aria-label="готово" />}
        <Bot className="agent-ico" aria-hidden />
        <span className="agent-kind">Субагент{type && <> <strong>{type}</strong></>}{background && <span className="muted"> · {running ? 'в фоне' : 'работал в фоне'}</span>}</span>
        {model && <span className="mono muted">{model}</span>}
        <span className="tool-sum ellipsis">{ask.split('\n').find((l) => l.trim()) ?? ''}</span>
        {(background || found) && chat && <span className="agent-live mono muted" data-tip="Его шаги видны в чате субагента">
          {chat.status === 'running' ? 'работает' : `закончил · ${relTime(chat.lastActivityAt, Date.now())}`}
        </span>}
      </>}
    >
      <div className="agent-body">
        {background && running && <p className="muted agent-bg-note">Работает в фоне. Последние шаги — ниже; когда закончит, его ответ придёт главному агенту сообщением, и тот продолжит.</p>}
        {progress.length > 0 && (
          <pre ref={feed} className="agent-feed" aria-live={running ? 'polite' : undefined}>{progress.join('\n')}</pre>
        )}
        {running && !progress.length && <p className="muted agent-wait">Субагент запущен, ждём первых шагов…</p>}
        {tool.output && !bg && (
          <div className="agent-result" data-error={tool.status === 'error' && !chat || undefined}>
            <div className="tool-label">Ответ субагента</div>
            <Markdown text={tool.output} />
          </div>
        )}
      </div>
    </Disclosure>
  )
}
