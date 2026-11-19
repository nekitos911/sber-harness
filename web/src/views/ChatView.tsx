import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Check, Copy, Ellipsis, ExternalLink, FolderPlus, KeyRound, Link2, ShieldCheck, Wrench, X, GitCompareArrows, MessageSquare, RotateCcw, ScrollText, Square, Trash2 } from 'lucide-react'
import { api, errorText, tryApi } from '../api'
import { getState, openDialog, openScreen, openSession, openTask, setState, showPanel, useFeature, useStore, upsertSession } from '../store'
import { loadMessages, loadSubagents } from '../ws'
import { basename, normPath, plural, ROLE } from '../lib/format'
import { useGit } from '../lib/git'
import { useElapsed, useStartingLabel } from '../lib/live'
import { planDone, useSdd } from '../lib/sdd'
import { loadDraft, saveDraft } from '../lib/draft'
import { VerdictChip } from '../components/panel/VerdictsTab'
import type { Message, Session } from '../types'
import { Branch, Loading, Skeleton, StatusIcon, statusText } from '../components/bits'
import { MenuButton } from '../components/ui/Menu'
import { Button, Chip, IconButton, Popover } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'
import { ReworkPopover } from '../components/board/Rework'
import { BranchPicker } from '../components/pickers/BranchPicker'
import { MessageItem } from '../components/chat/MessageItem'
import { ActivityLine, buildItems, StallBanner, ToolRun, TurnFiles, TurnHead } from '../components/chat/Turn'
import { isMcpStatus, mcpServers } from '../lib/toolRun'
import { sessionVisualState } from '../lib/sessionState'
import { ownerWorkspace } from '../lib/actions'
import { archiveSession, dismissSession, unseenReply } from '../lib/sessionActions'
import { Composer } from '../components/chat/Composer'
import { WorkersPanel } from '../components/chat/WorkersPanel'

const PAGE = 200
const PLACEHOLDER = { status: 'idle', phase: null, lastActivityAt: 0 } as Session // hooks run before the session is known
const EMPTY: Message[] = []

/**
 * A restart cut this chat's turn: continue it here, or let it go («Не нужно») — either way it leaves «Ждут вас»; the
 * «Восстановление сессий» window does the same for many at once.
 */
function InterruptedBar({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false)
  const act = async (what: 'resume' | 'dismiss') => {
    setBusy(true)
    await tryApi('POST', `/recovery/${what}`, { sessionIds: [session.id] })
    setBusy(false)
  }
  return (
    <div className="chat-alert chat-alert-soft" role="status">
      <span>Ход прервал перезапуск harness{session.interrupted?.lastActivity ? <> — на шаге <span className="mono">{session.interrupted.lastActivity}</span></> : null}. Продолжить с того же места?</span>
      <span className="grow" />
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('resume')}>Продолжить</button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act('dismiss')}>Не нужно</button>
    </div>
  )
}

