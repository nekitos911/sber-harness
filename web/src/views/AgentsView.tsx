import { useMemo, useState } from 'react'
import { listedChat } from '../lib/pending'
import { ArchiveRestore, Bot, Ellipsis, ListPlus, MessageSquarePlus, Send } from 'lucide-react'
import { tryApi } from '../api'
import { openDialog, openSession, openTask, useStore } from '../store'
import { ago, ROLE, tokens } from '../lib/format'
import { useNow } from '../lib/useNow'
import type { Session } from '../types'
import { Branch, StateLegend, StatusIcon, statusText } from '../components/bits'
import { useStateLine } from '../lib/live'
import { sessionVisualState, type VisualState } from '../lib/sessionState'
import { archiveSession, renameSession, sessionMenu } from '../lib/sessionActions'
import { MenuButton, Select } from '../components/ui'

/** Lanes by visual state; «Ждут вас» shows only when someone does. */
const GROUPS: { id: string; label: string; hint: string; match: VisualState[]; optional?: boolean }[] = [
  { id: 'you', label: 'Ждут вас', hint: 'вопрос, разрешение, вход или прерваны', match: ['waiting_answer', 'waiting_permission', 'auth', 'interrupted'], optional: true },
  { id: 'run', label: 'Работают', hint: 'идёт ход', match: ['running', 'starting', 'stalled'] },
  { id: 'idle', label: 'Свободны', hint: 'ход закончен, ждут сообщения', match: ['idle', 'stopped'] },
  { id: 'done', label: 'Готово', hint: 'отчитались о задаче', match: ['done'] },
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
  const chats = useMemo(() => sessions.filter((s) => (archive ? s.kind === 'chat' && !s.virtual && !s.system && !!s.archived : listedChat(s))).sort((a, b) => b.lastActivityAt - a.lastActivityAt), [sessions, archive])
  const archivedCount = useMemo(() => sessions.filter((s) => s.kind === 'chat' && !s.virtual && s.archived).length, [sessions])
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])

  return (
    <div className="agents-view">
      <header className="view-head">
        <h1>Агенты</h1>
        <span className="count">{chats.length}</span>
        <span className="sb-scope" role="group" aria-label="Какие чаты показывать">
          <button type="button" aria-pressed={!archive} onClick={() => setArchive(false)}>Активные</button>
          <button type="button" aria-pressed={archive} onClick={() => setArchive(true)}>Архив{archivedCount > 0 && <span className="num"> {archivedCount}</span>}</button>
        </span>
        {!archive && <StateLegend />}
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
                  <span className="lane-hint">{g.hint}</span>
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
          : <button type="button" className="agent-title ellipsis" onClick={() => openSession(s.id)} data-tip={s.title || s.id} data-tip-trunc>{s.title || s.id}</button>}
        {s.role !== 'solo' && <span className="role" data-role={s.role}>{ROLE[s.role]}</span>}
      </div>
      <div className="agent-meta">
        <span>{agents.find((a) => a.id === s.agent)?.label ?? s.agent}</span>
        {s.model && <span className="mono muted">{s.model}</span>}
        <span className="agent-state" data-s={sessionVisualState(s)}>{line || statusText(s)}</span>
        {s.queued > 0 && <span className="chip chip-run">в очереди {s.queued}</span>}
        {s.tokensIn + s.tokensOut > 0 && (
          <span className="muted num" data-tip={`вход ${s.tokensIn}, выход ${s.tokensOut}`}>токены {tokens(s.tokensIn + s.tokensOut)}</span>
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
        <span className="muted num">активность {ago(s.lastActivityAt, now)}</span>
        <span className="grow" />
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Написать агенту" data-tip="Написать" aria-pressed={mode === 'message'} onClick={() => setMode(mode === 'message' ? null : 'message')}><Send /></button>
        {s.archived && <button type="button" className="btn btn-sm" onClick={() => void archiveSession(s, false)}><ArchiveRestore />Вернуть</button>}
        <MenuButton label="Ещё действия" icon={<Ellipsis />} align="right" className="icon-btn-sm" items={[
          ...(!s.archived ? [{ label: 'Дать задачу…', icon: <ListPlus />, onSelect: () => setMode('assign') }] : []),
          ...sessionMenu(s, () => setEditing(true)),
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
    </article>
  )
}
