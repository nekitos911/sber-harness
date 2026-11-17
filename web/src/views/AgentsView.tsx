import { useMemo, useState } from 'react'
import { Bot, Ellipsis, ListPlus, MessageSquarePlus, Send, Square, Trash2 } from 'lucide-react'
import { tryApi } from '../api'
import { openDialog, openSession, openTask, setState, useStore, without } from '../store'
import { relTime, ROLE, tokens } from '../lib/format'
import { useNow } from '../lib/useNow'
import type { Session } from '../types'
import { Branch, StateLegend, StatusIcon, statusText } from '../components/bits'
import { useStateLine } from '../lib/live'
import { sessionVisualState, type VisualState } from '../lib/sessionState'
import { MenuButton, Select } from '../components/ui'

/** Lanes by visual state; «Ждут вас» shows only when someone does. */
const GROUPS: { id: string; label: string; match: VisualState[]; optional?: boolean }[] = [
  { id: 'you', label: 'Ждут вас', match: ['waiting_answer', 'waiting_permission', 'auth'], optional: true },
  { id: 'run', label: 'Работают', match: ['running', 'starting', 'stalled'] },
  { id: 'idle', label: 'Свободны', match: ['idle', 'stopped'] },
  { id: 'done', label: 'Готово', match: ['done'] },
  { id: 'fail', label: 'Ошибки', match: ['error', 'exited'] },
]

/** Coordinator first, then its workers from the same group right under it. */
function ordered(list: Session[]) {
  const ids = new Set(list.map((s) => s.id))
  const out: { s: Session; nested: boolean }[] = []
  const visit = (s: Session, nested: boolean) => {
    out.push({ s, nested })
    for (const k of list) if (k.parentId === s.id) visit(k, true)
  }
  for (const s of list) if (!s.parentId || !ids.has(s.parentId)) visit(s, false)
  return out
}

