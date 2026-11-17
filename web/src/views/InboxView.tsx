import { useMemo, useRef, useState } from 'react'
import { useEffect } from 'react'
import { CheckCheck, CircleAlert, CircleCheck, CircleHelp, GitCommitHorizontal, GitCompare, GitPullRequest, Inbox, Info, Megaphone, RotateCcw, ShieldAlert, TriangleAlert, Wrench } from 'lucide-react'
import { tryApi } from '../api'
import { openDialog, openSession, openTab, openTask, openWorktree, setState, showPanel, useFeature, useStore } from '../store'
import { doneForReview, openEscalation, waitsForMe } from '../lib/pending'
import { ReworkPopover } from '../components/board/Rework'
import { fullTime, NOTIFY_KIND, relTime } from '../lib/format'
import { useNow } from '../lib/useNow'
import type { Notification, NotificationKind } from '../types'
import { LinkButton, ReplyOptions } from '../components/chat/MessageItem'
import { AskToolCard, isAskTool, MessageQuestion, PermissionCard, permissionSettled, questionSettled } from '../components/chat/Attention'
import { ensureMessages } from '../ws'
import type { Message, Session, Task } from '../types'

/** Sessions a restart interrupted: reopens the recovery dialog. */
function Interrupted() {
  const n = useStore((s) => s.recovery?.sessions.length ?? 0)
  if (!n) return null
  return (
    <section className="inbox-waiting" aria-label="Прерванные сессии">
      <button type="button" className="inbox-recovery" onClick={() => openDialog({ kind: 'recovery' })}>
        <RotateCcw aria-hidden />
        Прерванные сессии ({n})
        <span className="muted">— продолжить или отпустить</span>
      </button>
    </section>
  )
}

/**
 * «Ждёт меня», one entry per chat: its open question / permission request, answerable right here, and tasks whose
 * agent reported done (look at the diff, commit, PR, or send back). Entries leave by themselves once handled.
 */
function WaitingForYou() {
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const notifications = useStore((s) => s.notifications)
  const waiting = useMemo(() => sessions.filter(waitsForMe), [sessions])
  const done = useMemo(() => tasks.filter(doneForReview), [tasks])
  const escalations = useMemo(() => notifications.filter(openEscalation), [notifications])
  const n = waiting.length + done.length + escalations.length
  if (!n) return null
  return (
    <section className="inbox-waiting" aria-label="Ждёт меня">
      <h2>Ждёт меня <span className="count count-signal">{n}</span></h2>
      {waiting.map((x) => <WaitingItem key={x.id} s={x} />)}
      {escalations.map((e) => <EscalationItem key={e.id} n={e} />)}
      {done.map((t) => <DoneItem key={t.id} t={t} s={sessions.find((x) => x.id === t.assigneeSessionId)} />)}
    </section>
  )
}

/**
 * An agent stopped without a report (or with an error): open the chat, send the task back, or accept the result as
 * is (the task goes to review). Any of them settles the entry (read).
 */
