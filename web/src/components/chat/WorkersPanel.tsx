import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ChevronDown, SquareTerminal } from 'lucide-react'
import { tryApi } from '../../api'
import { getState, openDialog, openSession, useStore } from '../../store'
import { ensureMessages } from '../../ws'
import { basename, normPath, plural, tokens } from '../../lib/format'
import { useCurrentTool, useElapsed } from '../../lib/live'
import { stopSession } from '../../lib/sessionActions'
import { sessionVisualState, STATE_LABEL } from '../../lib/sessionState'
import { clock, dockRows, runningShells, watchedShells, type ShellRun } from '../../lib/overview'
import { mcpParts, toolKind } from '../../lib/toolRun'
import type { Session, SubAgent } from '../../types'
import { StatusIcon, SubStateIcon, subStateLabel } from '../bits'

const BUSY = new Set(['working', 'restarting', 'compacting'])
const MAX_INDENT = 3

/**
 * Above the composer, like Orca's: the sub-agents this chat started (and theirs) that work or wait right now, each with
 * its current tool, tokens, clock and «Остановить», and under it the shell commands it runs; finished ones fold into
 * «История». The agent's own registry sub-agents (no chat of their own) follow, read-only. Hidden when there is nothing.
 */
export function WorkersPanel({ sessionId }: { sessionId: string }) {
  // a key of what the dock draws, not the sessions array: any session's activity anywhere must not redraw it
  const key = useStore((s) => {
    const { live, done } = dockRows(s.sessions, sessionId)
    return `${live.map((r) => `${r.s.id}:${r.indent}:${r.s.status}:${r.s.waitingFor ?? ''}`).join('|')}#${done.map((x) => x.id).join('|')}`
  })
  const { live, done } = useMemo(() => dockRows(getState().sessions, sessionId), [key, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  const sub = useStore((s) => s.subagents[sessionId])
  const internal = sub?.items ?? []
  const own = useOwnShells(sessionId)
  const [open, setOpen] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  const agents = live.length + internal.length
  const total = agents + own.length
  if (!total && !done.length) return null

  const busy = live.filter((r) => r.s.status === 'running' && !r.s.waitingFor).length + internal.filter((a) => BUSY.has(a.state)).length
  const waiting = live.filter((r) => r.s.waitingFor).length

  return (
    <section className="dock" aria-label="Субагенты этого чата">
      {total > 0 && (
        <>
          <button type="button" className="dock-head" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronDown className="chev" aria-hidden />
            <strong>{[agents > 0 && `${agents} ${plural(agents, 'субагент', 'субагента', 'субагентов')}`, own.length > 0 && `${own.length} ${plural(own.length, 'фоновая команда', 'фоновые команды', 'фоновых команд')}`].filter(Boolean).join(' · ')}</strong>
            {busy > 0 && <span className="dock-busy">в работе: {busy}</span>}
            {waiting > 0 && <span className="dock-wait">ждут вас: {waiting}</span>}
          </button>
          {open && (
            <div className="dock-list">
              {own.map((r) => <ShellRow key={r.id} r={r} indent={0} />)}
              {live.map((r) => <AgentRow key={r.s.id} id={r.s.id} indent={Math.min(r.indent, MAX_INDENT)} />)}
              {internal.length > 0 && (
                <>
                  <div className="dock-sub">
                    Встроенные субагенты агента
                    {sub && sub.problems.length > 0 && <span data-tip={sub.problems.join('\n')}> · пропущено записей: {sub.problems.length}</span>}
                  </div>
                  {internal.map((a) => <InternalRow key={a.id} a={a} />)}
                </>
              )}
            </div>
          )}
        </>
      )}
      {done.length > 0 && (
        <>
          <button type="button" className="dock-head dock-history" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
            <ChevronDown className="chev" aria-hidden />
            История · {done.length}
          </button>
          {showHistory && <div className="dock-list">{done.map((s) => <DoneRow key={s.id} id={s.id} />)}</div>}
        </>
      )}
    </section>
  )
}

/** A GigaCode built-in sub-agent lives in its parent's process: only the whole turn stops, so ask first. */
function stopAgent(s: Session) {
  if (!s.virtual) return stopSession(s)
  openDialog({
    kind: 'confirm', title: 'Остановить весь ход чата?', danger: true, ok: 'Остановить ход',
    text: 'Это встроенный субагент GigaCode: он работает внутри процесса родительского чата, и отдельно его не остановить. Остановится текущий ход чата вместе со всеми его субагентами.',
    onConfirm: () => void tryApi('POST', `/sessions/${encodeURIComponent(s.parentId ?? s.id)}/stop`),
  })
}

/** «Bash», «read_file», «Playwright / click»: the tool as the CLI names it, an MCP one by server and tool. */
const toolLabel = (name: string) => (toolKind(name) === 'mcp' ? mcpParts(name).filter(Boolean).join(' / ') : name)

/** What it does instead of a tool: its waiting state in words; nothing while it simply works. */
function stateWords(s: Session) {
  const v = sessionVisualState(s)
  if (v === 'running') return ''
  if (v === 'starting') return s.startWait ? `в очереди на запуск: ${s.startWait}-й` : 'запуск'
  return STATE_LABEL[v]
}

/** Seconds since `at`, ticking by itself: only this leaf redraws every second, never the row. */
function Since({ at }: { at: number }) {
  return <>{clock(useElapsed(at, true) * 1000)}</>
}

// one row per session id: it reads its own session, so another agent's activity does not redraw it
const AgentRow = memo(function AgentRow({ id, indent }: { id: string; indent: number }) {
  const s = useStore((st) => st.sessions.find((x) => x.id === id))
  if (!s) return null
  return <AgentRowView s={s} indent={indent} />
})

function AgentRowView({ s, indent }: { s: Session; indent: number }) {
  const tool = useCurrentTool(s)
  const shells = useShells(s)
  const home = useStore((st) => { const p = s.parentId ? st.sessions.find((x) => x.id === s.parentId) : undefined; return p ? normPath(p.worktreePath ?? p.cwd) : null })
  const place = normPath(s.worktreePath ?? s.cwd)
  const doing = tool ? toolLabel(tool) : stateWords(s)
  const used = s.tokensIn + s.tokensOut
  const role = s.virtual ? 'GigaCode' : s.role === 'reviewer' ? 'ревью' : null
  return (
    <>
      <div className="dock-row" style={{ '--indent': indent } as CSSProperties} data-state={sessionVisualState(s)}>
        <StatusIcon session={s} />
        <button type="button" className="dock-title" onClick={() => openSession(s.id)} data-tip={`Открыть чат «${s.title}»`}>
          {role && <span className="role-tag">{role}</span>}
          <span className="ellipsis">{s.title}</span>
          {doing && <span className="dock-doing ellipsis">{doing}</span>}
        </button>
        {home && place !== home && <span className="dock-place mono ellipsis" data-tip={s.worktreePath ?? s.cwd}>{basename(s.worktreePath ?? s.cwd)}</span>}
        <span className="dock-meta num">
          {used > 0 && <span data-tip="Токены: вход и выход">{tokens(used)}</span>}
          <span data-tip="Сколько работает"><Since at={s.createdAt} /></span>
        </span>
        {s.status === 'running'
          ? <button type="button" className="dock-stop" onClick={() => stopAgent(s)}>Остановить</button>
          : <span className="dock-stop-slot" aria-hidden />}
      </div>
      {shells.map((r) => <ShellRow key={r.id} r={r} indent={indent + 1} />)}
    </>
  )
}

/**
 * This chat's own background commands the harness watches (mvn test…): they run after its turn ended, so they are
 * listed here too — until their status file says they ended. A string key: output lines redraw only when they change.
 */
function useOwnShells(sid: string): ShellRun[] {
  const ids = useStore((st) => st.sessions.find((x) => x.id === sid)?.bgShells?.join('|') ?? '')
  useEffect(() => { if (ids) ensureMessages(sid) }, [ids, sid])
  const key = useStore((st) => (ids && st.messages[sid] ? JSON.stringify(watchedShells(st.messages[sid], ids.split('|'))) : '[]'))
  return useMemo(() => JSON.parse(key) as ShellRun[], [key])
}

/** Its shell commands running now, through a string key: a streamed word in its transcript does not redraw the row. */
function useShells(s: Session): ShellRun[] {
  // its turn may be over while a background command of its own still runs
  const running = s.status === 'running' || !!s.bgShells?.length
  useEffect(() => { if (running) ensureMessages(s.id) }, [running, s.id])
  const key = useStore((st) => (running && st.messages[s.id] ? JSON.stringify(runningShells(st.messages[s.id])) : '[]'))
  return useMemo(() => JSON.parse(key) as ShellRun[], [key])
}

function ShellRow({ r, indent }: { r: ShellRun; indent: number }) {
  return (
    <div className="dock-row dock-shell" style={{ '--indent': indent } as CSSProperties}
      data-tip={`${r.command}${r.last ? `\nПоследняя строка вывода: ${r.last}` : ''}\nКоманда агента. Харнес не может остановить её отдельно: остановите агента.${r.background ? ' Когда фоновая команда закончится, агент получит итог сообщением.' : ''}`}>
      <SquareTerminal className="dock-shell-icon" aria-hidden />
      <span className="dock-title dock-cmd mono ellipsis">{r.command}</span>
      {r.last && <span className="dock-doing ellipsis">{r.last}</span>}
      {r.background && <span className="dock-bg">в фоне</span>}
      <span className="dock-meta num"><Since at={r.at} /></span>
      <span className="dock-stop-slot" aria-hidden />
    </div>
  )
}

const DoneRow = memo(function DoneRow({ id }: { id: string }) {
  const s = useStore((st) => st.sessions.find((x) => x.id === id))
  if (!s) return null
  // a one-off whose turn ended without worker_done still answered: its last text went back to the agent as the result
  const answered = !!s.ephemeral && s.report?.status === 'no_report'
  const used = s.tokensIn + s.tokensOut
  const end = s.finishedAt ?? s.report?.at ?? s.lastActivityAt
  return (
    <div className="dock-row" data-archived={s.archived || undefined}>
      <StatusIcon session={answered ? { ...s, status: 'done' } : s} />
      <button type="button" className="dock-title" onClick={() => openSession(s.id)} data-tip={s.preview || s.title}>
        <span className="ellipsis">{s.title}</span>
        {s.archived && <span className="dock-doing">в архиве</span>}
      </button>
      <span className="dock-meta num">
        {used > 0 && <span data-tip="Токены: вход и выход">{tokens(used)}</span>}
        <span data-tip="Сколько работал">{clock(end - s.createdAt)}</span>
      </span>
      <span className="dock-stop-slot" aria-hidden />
    </div>
  )
})

function InternalRow({ a }: { a: SubAgent }) {
  const doing = a.activity?.tool ?? a.lastText?.split('\n').filter(Boolean).pop()
  const at = a.activity?.since ?? a.lastActivity
  return (
    <div className="dock-row" data-state={a.state} data-internal aria-label={`${a.name}: ${subStateLabel(a.state)}`}>
      <SubStateIcon state={a.state} />
      <span className="dock-title">
        <span className="ellipsis">{a.name}</span>
        {doing && <span className="dock-doing ellipsis">{doing}</span>}
      </span>
      <span className="dock-meta num">
        {a.tokensIn + a.tokensOut > 0 && <span>{tokens(a.tokensIn + a.tokensOut)}</span>}
        <span>{a.state === 'unverifiable' ? 'нет сигнала' : at && BUSY.has(a.state) ? <Since at={at} /> : subStateLabel(a.state)}</span>
      </span>
      <span className="dock-stop-slot" aria-hidden />
    </div>
  )
}