export function ChatView({ id, active }: { id: string; active: boolean }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === id))
  const messages = useStore((s) => s.messages[id])
  // a key of this chat's own helpers (what the panel shows changes it); the list itself is read when the key changes
  const kidsKey = useStore((s) => s.sessions.filter((x) => x.parentId === id && !x.archived).map((x) => `${x.id}:${x.status}:${x.waitingFor ?? ''}:${x.title}:${x.lastActivityAt}`).join('|'))
  // archived ones (settled sub-agents once the turn is over) leave the panel; their chats open from the transcript card.
  // Once this chat's turn is over only children still working or waiting stay — a finished one in its own worktree is
  // not archived (a per-service orchestrator lives on), it is in the sidebar under that worktree.
  const parentBusy = useStore((s) => s.sessions.find((x) => x.id === id)?.status === 'running')
  const workers = useMemo(() => getState().sessions.filter((s) => s.parentId === id && !s.archived && (parentBusy || s.status === 'running' || !!s.waitingFor)), [kidsKey, id, parentBusy]) // eslint-disable-line react-hooks/exhaustive-deps
  const [loadError, setLoadError] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [log, setLog] = useState<string | null>(null)

  const shownAt = useRef(0) // messages newer than the first render of the transcript fade in; history does not
  if (messages && !shownAt.current) shownAt.current = Date.now()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  // Opening (or coming back to) a chat starts at «Новое» when something unread is there, else at the bottom.
  const restored = useRef(false)
  const anchor = useRef<number | null>(null) // distance from the bottom kept while older messages are added on top
  const seenKey = `seen:${id}`
  // «НОВОЕ» marks what arrived while the chat was not on screen: last read time, taken when it is shown.
  const [mark, setMark] = useState(() => ({ since: loadDraft<number>(seenKey), at: Date.now() }))
  const [wasActive, setWasActive] = useState(active)
  if (active !== wasActive) { // re-shown: a fresh mark, set during render so the first frame already has it
    setWasActive(active)
    if (active) { setMark({ since: loadDraft<number>(seenKey), at: Date.now() }); restored.current = false }
  }
  // The panel above the composer (workers, banners) grows and shrinks: a chat that follows output stays at the bottom.
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bottomRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { const sc = scroller.current; if (sc && stick.current) sc.scrollTop = sc.scrollHeight })
    ro.observe(el)
    return () => ro.disconnect()
  }, [session?.id])
  // Sending always goes to the bottom, wherever the user had scrolled.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return
      const el = scroller.current
      stick.current = true
      setAtBottom(true)
      if (el) el.scrollTop = el.scrollHeight
    }
    window.addEventListener('harness:sent', on)
    return () => window.removeEventListener('harness:sent', on)
  }, [id])

  const subagentsOn = useFeature('subagents')
  const reviveOn = useFeature('revive')
  useEffect(() => { if (subagentsOn) void loadSubagents(id) }, [id, subagentsOn])

  useEffect(() => {
    if (messages) return
    setLoadError(null)
    loadMessages(id).catch((e) => setLoadError(errorText(e)))
  }, [id, messages])

  const list = messages ?? EMPTY
  // A turn whose answer is complete (turnClosing) reads as finished: no activity line, the header says «Работал».
  const running = session?.status === 'running' && !session.turnClosing
  const starting = useStartingLabel(session ?? PLACEHOLDER)
  const lastText = list.length ? list[list.length - 1].text.length : 0
  const lastAt = list.length ? list[list.length - 1].at : 0
  const hidden = Math.max(0, list.length - limit)
  const visible = useMemo(() => (hidden ? list.slice(hidden) : list), [list, hidden])
  const runningTurn = running && list.length ? list[list.length - 1].turn : null
  // Messages that arrive while you watch are not «new»: no mark unless something unread was already there.
  const newSince = mark.since !== null && visible.some((m) => m.kind !== 'user' && m.at > mark.since! && m.at <= mark.at) ? mark.since : null
  const items = useMemo(() => buildItems(visible, runningTurn, newSince, session?.lastActivityAt), [visible, runningTurn, newSince, session?.lastActivityAt])

  // its answer is seen once the chat is on screen: out of «Ждут вас» (now, or when the browser tab comes back)
  const unseen = !!session && unseenReply(session)
  useEffect(() => {
    if (!active || !unseen) return
    const look = () => { if (document.visibilityState === 'visible') { const s = getState().sessions.find((x) => x.id === id); if (s) void dismissSession(s) } }
    look()
    document.addEventListener('visibilitychange', look)
    return () => document.removeEventListener('visibilitychange', look)
  }, [active, unseen, id])
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
      stick.current = true
    }
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [list.length, lastText, active, running, id, newSince])

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

  const showOlder = () => {
    const el = scroller.current
    anchor.current = el ? el.scrollHeight - el.scrollTop : null
    setLimit(limit + PAGE)
  }

  return (
    <div className="chat">
      <ChatHeader session={session} onLog={showLog} onReset={reset} onDelete={() => openDialog({ kind: 'session-delete', id })} />
      <SddStrip cwd={session.cwd} sessionId={session.id} />
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
              case 'msg': return <MessageItem key={it.key} m={it.m} until={it.until} count={it.count} fresh={it.m.at > shownAt.current} />
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

      <div className="chat-bottom" ref={bottomRef}>
        {!atBottom && (
          <button type="button" className="btn to-bottom" onClick={toBottom}>
            <ArrowDown />
            к последнему
          </button>
        )}
        <div className="chat-col">
          <WorkersPanel sessionId={id} workers={workers} />
          {sessionVisualState(session) === 'stalled' && <StallBanner session={session} />}
          <SlowStartHint session={session} />
          {session.interrupted && session.status !== 'running' && <InterruptedBar session={session} />}
          {session.status === 'error' && (
            <div className="chat-alert" role="alert">
              {errorLine(session, list)}
              <span className="grow" />
              {reviveOn && <button type="button" className="btn btn-sm btn-primary" onClick={() => void tryApi('POST', `/sessions/${session.id}/revive`)} data-tip="Продолжить с того места, где оборвался"><RotateCcw />Повторить</button>}
              <button type="button" className="btn btn-sm" onClick={() => void showLog()}>Лог</button>
              <button type="button" className="btn btn-sm" onClick={reset}>Сбросить статус</button>
            </div>
          )}
          {session.archived ? (
            <div className="virtual-bar">
              <span>Чат в архиве — только чтение.</span>
              <button type="button" className="btn btn-sm" onClick={() => void archiveSession(session, false)}>Вернуть из архива</button>
            </div>
          ) : session.virtual ? (
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
  const changed = useGit(session.cwd)?.status?.files.filter((f) => !f.service).length ?? 0
  const changesOpen = useStore((s) => s.panel && s.panelTab === 'changes')
  const dirsOn = useFeature('include-dirs')
  const reworkOn = useFeature('rework')
  const bindOn = useFeature('bind-task')
  const [reworkOpen, setReworkOpen] = useState(false)
  const reworkRef = useRef<HTMLButtonElement>(null)
  const task = useStore((s) => (session.taskId ? s.tasks.find((t) => t.id === session.taskId) : undefined))
  // who started it: a sub-agent's chat says whose it is (a re-tasked reviewer once read as «исполнитель» from nowhere)
  const parent = useStore((s) => (session.parentId ? s.sessions.find((x) => x.id === session.parentId) : undefined))
  const [title, setTitle] = useState(session.title)
  useEffect(() => setTitle(session.title), [session.title])

  const saveTitle = async () => {
    const t = title.trim()
    if (!t || t === session.title) { setTitle(session.title); return }
    const s = await tryApi<Session>('PATCH', `/sessions/${session.id}`, { title: t })
    if (s) setState((st) => ({ sessions: upsertSession(st.sessions, s) }))
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
      {session.role !== 'solo' && <span className="role" data-role={session.role}>{session.ephemeral ? 'субагент' : ROLE[session.role]}</span>}
      {parent && (
        <button type="button" className="chip chat-parent" data-tip={`Его запустил чат «${parent.title || parent.id}»: туда приходят его результаты. Открыть`} onClick={() => openSession(parent.id)}>
          <MessageSquare aria-hidden /><span className="ellipsis">{parent.title || parent.id}</span>
        </button>
      )}
      <span className="muted nowrap">{statusText(session)}</span>
      {task && (
        <button type="button" className="chip chip-mono" onClick={() => openTask(task.id)} data-tip={task.title}>
          {task.externalId ?? task.id}
        </button>
      )}
      <span className="grow" />
      <McpChip sessionId={session.id} />
      {dirsOn && !session.virtual && <IncludeDirs session={session} />}
      {reworkOn && task && session.status !== 'running' && session.role !== 'reviewer' && !session.virtual && (
        <>
          <button ref={reworkRef} type="button" className="btn btn-sm" onClick={() => setReworkOpen(true)} data-tip="Отправить задачу агенту на доработку">
            <Wrench />
            Доработать
          </button>
          <ReworkPopover task={task} anchor={reworkRef} open={reworkOpen} onClose={() => setReworkOpen(false)} />
        </>
      )}
      {session.status === 'running' && (
        <button type="button" className="btn btn-sm" onClick={() => void tryApi('POST', `/sessions/${session.id}/stop`)}>
          <Square />
          Стоп
        </button>
      )}
      {!changesOpen && ( // the panel itself is on screen: no second «Изменения N» beside it
        <button type="button" className="btn btn-sm" onClick={() => showPanel('changes')} data-tip="Изменения в этом рабочем дереве">
          <GitCompareArrows />
          Изменения
          {changed > 0 && <span className="count count-run">{changed}</span>}
        </button>
      )}
      <MenuButton
        label="Ещё"
        icon={<Ellipsis />}
        align="right"
        items={[
          ...(session.allowedTools !== undefined ? [{ label: 'Разрешения этого чата…', icon: <ShieldCheck />, onSelect: () => openDialog({ kind: 'session-perms', id: session.id }) }] : []),
          ...(bindOn && session.kind === 'chat' && !session.taskId && !session.virtual ? [{ label: 'Привязать задачу…', icon: <Link2 />, onSelect: () => openDialog({ kind: 'bind-task', id: session.id }) }] : []),
          { label: 'Лог агента', icon: <ScrollText />, onSelect: onLog },
          { label: 'Сбросить статус', icon: <RotateCcw />, onSelect: onReset },
          { label: 'Удалить сессию', icon: <Trash2 />, onSelect: onDelete },
        ]}
      />
    </header>
  )
}

/** «MCP 4/5»: the CLI's MCP servers from the latest status line; the list with ✗ reasons on click. */
function McpChip({ sessionId }: { sessionId: string }) {
  const status = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.mcpStatus)
  const line = useStore((s) => {
    const list = s.messages[sessionId] ?? []
    for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === 'system' && isMcpStatus(list[i].text)) return list[i].text
    return null
  })
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  // session.mcpStatus from newer servers; older ones only wrote the «MCP: …» line into the chat
  const servers = status?.map((m) => ({ name: m.name, ok: /^connected$/i.test(m.status), reason: m.status })) ?? (line ? mcpServers(line) : [])
  const ok = servers.filter((x) => x.ok).length
  if (!servers.length || ok === servers.length) return null // all running: nothing to say (the status bar has the list)
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-sm mcp-chip" data-bad={ok < servers.length || undefined} aria-expanded={open} onClick={() => setOpen(!open)}
        data-tip={ok < servers.length ? 'Не все MCP-серверы запустились' : 'MCP-серверы запущены'}>
        MCP {ok}/{servers.length}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" label="MCP-серверы" className="mcp-pop">
        <ul className="mcp-pop-list">
          {servers.map((x) => (
            <li key={x.name} data-bad={!x.ok || undefined}>
              {x.ok ? <Check aria-hidden /> : <X aria-hidden />}
              <span className="mono">{x.name}</span>
              {!x.ok && <span className="muted">{x.reason ?? 'не запустился'}</span>}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  )
}

/** Extra directories the CLI may use (like /dir add): chips with ×, «+ папка»; applies from the next message. */
function IncludeDirs({ session }: { session: Session }) {
  const dirs = session.includeDirs ?? []
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const save = async (next: string[]) => {
    const s = await tryApi<Session>('PATCH', `/sessions/${session.id}`, { includeDirs: next })
    if (s) setState((st) => ({ sessions: upsertSession(st.sessions, s) }))
  }
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}
        data-tip={dirs.length ? dirs.join('\n') : 'Дать агенту доступ к другим папкам'}>
        <FolderPlus />
        {dirs.length ? `Доп. папки: ${dirs.length}` : 'Папки'}
      </button>
      <Popover anchor={anchor} open={open && !picking} onClose={() => setOpen(false)} placement="bottom-end" label="Дополнительные папки" className="dirs-pop">
        <div className="dirs-list">
          {dirs.map((d) => <Chip key={d} mono tip={d} onRemove={() => void save(dirs.filter((x) => x !== d))} removeLabel={`Убрать ${d}`}>{basename(d)}</Chip>)}
          {!dirs.length && <span className="muted">Только папка чата.</span>}
        </div>
        <Button size="sm" icon={<FolderPlus />} onClick={() => setPicking(true)}>Добавить папку</Button>
        <p className="field-hint">Как /dir add в CLI: действует со следующего сообщения.</p>
      </Popover>
      {picking && (
        <FolderPicker title="Дополнительная папка" onClose={() => setPicking(false)}
          onPick={(p) => { setPicking(false); if (!dirs.includes(p)) void save([...dirs, p]) }} />
      )}
    </>
  )
}

