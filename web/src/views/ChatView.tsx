import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Ellipsis, GitCompareArrows, LoaderCircle, MessageSquare, RotateCcw, ScrollText, Square, Trash2 } from 'lucide-react'
import { api, errorText, tryApi } from '../api'
import { openTab, openTask, setState, showPanel, upsert, useStore, without } from '../store'
import { loadMessages, loadSubagents } from '../ws'
import { basename, normPath, ROLE } from '../lib/format'
import { fileEdit } from '../lib/toolcall'
import { useGit } from '../lib/git'
import { useStartingLabel } from '../lib/live'
import type { Message, Session } from '../types'
import { Branch, Loading, Skeleton, StatusIcon, statusText } from '../components/bits'
import { MenuButton } from '../components/ui/Menu'
import { BranchPicker } from '../components/pickers/BranchPicker'
import { Disclosure } from '../components/ui'
import { MessageItem } from '../components/chat/MessageItem'
import { Composer } from '../components/chat/Composer'
import { WorkersPanel } from '../components/chat/WorkersPanel'

const PAGE = 200
const PLACEHOLDER = { status: 'idle', phase: null, lastActivityAt: 0 } as Session // hooks run before the session is known
const EMPTY: Message[] = []

export function ChatView({ id, active }: { id: string; active: boolean }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === id))
  const messages = useStore((s) => s.messages[id])
  const allSessions = useStore((s) => s.sessions)
  const workers = useMemo(() => allSessions.filter((s) => s.parentId === id), [allSessions, id])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [log, setLog] = useState<string | null>(null)

  const shownAt = useRef(0) // messages newer than the first render of the transcript fade in; history does not
  if (messages && !shownAt.current) shownAt.current = Date.now()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => { void loadSubagents(id) }, [id])

  useEffect(() => {
    if (messages) return
    setLoadError(null)
    loadMessages(id).catch((e) => setLoadError(errorText(e)))
  }, [id, messages])

  const list = messages ?? EMPTY
  const running = session?.status === 'running'
  const starting = useStartingLabel(session ?? PLACEHOLDER)
  const lastText = list.length ? list[list.length - 1].text.length : 0

  // Follow new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && active && stick.current) el.scrollTop = el.scrollHeight
  }, [list.length, lastText, active, running])

  if (!session) return <Loading label="Загрузка сессии…" />

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stick.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
  }
  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stick.current = true
  }

  const showLog = async () => {
    try {
      const res = await api<{ text: string }>('GET', `/sessions/${id}/log`)
      setLog(res.text || 'Лог пуст.')
    } catch (e) {
      setLog(`Не удалось получить лог: ${errorText(e)}`)
    }
  }
  const reset = () => void tryApi('POST', `/sessions/${id}/restart`)
  const remove = async () => {
    if (!window.confirm(`Удалить сессию «${session.title}» вместе с историей?`)) return
    if ((await tryApi<unknown>('DELETE', `/sessions/${id}`)) !== undefined) setState((s) => ({ sessions: without(s.sessions, id) }))
  }

  const hidden = Math.max(0, list.length - limit)
  const visible = hidden ? list.slice(hidden) : list

  return (
    <div className="chat">
      <ChatHeader session={session} onLog={showLog} onReset={reset} onDelete={() => void remove()} />
      {log !== null && (
        <div className="chat-log">
          <div className="row"><strong>Лог агента (stderr)</strong><span className="grow" /><button type="button" className="btn btn-ghost btn-sm" onClick={() => setLog(null)}>Скрыть</button></div>
          <pre>{log}</pre>
        </div>
      )}

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-col" role="log" aria-live="polite" aria-relevant="additions">
          {!messages && !loadError && <Skeleton rows={6} label="Загрузка истории…" />}
          {loadError && (
            <div className="empty">
              <p>Не удалось загрузить историю: {loadError}</p>
              <button type="button" className="btn" onClick={() => { setLoadError(null); loadMessages(id).catch((e) => setLoadError(errorText(e))) }}>Повторить</button>
            </div>
          )}
          {messages && list.length === 0 && (
            <div className="empty chat-empty">
              <MessageSquare className="empty-icon" aria-hidden />
              <h2>Начните разговор</h2>
              <p>Опишите задачу агенту. <kbd>Enter</kbd> — отправить, <kbd>Shift</kbd>+<kbd>Enter</kbd> — новая строка.</p>
            </div>
          )}
          {hidden > 0 && (
            <button type="button" className="btn btn-ghost btn-sm chat-older" onClick={() => setLimit(limit + PAGE)}>
              Показать ранние ({hidden})
            </button>
          )}
          {visible.map((m) => <MessageItem key={m.id} m={m} fresh={m.at > shownAt.current} />)}
          {running && <div className="chat-working" role="status"><LoaderCircle className="spinner" aria-hidden />{starting || 'Работает…'}</div>}
          {!running && <TurnFiles messages={list} cwd={session.cwd} />}
        </div>
      </div>

      <div className="chat-bottom">
        {!atBottom && (
          <button type="button" className="btn to-bottom" onClick={toBottom}>
            <ArrowDown />
            к последнему
          </button>
        )}
        <div className="chat-col">
          <WorkersPanel sessionId={id} workers={workers} />
          {session.status === 'error' && (
            <div className="chat-alert" role="alert">
              Агент не запустился. Проверьте команду агента в конфигурации и лог.
              <span className="grow" />
              <button type="button" className="btn btn-sm" onClick={() => void showLog()}>Лог</button>
              <button type="button" className="btn btn-sm" onClick={reset}>Сбросить статус</button>
            </div>
          )}
          <Composer session={session} active={active} />
          <WhereLine session={session} />
        </div>
      </div>
    </div>
  )
}