export function AgentsView() {
  const sessions = useStore((s) => s.sessions)
  const chats = useMemo(() => sessions.filter((s) => s.kind === 'chat' && !s.virtual && !s.archived).sort((a, b) => b.lastActivityAt - a.lastActivityAt), [sessions])
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])

  return (
    <div className="agents-view">
      <header className="view-head">
        <h1>Агенты</h1>
        <span className="count">{chats.length}</span>
        <StateLegend />
        <span className="grow" />
        <button type="button" className="btn" onClick={() => openDialog({ kind: 'chat' })}>
          <MessageSquarePlus />
          Новый чат…
        </button>
      </header>
      {chats.length === 0 ? (
        <div className="empty">
          <Bot className="empty-icon" aria-hidden />
          <h2>Агентов пока нет</h2>
          <p>Они появляются, когда вы начинаете чат, берёте задачу в работу или координатор запускает исполнителей.</p>
          <button type="button" className="btn btn-primary" onClick={() => openDialog({ kind: 'chat' })}>Новый чат</button>
        </div>
      ) : (
        <div className="lanes">
          {GROUPS.map((g) => {
            const list = chats.filter((s) => g.match.includes(sessionVisualState(s)))
            if (g.optional && !list.length) return null
            return (
              <section key={g.id} className="lane" aria-labelledby={`lane-${g.id}`}>
                <header className="col-head">
                  <span className="lane-mark" data-g={g.id} aria-hidden />
                  <h2 id={`lane-${g.id}`}>{g.label}</h2>
                  <span className="col-count num">{list.length}</span>
                </header>
                <div className="col-body">
                  {ordered(list).map(({ s, nested }) => (
                    <AgentCard key={s.id} s={s} nested={nested} parent={s.parentId ? byId.get(s.parentId) : undefined} />
                  ))}
                  {list.length === 0 && <div className="col-empty">Пусто</div>}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AgentCard({ s, nested, parent }: { s: Session; nested: boolean; parent?: Session }) {
  const agents = useStore((st) => st.agents)
  const tasks = useStore((st) => st.tasks)
  const now = useNow()
  const line = useStateLine(s)
  const [mode, setMode] = useState<'message' | 'assign' | 'delete' | null>(null)
  const [text, setText] = useState('')
  const task = s.taskId ? tasks.find((t) => t.id === s.taskId) : undefined
  const free = tasks.filter((t) => t.status === 'todo' || t.status === 'backlog')

  const send = async () => {
    if (!text.trim()) return
    const res = await tryApi<{ queued: boolean }>('POST', `/sessions/${s.id}/messages`, { text: text.trim() })
    if (!res) return
    setText('')
    setMode(null)
  }
  const assign = async (taskId: string) => {
    const res = await tryApi<Session>('POST', `/tasks/${encodeURIComponent(taskId)}/assign`, { sessionId: s.id })
    if (res) setMode(null)
  }
  const stop = () => void tryApi('POST', `/sessions/${s.id}/stop`)
  const remove = async () => {
    if ((await tryApi<unknown>('DELETE', `/sessions/${s.id}`)) === undefined) return
    setState((st) => ({ sessions: without(st.sessions, s.id) }))
  }

  return (
    <article className="agent-card" data-nested={nested} data-s={sessionVisualState(s)}>
      <div className="agent-top">
        <StatusIcon session={s} />
        <button type="button" className="agent-title ellipsis" onClick={() => openSession(s.id)} data-tip={s.title || s.id} data-tip-trunc>{s.title || s.id}</button>
        {s.role !== 'solo' && <span className="role" data-role={s.role}>{ROLE[s.role]}</span>}
      </div>
      <div className="agent-meta">
        <span>{agents.find((a) => a.id === s.agent)?.label ?? s.agent}</span>
        {s.model && <span className="mono muted">{s.model}</span>}
        <span className="agent-state" data-s={sessionVisualState(s)}>{line || statusText(s)}</span>
        {s.queued > 0 && <span className="chip chip-run">в очереди: {s.queued}</span>}
        {s.tokensIn + s.tokensOut > 0 && (
          <span className="mono muted num" data-tip={`вход ${s.tokensIn}, выход ${s.tokensOut}`}>{tokens(s.tokensIn + s.tokensOut)}</span>
        )}
      </div>
      {task && (
        <button type="button" className="agent-task" onClick={() => openTask(task.id)} data-tip={task.title} data-tip-trunc>
          <span className="mono">{task.externalId ?? task.id}</span>
          <span className="ellipsis">{task.title}</span>
        </button>
      )}
      {!nested && parent && (
        <button type="button" className="agent-parent" onClick={() => openSession(parent.id)}>↳ от {parent.title}</button>
      )}
      {s.branch && <div className="agent-where"><Branch name={s.branch} /></div>}
      {s.preview && <p className="agent-preview">{s.preview}</p>}
      <div className="agent-foot" data-open={mode !== null || undefined}>
        <span className="muted num">{relTime(s.lastActivityAt, now)}</span>
        <span className="grow" />
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Написать агенту" data-tip="Написать" aria-pressed={mode === 'message'} onClick={() => setMode(mode === 'message' ? null : 'message')}><Send /></button>
        <MenuButton label="Ещё действия" icon={<Ellipsis />} align="right" className="icon-btn-sm" items={[
          { label: 'Дать задачу…', icon: <ListPlus />, onSelect: () => setMode('assign') },
          ...(s.status === 'running' ? [{ label: 'Остановить', icon: <Square />, onSelect: stop }] : []),
          { label: 'Удалить сессию', icon: <Trash2 />, danger: true, divider: true, onSelect: () => setMode('delete') },
        ]} />
      </div>
      {mode === 'message' && (
        <form className="agent-inline" onSubmit={(e) => { e.preventDefault(); void send() }}>
          <input className="input" autoFocus placeholder={s.status === 'running' ? 'Встанет в очередь' : 'Сообщение агенту'} aria-label="Сообщение агенту" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setMode(null)} />
          <button type="submit" className="btn btn-sm" disabled={!text.trim()}>Отправить</button>
        </form>
      )}
      {mode === 'assign' && (
        <div className="agent-inline">
          <Select autoFocus label="Задача для агента" value="" onChange={(id) => void assign(id)} disabled={!free.length}
            placeholder={free.length ? 'Выберите задачу…' : 'Нет задач в «Бэклог» и «К работе»'}
            options={free.map((t) => ({ value: t.id, label: t.title, text: `${t.externalId ?? t.id} ${t.title}`, hint: t.externalId ?? t.id }))} />
        </div>
      )}
      {mode === 'delete' && (
        <div className="agent-inline">
          <span className="grow">Остановить и удалить вместе с историей?</span>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()}>Удалить</button>
          <button type="button" className="btn btn-sm" onClick={() => setMode(null)}>Отмена</button>
        </div>
      )}
    </article>
  )
}