/**
 * Headless transport restarts the CLI and every MCP server for each message: after three slow starts (> 10 s) in this
 * chat, suggest ACP once (only when the server offers it).
 */
function SlowStartHint({ session }: { session: Session }) {
  const acpOn = useFeature('acp')
  const starts = useStore((s) => s.slowStarts[session.id])
  const transport = useStore((s) => s.settings?.agents[session.agent]?.transport ?? 'headless')
  const [hidden, setHidden] = useState(() => !!loadDraft<boolean>('hint:acp'))
  if (!acpOn || hidden || transport === 'acp' || !starts || starts.length < 3 || starts.some((ms) => ms <= 10_000)) return null
  const close = () => { saveDraft('hint:acp', true); setHidden(true) }
  return (
    <div className="chat-hint" role="note">
      <span>Каждое сообщение заново запускает GigaCode и MCP-серверы. Включите режим ACP в настройках — процесс будет оставаться запущенным.</span>
      <span className="grow" />
      <button type="button" className="btn btn-sm" onClick={() => { close(); openScreen('settings') }}>Открыть настройки</button>
      <IconButton size="sm" label="Больше не показывать" icon={<X />} onClick={close} />
    </div>
  )
}

/** Under the composer: where this chat runs. */
function WhereLine({ session }: { session: Session }) {
  // The project is the one whose worktree the chat runs in (a folder workspace may contain other projects' worktrees).
  const ws = useStore((s) => {
    const byWt = Object.entries(s.worktrees).find(([, list]) => list.some((w) => normPath(w.path) === normPath(session.cwd)))?.[0]
    return s.workspaces.find((w) => w.id === byWt) ?? s.workspaces.find((w) => w.id === session.workspaceId) ?? ownerWorkspace(s.workspaces, session.cwd)
  })
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agent))
  // «GigaCode · Все проекты (IdeaProjects)» / «GigaCode · project · branch or folder» — never one name twice.
  const parts: string[] = [agent?.label ?? session.agent]
  if (ws?.kind === 'root') parts.push(`Все проекты (${basename(ws.path)})`)
  else if (ws) parts.push(ws.name)
  const here = basename(session.cwd)
  const showFolder = !session.branch && ws?.kind !== 'root' && !parts.includes(here) && (!ws || normPath(ws.path) !== normPath(session.cwd))
  return (
    <div className="chat-meta" data-tip={session.cwd}>
      {parts.map((p) => <span key={p}>{p}</span>)}
      {showFolder && <span className="mono">{here}</span>}
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
function SddStrip({ cwd, sessionId }: { cwd: string; sessionId: string }) {
  const plans = useSdd(cwd, sessionId) // only the plans of this chat (its task, the files it changed)
  const p = plans?.[plans.length - 1]
  if (!p) return null
  const done = planDone(p)
  const last = p.verdicts[p.verdicts.length - 1]
  return (
    <button type="button" className="sdd-strip" onClick={() => showPanel('verdicts')} data-tip="Открыть вердикты">
      <span className="sdd-plan ellipsis">{p.name}</span>
      {p.progress.items.length > 0 && <span className="muted num">{done === null ? `${p.progress.items.length} ${plural(p.progress.items.length, 'пункт', 'пункта', 'пунктов')}` : `${done}/${p.progress.items.length} шагов`}</span>}
      {last && <><span className="muted">шаг {last.n}</span><VerdictChip status={last.status} /></>}
    </button>
  )
}

/**
 * Why the chat stopped: only a session that never produced output «не запустился» (check the command); a failed turn
 * says what happened (no first event in time, a stall, a forced exit, a crash) in the words of its error message.
 */
function errorLine(s: Session, list: Message[]): string {
  if (s.errorKind === 'not_started') return 'Агент не запустился. Проверьте команду агента в конфигурации и лог.'
  // «Агент завершился с ошибкой (код 1):» is followed by the CLI's own words on the next line
  const last = [...list].reverse().find((m) => m.kind === 'error')?.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 240)
  return last ? `Ход прервался: ${last}` : 'Ход завершился с ошибкой — подробности в логе.'
}