function ChatHeader({ session, onLog, onReset, onDelete }: { session: Session; onLog: () => void; onReset: () => void; onDelete: () => void }) {
  const changed = useGit(session.cwd)?.status?.files.length ?? 0
  const task = useStore((s) => (session.taskId ? s.tasks.find((t) => t.id === session.taskId) : undefined))
  const [title, setTitle] = useState(session.title)
  useEffect(() => setTitle(session.title), [session.title])

  const saveTitle = async () => {
    const t = title.trim()
    if (!t || t === session.title) { setTitle(session.title); return }
    const s = await tryApi<Session>('PATCH', `/sessions/${session.id}`, { title: t })
    if (s) setState((st) => ({ sessions: upsert(st.sessions, s) }))
  }

  return (
    <header className="chat-head">
      <StatusIcon session={session} />
      <input
        className="chat-title"
        aria-label="Название чата"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void saveTitle()}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(session.title); e.currentTarget.blur() } }}
      />
      {session.role !== 'solo' && <span className="role" data-role={session.role}>{ROLE[session.role]}</span>}
      <span className="muted nowrap">{statusText(session)}</span>
      {task && (
        <button type="button" className="chip chip-mono" onClick={() => openTask(task.id)} data-tip={task.title}>
          {task.externalId ?? task.id}
        </button>
      )}
      <span className="grow" />
      {session.status === 'running' && (
        <button type="button" className="btn btn-sm" onClick={() => void tryApi('POST', `/sessions/${session.id}/stop`)}>
          <Square />
          Стоп
        </button>
      )}
      <button type="button" className="btn btn-sm" onClick={() => showPanel('changes')} data-tip="Изменения в этом рабочем дереве">
        <GitCompareArrows />
        Изменения
        {changed > 0 && <span className="count count-run">{changed}</span>}
      </button>
      <MenuButton
        label="Ещё"
        icon={<Ellipsis />}
        align="right"
        items={[
          { label: 'Лог агента', icon: <ScrollText />, onSelect: onLog },
          { label: 'Сбросить статус', icon: <RotateCcw />, onSelect: onReset },
          { label: 'Удалить сессию', icon: <Trash2 />, onSelect: onDelete },
        ]}
      />
    </header>
  )
}

/** Under the composer: where this chat runs. */
function WhereLine({ session }: { session: Session }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === session.workspaceId))
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agent))
  const main = ws && normPath(ws.path) === normPath(session.cwd)
  return (
    <div className="chat-meta" data-tip={session.cwd}>
      <span>{agent?.label ?? session.agent}</span>
      {ws && <span>{ws.name}</span>}
      <span className="mono">{basename(session.cwd)}</span>
      <span>{main ? 'основная копия' : 'рабочее дерево'}</span>
      {session.branch && <BranchPicker cwd={session.cwd} branch={session.branch}><Branch name={session.branch} /></BranchPicker>}
    </div>
  )
}

/** Files the agent edited in its last turn, with line counts; click opens the diff. */
function TurnFiles({ messages, cwd }: { messages: Message[]; cwd: string }) {
  const files = useMemo(() => {
    const last = messages.length ? messages[messages.length - 1].turn : -1
    const map = new Map<string, { added: number; removed: number }>()
    for (let i = messages.length - 1; i >= 0 && messages[i].turn === last; i--) {
      const m = messages[i]
      const e = m.kind === 'tool' && m.tool?.status !== 'error' ? fileEdit(m.tool?.input) : null
      if (!e) continue
      const cur = map.get(e.file) ?? { added: 0, removed: 0 }
      map.set(e.file, { added: cur.added + e.added, removed: cur.removed + e.removed })
    }
    return [...map.entries()]
  }, [messages])

  if (!files.length) return null
  const rel = (f: string) => {
    const a = normPath(f)
    const root = normPath(cwd)
    return a.startsWith(`${root}/`) ? f.slice(cwd.replace(/[\\/]+$/, '').length + 1) : f
  }
  return (
    <Disclosure className="turn-files" summary={<>Изменено файлов: {files.length}</>}>
      {files.map(([f, c]) => (
        <button key={f} type="button" className="turn-file" onClick={() => openTab({ kind: 'diff', cwd, path: rel(f) })} data-tip={f}>
          <span className="ellipsis">{basename(f)}</span>
          <span className="muted ellipsis turn-file-dir">{rel(f)}</span>
          <span className="diff-stat num"><span className="add">+{c.added}</span> <span className="del">−{c.removed}</span></span>
        </button>
      ))}
    </Disclosure>
  )
}
