import { useMemo, useState } from 'react'
import { CheckCheck, CircleAlert, CircleCheck, CircleHelp, Inbox, Info, Megaphone, TriangleAlert } from 'lucide-react'
import { tryApi } from '../api'
import { openSession, openTask, setState, useStore } from '../store'
import { fullTime, NOTIFY_KIND, relTime } from '../lib/format'
import { useNow } from '../lib/useNow'
import type { Notification, NotificationKind } from '../types'
import { ReplyOptions } from '../components/chat/MessageItem'

const ICON: Record<NotificationKind, typeof Info> = {
  question: CircleHelp, done: CircleCheck, failed: TriangleAlert, escalation: Megaphone, info: Info, error: CircleAlert,
}

function markRead(ids: string[]) {
  setState((s) => ({ notifications: s.notifications.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)) }))
}

export function InboxView() {
  const notifications = useStore((s) => s.notifications)
  const list = useMemo(() => [...notifications].sort((a, b) => b.at - a.at), [notifications])
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
          <span className="grow" />
          <time className="muted num" title={fullTime(n.at)}>{relTime(n.at, now)}</time>
        </div>
        <button type="button" className="inbox-text" onClick={open} disabled={!session && !task}>{n.text}</button>
        {n.options?.length && n.sessionId ? <ReplyOptions options={n.options} to={n.sessionId} onSent={() => void read()} /> : null}
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