function EscalationItem({ n }: { n: Notification }) {
  const session = useStore((s) => (n.sessionId ? s.sessions.find((x) => x.id === n.sessionId) : undefined))
  const task = useStore((s) => (n.taskId ? s.tasks.find((t) => t.id === n.taskId) : undefined))
  const [reworking, setReworking] = useState(false)
  const reworkRef = useRef<HTMLButtonElement>(null)
  const settle = () => { markRead([n.id]); void tryApi('POST', `/notifications/${encodeURIComponent(n.id)}/read`) }
  const actions = n.actions ?? ['open']
  const accept = async () => {
    if (!task) return
    const t = await tryApi<Task>('PATCH', `/tasks/${encodeURIComponent(task.id)}`, { status: 'review' })
    if (!t) return
    setState((s) => ({ tasks: s.tasks.map((x) => (x.id === t.id ? t : x)) }))
    settle()
  }
  return (
    <div className="inbox-wait">
      <span className="inbox-wait-head inbox-esc-head">
        <Megaphone aria-hidden className="inbox-esc-icon" />
        <span className="inbox-esc-text">{n.text}</span>
        {(n.count ?? 1) > 1 && <span className="count" data-tip="Сколько раз повторилось">×{n.count}</span>}
      </span>
      <span className="inbox-actions">
        {actions.includes('open') && session && <button type="button" className="btn btn-sm" onClick={() => { settle(); openSession(session.id) }}>Открыть чат</button>}
        {actions.includes('rework') && task && (
          <>
            <button ref={reworkRef} type="button" className="btn btn-sm" aria-expanded={reworking} onClick={() => setReworking(true)}><Wrench />Доработать</button>
            {reworking && <ReworkPopover task={task} anchor={reworkRef} open onClose={() => setReworking(false)} onSent={settle} />}
          </>
        )}
        {actions.includes('accept') && task && <button type="button" className="btn btn-sm" onClick={() => void accept()} data-tip="Задача уйдёт на проверку как есть"><CircleCheck />Принять результат</button>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={settle}>Прочитано</button>
      </span>
    </div>
  )
}

/** A task its agent finished: what to do with the result, inline. */
function DoneItem({ t, s }: { t: Task; s?: Session }) {
  const cwd = s ? s.worktreePath ?? s.cwd : t.worktrees?.[0]?.path
  const reworkOn = useFeature('rework')
  const [reworking, setReworking] = useState(false)
  const reworkRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="inbox-wait">
      <span className="inbox-wait-head">
        <button type="button" className="chip" onClick={() => (s ? openSession(s.id) : openTask(t.id))}>{t.externalId ?? t.id}: {t.title}</button>
        <span className="muted">агент закончил — проверьте результат</span>
      </span>
      <span className="inbox-actions">
        {cwd && <button type="button" className="btn btn-sm" onClick={() => openTab({ kind: 'diff', cwd, path: null })}><GitCompare />Дифф</button>}
        {cwd && <button type="button" className="btn btn-sm" onClick={() => { openWorktree(cwd); showPanel('changes') }}><GitCommitHorizontal />Коммит</button>}
        {cwd && <button type="button" className="btn btn-sm" onClick={() => openDialog({ kind: 'pr', cwd })}><GitPullRequest />PR</button>}
        {reworkOn && <button ref={reworkRef} type="button" className="btn btn-sm" aria-expanded={reworking} onClick={() => setReworking(true)}><Wrench />Доработать</button>}
        {reworking && <ReworkPopover task={t} anchor={reworkRef} open onClose={() => setReworking(false)} />}
      </span>
    </div>
  )
}

function WaitingItem({ s }: { s: Session }) {
  useEffect(() => { ensureMessages(s.id) }, [s.id])
  const open = useStore((st) => {
    const list: Message[] = st.messages[s.id] ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if ((m.kind === 'permission' && m.permission && !permissionSettled(m.permission)) || (m.kind === 'question' && m.question && !questionSettled(m.question))) return m
      if (m.kind === 'tool' && m.tool && isAskTool(m.tool.name)) return list.slice(i + 1).some((x) => x.kind === 'user') ? null : m
    }
    return null
  })
  return (
    <div className="inbox-wait">
      <button type="button" className="chip" onClick={() => openSession(s.id)}>{s.title}</button>
      {open ? (open.kind === 'permission' ? <PermissionCard m={open} /> : open.kind === 'tool' ? <AskToolCard m={open} /> : <MessageQuestion m={open} />)
        : <span className="muted">{s.waitingFor === 'permission' ? 'ждёт разрешения' : s.waitingFor === 'auth' ? 'нужен вход в CLI' : 'ждёт ответа'} — откройте чат</span>}
    </div>
  )
}

const ICON: Record<NotificationKind, typeof Info> = {
  question: CircleHelp, permission: ShieldAlert, recovery: RotateCcw, done: CircleCheck, failed: TriangleAlert, escalation: Megaphone, info: Info, error: CircleAlert,
}

function markRead(ids: string[]) {
  setState((s) => ({ notifications: s.notifications.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)) }))
}

