import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Check, Copy, Ellipsis, ExternalLink, KeyRound, GitCompareArrows, MessageSquare, RotateCcw, ScrollText, Square, Trash2 } from 'lucide-react'
import { api, errorText, tryApi } from '../api'
import { openSession, openTask, setState, showPanel, upsert, useFeature, useStore, without } from '../store'
import { loadMessages, loadSubagents } from '../ws'
import { basename, normPath, ROLE } from '../lib/format'
import { useGit } from '../lib/git'
import { useElapsed, useStartingLabel } from '../lib/live'
import { useSdd } from '../lib/sdd'
import { loadDraft, saveDraft } from '../lib/draft'
import { VerdictChip } from '../components/panel/VerdictsTab'
import type { Message, Session } from '../types'
import { Branch, Loading, Skeleton, StatusIcon, statusText } from '../components/bits'
import { MenuButton } from '../components/ui/Menu'
import { BranchPicker } from '../components/pickers/BranchPicker'
import { MessageItem } from '../components/chat/MessageItem'
import { ActivityLine, buildItems, StallBanner, ToolRun, TurnFiles, TurnHead } from '../components/chat/Turn'
import { sessionVisualState } from '../lib/sessionState'
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
  // Reading position survives a reload: distance from the bottom, saved when the page goes away.
  const fromBottom = useRef(0)
  const restored = useRef(false)
  const anchor = useRef<number | null>(null) // distance from the bottom kept while older messages are added on top
  const seenKey = `seen:${id}`
  const [newSince, setNewSince] = useState<number | null>(() => loadDraft<number>(seenKey))
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) setNewSince(loadDraft<number>(seenKey)) // re-shown: a fresh «НОВОЕ» mark
    wasActive.current = active
  }, [active, seenKey])
  useEffect(() => {
    const save = () => saveDraft(`scroll:${id}`, fromBottom.current > 48 ? Math.round(fromBottom.current) : null)
    window.addEventListener('pagehide', save)
    return () => window.removeEventListener('pagehide', save)
  }, [id])

  const subagentsOn = useFeature('subagents')
  useEffect(() => { if (subagentsOn) void loadSubagents(id) }, [id, subagentsOn])

  useEffect(() => {
    if (messages) return
    setLoadError(null)
    loadMessages(id).catch((e) => setLoadError(errorText(e)))
  }, [id, messages])

  const list = messages ?? EMPTY
  const running = session?.status === 'running'
  const starting = useStartingLabel(session ?? PLACEHOLDER)
  const lastText = list.length ? list[list.length - 1].text.length : 0
  const lastAt = list.length ? list[list.length - 1].at : 0
  const hidden = Math.max(0, list.length - limit)
  const visible = useMemo(() => (hidden ? list.slice(hidden) : list), [list, hidden])
  const runningTurn = running && list.length ? list[list.length - 1].turn : null
  const items = useMemo(() => buildItems(visible, runningTurn, newSince, session?.lastActivityAt), [visible, runningTurn, newSince, session?.lastActivityAt])

  // Read up to here: remembered for the next «НОВОЕ» mark.
  useEffect(() => { if (active && atBottom && stick.current && lastAt) saveDraft(seenKey, lastAt) }, [active, atBottom, lastAt, seenKey])
  // «Показать ранее» adds messages on top: keep what the user was looking at in place.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && anchor.current !== null) { el.scrollTop = el.scrollHeight - anchor.current; anchor.current = null }
  }, [limit])

  // Follow new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !active) return
    if (!restored.current && list.length) {
      restored.current = true
      const mark = el.querySelector<HTMLElement>('.new-divider')
      if (mark && mark.offsetTop < el.scrollHeight - el.clientHeight) { // unread messages below the fold: start at the mark
        el.scrollTop = mark.offsetTop - 48
        stick.current = false
        setAtBottom(false)
        return
      }
      const saved = loadDraft<number>(`scroll:${id}`)
      if (saved) {
        el.scrollTop = el.scrollHeight - el.clientHeight - saved
        fromBottom.current = saved
        stick.current = false
        setAtBottom(false)
        return
      }
    }
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [list.length, lastText, active, running, id])

  if (!session) return <Loading label="Загрузка сессии…" />

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    fromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight
    const bottom = fromBottom.current < 48
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

  const showOlder = () => {
    const el = scroller.current
    anchor.current = el ? el.scrollHeight - el.scrollTop : null
    setLimit(limit + PAGE)
  }

  return (
    <div className="chat">
      <ChatHeader session={session} onLog={showLog} onReset={reset} onDelete={() => void remove()} />
      <SddStrip cwd={session.cwd} />
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
            <button type="button" className="btn btn-ghost btn-sm chat-older" onClick={showOlder}>
              Показать ранее ({hidden})
            </button>
          )}
          {items.map((it) => {
            switch (it.kind) {
              case 'msg': return <MessageItem key={it.key} m={it.m} until={it.until} fresh={it.m.at > shownAt.current} />
              case 'tools': return <ToolRun key={it.key} msgs={it.msgs} cwd={session.cwd} live={running} />
              case 'head': return <TurnHead key={it.key} start={it.start} end={it.end} />
              case 'files': return <TurnFiles key={it.key} msgs={it.msgs} cwd={session.cwd} />
              case 'new': return <div key={it.key} className="new-divider" role="separator" aria-label="Новые сообщения"><span>Новое</span></div>
            }
          })}
          {running && session.phase === 'auth' ? <AuthCard session={session} messages={list} />
            : running && <ActivityLine session={session} list={list} starting={starting} />}
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
          {sessionVisualState(session) === 'stalled' && <StallBanner session={session} />}
          {session.status === 'error' && (
            <div className="chat-alert" role="alert">
              Агент не запустился. Проверьте команду агента в конфигурации и лог.
              <span className="grow" />
              <button type="button" className="btn btn-sm" onClick={() => void showLog()}>Лог</button>
              <button type="button" className="btn btn-sm" onClick={reset}>Сбросить статус</button>
            </div>
          )}
          {session.virtual ? (
            <div className="virtual-bar">
              <span>Внутренний субагент GigaCode: писать можно в родительский чат.</span>
              {session.parentId && <button type="button" className="btn btn-sm" onClick={() => openSession(session.parentId!)}>Открыть родительский чат</button>}
            </div>
          ) : <Composer session={session} active={active} />}
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
/** GigaCode opened a browser login: the link, a copy button and a timer; the run continues by itself after login. */
function AuthCard({ session, messages }: { session: Session; messages: Message[] }) {
  const link = [...messages].reverse().find((m) => m.link)?.link ?? null
  const sec = useElapsed(session.lastActivityAt, true)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!link) return
    try { await navigator.clipboard.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
  }
  return (
    <div className="auth-wait" role="status">
      <div className="auth-wait-head">
        <KeyRound aria-hidden />
        <strong>GigaCode ждёт авторизацию</strong>
        <span className="muted num">{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}</span>
      </div>
      <p className="muted">Войдите по ссылке в браузере: после входа запуск продолжится сам.</p>
      {link ? (
        <div className="auth-wait-actions">
          <a className="btn btn-primary" href={link} target="_blank" rel="noreferrer noopener"><ExternalLink />Открыть ссылку</a>
          <button type="button" className="btn" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? 'Скопировано' : 'Скопировать'}</button>
          <span className="mono muted ellipsis auth-link" data-tip={link}>{link}</span>
        </div>
      ) : <p className="muted">Ссылка появится, как только CLI её выведет.</p>}
    </div>
  )
}

/** /full-task in this worktree: plan, progress and the latest step verdict; click opens «Вердикты». */
function SddStrip({ cwd }: { cwd: string }) {
  const plans = useSdd(cwd)
  const p = plans?.[plans.length - 1]
  if (!p) return null
  const done = p.progress.items.filter((i) => /done|готов|pass|\[x\]/i.test(i.status)).length
  const last = p.verdicts[p.verdicts.length - 1]
  return (
    <button type="button" className="sdd-strip" onClick={() => showPanel('verdicts')} data-tip="Открыть вердикты">
      <span className="sdd-plan ellipsis">{p.name}</span>
      {p.progress.items.length > 0 && <span className="muted num">{done}/{p.progress.items.length} шагов</span>}
      {last && <><span className="muted">шаг {last.n}</span><VerdictChip status={last.status} /></>}
    </button>
  )
}
