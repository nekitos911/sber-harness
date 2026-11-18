import { useMemo, useState } from 'react'
import { CliGlyph } from '../components/Sidebar'
import { listedChat } from '../lib/pending'
import { ArchiveRestore, Bot, Ellipsis, ListPlus, MessageSquarePlus, Send } from 'lucide-react'
import { tryApi } from '../api'
import { openDialog, openSession, openTask, useStore } from '../store'
import { ago, ROLE } from '../lib/format'
import { useNow } from '../lib/useNow'
import type { Session } from '../types'
import { Branch, StatusIcon, statusText } from '../components/bits'
import { useStateLine } from '../lib/live'
import { sessionVisualState, type VisualState } from '../lib/sessionState'
import { archiveSession, renameSession, sessionMenu } from '../lib/sessionActions'
import { MenuButton, Segmented, Select } from '../components/ui'

/** Lanes by visual state; «Ждут вас» shows only when someone does. */
const DAY = 86400000
const BUSY_OR_WAITING = new Set<string>(['running', 'starting', 'stalled', 'waiting_answer', 'waiting_permission', 'auth'])

const GROUPS: { id: string; label: string; hint: string; match: VisualState[]; optional?: boolean }[] = [
  { id: 'you', label: 'Ждут вас', hint: 'вопрос, разрешение, вход или прерваны', match: ['waiting_answer', 'waiting_permission', 'auth', 'interrupted'], optional: true },
  { id: 'run', label: 'Работают', hint: 'идёт ход', match: ['running', 'starting', 'stalled'] },
  { id: 'idle', label: 'Ответили', hint: 'ход закончен — можно писать дальше', match: ['idle', 'stopped'] },
  { id: 'done', label: 'Задача выполнена', hint: 'агент задачи отчитался (worker_done)', match: ['done'] },
  { id: 'fail', label: 'Ошибки', hint: 'упали или завершились', match: ['error', 'exited'], optional: true },
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
  const [archive, setArchive] = useState(false)
  // «Активные» = the set the sidebar counts (listedChat); «Архив» = archived ones
  // a CLI chat nobody continued here is history, not an agent: off the board unless it works or waits right now
  const history = (s: Session) => s.origin === 'cli' && !s.cliImportedAt && !BUSY_OR_WAITING.has(sessionVisualState(s))
  const chats = useMemo(() => sessions.filter((s) => (archive ? s.kind === 'chat' && !s.virtual && !s.system && !!s.archived : listedChat(s) && !history(s))).sort((a, b) => b.lastActivityAt - a.lastActivityAt), [sessions, archive])
  const [allIn, setAllIn] = useState<Set<string>>(new Set()) // lanes opened past the last day
  const now = useNow()
  const archivedCount = useMemo(() => sessions.filter((s) => s.kind === 'chat' && !s.virtual && s.archived).length, [sessions])
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  // built-in sub-agents (not archived yet: their parent's turn still runs) ride in the parent's lane, right under it
  const subs = useMemo(() => (archive ? [] : sessions.filter((s) => s.virtual && !s.archived && !!s.parentId && byId.has(s.parentId))), [sessions, archive, byId])
  const laneState = (s: Session) => sessionVisualState(s.virtual ? byId.get(s.parentId!) ?? s : s)

  return (
    <div className="agents-view">
      <header className="view-head">
        <h1>Агенты</h1>
        <span className="count">{chats.length}</span>
        <Segmented size="sm" label="Какие чаты показывать" value={archive ? 'archive' : 'active'} onChange={(v) => setArchive(v === 'archive')}
          options={[{ value: 'active', label: 'Активные' }, { value: 'archive', label: archivedCount > 0 ? `Архив ${archivedCount}` : 'Архив' }]} />

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
            const lane = [...chats, ...subs].filter((s) => g.match.includes(laneState(s)))
            // «Ответили» / «Готово» keep the last day; older ones wait behind «ещё N» (auto-archive takes them later)
            const aged = (g.id === 'idle' || g.id === 'done') && !archive && !allIn.has(g.id)
            const list = aged ? lane.filter((s) => now - s.lastActivityAt < DAY) : lane
            const older = lane.length - list.length
            if (g.optional && !lane.length) return null
            return (
              <section key={g.id} className="lane" aria-labelledby={`lane-${g.id}`}>
                <header className="col-head">
                  <span className="lane-mark" data-g={g.id} aria-hidden />
                  <h2 id={`lane-${g.id}`} data-tip={g.hint}>{g.label}</h2>
                  <span className="col-count num">{lane.length}</span>

                </header>
                <div className="col-body">
                  {ordered(list).map(({ s, nested }) => (
                    <AgentCard key={s.id} s={s} nested={nested} parent={s.parentId ? byId.get(s.parentId) : undefined} />
                  ))}
                  {list.length === 0 && !older && <div className="col-empty">Пусто</div>}
                  {older > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm lane-more" onClick={() => setAllIn(new Set([...allIn, g.id]))}>
                      Ещё {older} старше суток
                    </button>
                  )}
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
  const [mode, setMode] = useState<'message' | 'assign' | null>(null)
  const [editing, setEditing] = useState(false)
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

  return (
    <article className="agent-card" data-nested={nested} data-s={sessionVisualState(s)}>
      <div className="agent-top">
        <StatusIcon session={s} />
        {editing
          ? <input className="input agent-rename" autoFocus defaultValue={s.title} aria-label="Название чата"
              onBlur={(e) => { setEditing(false); void renameSession(s, e.currentTarget.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = s.title; setEditing(false) } }} />
          : <button type="button" className="agent-title ellipsis" onClick={() => openSession(s.id)}>{s.origin === 'cli' && <CliGlyph />}{s.title || s.id}</button>}
        {s.role !== 'solo' && <span className="role" data-role={s.role}>{ROLE[s.role]}</span>}
      </div>
      <div className="agent-meta">
        <span>{agents.find((a) => a.id === s.agent)?.label ?? s.agent}</span>
        {s.model && <span className="mono muted">{s.model}</span>}
        {!['idle', 'done'].includes(sessionVisualState(s)) && <span className="agent-state" data-s={sessionVisualState(s)}>{line || statusText(s)}</span>}
        {s.queued > 0 && <span className="chip chip-run">в очереди {s.queued}</span>}
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
      {s.preview && !s.waitingFor && <p className="agent-preview">{s.preview}</p>/* waiting: its state says what it needs, not the last «Done.» */}
      <div className="agent-foot" data-open={mode !== null || undefined}>
        <span className="muted num">{ago(s.lastActivityAt, now)}</span>
        <span className="grow" />
        {!s.virtual && <button type="button" className="icon-btn icon-btn-sm" aria-label="Написать агенту" data-tip="Написать" aria-pressed={mode === 'message'} onClick={() => setMode(mode === 'message' ? null : 'message')}><Send /></button>}
        {s.archived && <button type="button" className="btn btn-sm" onClick={() => void archiveSession(s, false)}><ArchiveRestore />Вернуть</button>}
        {!s.virtual && <MenuButton label="Ещё действия" icon={<Ellipsis />} align="right" className="icon-btn-sm" items={[
          ...(!s.archived ? [{ label: 'Дать задачу…', icon: <ListPlus />, onSelect: () => setMode('assign') }] : []),
          ...sessionMenu(s, () => setEditing(true)),
        ]} />}
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
    </article>
  )
}