export function InboxView() {
  const notifications = useStore((s) => s.notifications)
  // Unread questions and permission requests first: someone is waiting.
  const urgent = (n: Notification) => !n.read && (n.kind === 'question' || n.kind === 'permission')
  const list = useMemo(() => [...notifications].sort((a, b) => Number(urgent(b)) - Number(urgent(a)) || b.at - a.at), [notifications])
  const unread = list.filter((n) => !n.read).length

  const readAll = async () => {
    if ((await tryApi<unknown>('POST', '/notifications/read-all')) !== undefined) markRead(list.map((n) => n.id))
  }

  return (
    <div className="inbox-view">
      <header className="view-head">
        <h1>Входящие</h1>
        {unread > 0 && <span className="count count-signal">{unread}</span>}
        <span className="grow" />
        <button type="button" className="btn" disabled={!unread} onClick={() => void readAll()}>
          <CheckCheck />
          Прочитать все
        </button>
      </header>
      <Interrupted />
      <WaitingForYou />
      {list.length === 0 ? (
        <div className="empty">
          <Inbox className="empty-icon" aria-hidden />
          <h2>Пусто</h2>
          <p>Сюда приходят вопросы агентов, отчёты исполнителей и ошибки.</p>
        </div>
      ) : (
        <ul className="inbox-list">
          {list.map((n) => <Item key={n.id} n={n} />)}
        </ul>
      )}
    </div>
  )
}

function Item({ n }: { n: Notification }) {
  const session = useStore((s) => (n.sessionId ? s.sessions.find((x) => x.id === n.sessionId) : undefined))
  const task = useStore((s) => (n.taskId ? s.tasks.find((t) => t.id === n.taskId) : undefined))
  const now = useNow()
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const Icon = ICON[n.kind]

  const read = async () => {
    if (n.read) return
    markRead([n.id])
    await tryApi('POST', `/notifications/${encodeURIComponent(n.id)}/read`)
  }
  const open = () => {
    void read()
    if (session) openSession(session.id)
    else if (task) openTask(task.id)
  }
  const reply = async () => {
    if (!text.trim() || !n.sessionId) return
    const res = await tryApi<{ queued: boolean }>('POST', `/sessions/${encodeURIComponent(n.sessionId)}/messages`, { text: text.trim() })
    if (!res) return
    setText('')
    setReplying(false)
    void read()
  }

  return (
    <li className="inbox-item" data-unread={!n.read} data-kind={n.kind}>
      <Icon className="inbox-icon" aria-hidden />
      <div className="inbox-main">
        <div className="inbox-head">
          <span className="inbox-kind">{NOTIFY_KIND[n.kind]}</span>
          {session && <button type="button" className="chip" onClick={open}>{session.title}</button>}
          {task && <button type="button" className="chip chip-mono" onClick={() => { void read(); openTask(task.id) }}>{task.externalId ?? task.id}</button>}
          {(n.count ?? 1) > 1 && <span className="count" data-tip="Сколько раз повторилось">×{n.count}</span>}
          <span className="grow" />
          <time className="muted num" data-tip={fullTime(n.at)}>{relTime(n.at, now)}</time>
        </div>
        <button type="button" className="inbox-text" onClick={open} disabled={!session && !task}>{n.text}</button>
        {n.options?.length && n.sessionId ? <ReplyOptions options={n.options} to={n.sessionId} onSent={() => void read()} /> : null}
        {n.link && <LinkButton href={n.link} />}
        {replying ? (
          <form className="inbox-reply" onSubmit={(e) => { e.preventDefault(); void reply() }}>
            <textarea
              className="textarea"
              autoFocus
              rows={2}
              placeholder="Ответ агенту. Enter — отправить"
              aria-label="Ответ агенту"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void reply() }
                if (e.key === 'Escape') setReplying(false)
              }}
            />
            <div className="row">
              <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim()}>Ответить</button>
              <button type="button" className="btn btn-sm" onClick={() => setReplying(false)}>Отмена</button>
            </div>
          </form>
        ) : (
          <div className="inbox-actions">
            {n.kind === 'question' && n.sessionId && <button type="button" className="btn btn-sm" onClick={() => setReplying(true)}>Ответить</button>}
            {!n.read && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void read()}>Прочитано</button>}
          </div>
        )}
      </div>
    </li>
  )
}
