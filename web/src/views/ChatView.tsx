import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Bot, Check, Copy, Ellipsis, ExternalLink, FolderOpen, FolderPlus, LayoutList, Search, KeyRound, Link2, LoaderCircle, ShieldCheck, Wrench, X, GitCompareArrows, MessageSquare, PlugZap, RotateCcw, ScrollText, Square, Trash2, TriangleAlert } from 'lucide-react'
import { api, errorText, tryApi } from '../api'
import { closeTab, getState, openDialog, openScreen, openSession, openTask, setState, showPanel, toast, useFeature, useStore, upsertSession } from '../store'
import { loadMessages, loadSubagents } from '../ws'
import { basename, normPath, plural, ROLE } from '../lib/format'
import { useGit } from '../lib/git'
import { useCliLive, useCountdown, useElapsed, useStartingLabel } from '../lib/live'
import { planDone, useSdd } from '../lib/sdd'
import { loadDraft, saveDraft } from '../lib/draft'
import { VerdictChip } from '../components/panel/VerdictsTab'
import type { Message, Session } from '../types'
import { Branch, Loading, Skeleton, StatusIcon, statusText } from '../components/bits'
import { MenuButton, PointMenu, type MenuItem } from '../components/ui/Menu'
import { openFile, REVEAL } from '../components/WorktreeMenu'
import { isMac } from '../lib/keys'
import { Button, Chip, IconButton, Popover } from '../components/ui'
import { FolderPicker } from '../components/FolderPicker'
import { ReworkPopover } from '../components/board/Rework'
import { BranchPicker } from '../components/pickers/BranchPicker'
import { MessageItem } from '../components/chat/MessageItem'
import { ActivityLine, buildItems, StallBanner, ToolRun, TurnFiles, TurnHead } from '../components/chat/Turn'
import { isMcpStatus, mcpServers } from '../lib/toolRun'
import { sessionVisualState } from '../lib/sessionState'
import { ownerWorkspace } from '../lib/actions'
import { archiveSession, CLI_LIVE_TIP, dismissSession, NEW_CLI_SESSION_TIP, newCliSession, reconnectMcp, unseenDone, unseenReply } from '../lib/sessionActions'
import { Composer } from '../components/chat/Composer'
import { WorkersPanel } from '../components/chat/WorkersPanel'
import { FindBar } from '../components/chat/FindBar'
import { Markdown } from '../components/Markdown'
import { arrived, dropOutgoing, retryOutgoing, useOutbox, type Outgoing } from '../lib/outbox'
import { splitAttachments } from '../lib/attachments'
import { modKey } from '../lib/keys'
import { descendants, firstTask } from '../lib/overview'
import { chatTask, TaskFold } from '../components/panel/OverviewTab'

const PAGE = 100 // messages drawn at first; scrolling up brings the next page (opening a 800-message chat drew 200 at once)
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
      <span>Ход прервал перезапуск harness{session.interrupted?.lastActivity ? <> на шаге <span className="mono">{session.interrupted.lastActivity}</span></> : null}. Продолжить с того же места?</span>
      <span className="grow" />
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('resume')}>Продолжить</button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act('dismiss')}>Не нужно</button>
    </div>
  )
}

export function ChatView({ id, active }: { id: string; active: boolean }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === id))
  const messages = useStore((s) => s.messages[id])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [log, setLog] = useState<string | null>(null)
  const outbox = useOutbox()
  const chatRoot = useRef<HTMLDivElement>(null)
  const [find, setFind] = useState(0) // 0: no find bar; each Ctrl+F counts up (the bar's input takes focus again)
  // Ctrl/⌘+F finds in this chat when the focus is in it (or nowhere); elsewhere the key stays the browser's / the panel's
  useEffect(() => {
    if (!active) return
    const on = (e: KeyboardEvent) => {
      if (!modKey(e) || e.code !== 'KeyF' || e.shiftKey || e.altKey) return
      const root = chatRoot.current
      const t = e.target as Node
      if (!root || !(root.contains(t) || (t === document.body && root.getClientRects().length)) || document.querySelector('dialog[open]')) return
      e.preventDefault()
      setFind((n) => n + 1)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [active])

  const shownAt = useRef(0) // messages newer than the first render of the transcript fade in; history does not
  if (messages && !shownAt.current) shownAt.current = Date.now()
  const scroller = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const syncBottom = useCallback((el: HTMLDivElement) => {
    if (!el.clientHeight) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stick.current = bottom
    setAtBottom(bottom)
  }, [])
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
  // Folding a tool or resizing the viewport can reveal the last message without firing a scroll event.
  useEffect(() => {
    const el = scroller.current
    if (!active || !el || !transcript.current) return
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
      syncBottom(el)
    })
    ro.observe(el)
    ro.observe(transcript.current)
    return () => ro.disconnect()
  }, [active, session?.id, syncBottom])
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
  const older = useMemo(() => list.slice(0, hidden).map((m) => m.text), [list, hidden]) // what the find bar may need to show
  const reveal = useCallback((n: number) => setLimit((l) => l + n), [])
  const cliLive = useCliLive(session ?? PLACEHOLDER) && !!session
  const [takenOver, setTakenOver] = useState(false) // «Перехватить» confirmed: this chat's messages go with force
  if (takenOver && !cliLive) setTakenOver(false) // the terminal let go: next time it takes the chat, ask again
  const retryIn = useCountdown(session?.status === 'error' ? session.startRetryAt : null)
  const reconnectOn = useFeature('agent-reconnect')
  const closeFind = useCallback(() => {
    setFind(0)
    chatRoot.current?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus()
  }, [])

  // its answer is seen once the chat is on screen: out of «Ждут вас» (now, or when the browser tab comes back)
  const unseen = !!session && (unseenReply(session) || unseenDone(session))
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

  // A message to show (the task bar's «К началу», «Обзор» → «Хронология»): unfold «Показать ранее» if it is behind it,
  // then scroll to it — or to the nearest message before it that has its own block (tool steps fold into runs).
  const pendingGoto = useRef<string | null>(null)
  const showMsg = (mid: string) => {
    const el = scroller.current
    const col = transcript.current
    if (!el || !col) return
    let target: HTMLElement | null = null
    for (let i = list.findIndex((m) => m.id === mid); i >= 0 && !target; i--) target = col.querySelector<HTMLElement>(`[data-mid="${CSS.escape(list[i].id)}"]`)
    if (!target) { el.scrollTop = 0; return }
    const t = target
    t.scrollIntoView({ block: 'start' })
    requestAnimationFrame(() => t.scrollIntoView({ block: 'start' })) // off-screen blocks get their real height on the first jump
    t.dataset.flash = ''
    window.setTimeout(() => { delete t.dataset.flash }, 1200)
  }
  const jump = (mid: string) => {
    const i = list.findIndex((m) => m.id === mid)
    if (i < 0) return
    stick.current = false
    setAtBottom(false)
    if (i < hidden) { pendingGoto.current = mid; setLimit(list.length - i) } else showMsg(mid)
  }
  const jumpRef = useRef(jump)
  jumpRef.current = jump
  useLayoutEffect(() => {
    if (pendingGoto.current === null) return
    const mid = pendingGoto.current
    pendingGoto.current = null
    showMsg(mid)
  }, [limit]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ sessionId: string; messageId: string }>).detail
      if (d?.sessionId === id) jumpRef.current(d.messageId)
    }
    window.addEventListener('harness:goto', on)
    return () => window.removeEventListener('harness:goto', on)
  }, [id])

  // Follow new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !active) return
    if (!restored.current && list.length) {
      restored.current = true
      const mark = el.querySelector<HTMLElement>('.new-divider')
      const markTop = mark && el.scrollTop + mark.getBoundingClientRect().top - el.getBoundingClientRect().top
      if (markTop !== null && markTop < el.scrollHeight - el.clientHeight) {
        el.scrollTop = markTop - 48
        syncBottom(el)
        return
      }
      stick.current = true
    }
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [list.length, lastText, active, running, id, newSince, syncBottom])

  // scrolled near the top: the next page comes by itself (the button stays for the keyboard and screen readers)
  const olderBtn = useRef<HTMLButtonElement>(null)
  const more = hidden > 0
  useEffect(() => {
    const el = olderBtn.current
    const root = scroller.current
    if (!active || !more || !el || !root) return
    const io = new IntersectionObserver((es) => { if (restored.current && es.some((e) => e.isIntersecting)) olderBtn.current?.click() }, { root, rootMargin: '400px 0px 0px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [active, more, limit])

  // the chat's right-click menu (hooks before the early return below)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const openOn = useFeature('open-file')

  if (!session) return <Loading label="Загрузка сессии…" />
  // sent from this chat and not in it yet (or refused): shown at the end at once
  const outgoing = outbox.filter((o) => o.sessionId === id && (!!o.error || !arrived(o, list, session)))

  const toBottom = () => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    syncBottom(el)
  }

  const showLog = async () => {
    try {
      const res = await api<{ text: string }>('GET', `/sessions/${id}/log`)
      setLog(res.text || 'Лог пуст.')
    } catch (e) {
      setLog(`Не удалось получить лог: ${errorText(e)}`)
    }
  }
  const reset = () => newCliSession(session)
  const reconnect = reconnectOn ? () => void reconnectMcp(session) : undefined
  const chatMenu = (): MenuItem[] => {
    const picked = window.getSelection()?.toString() ?? ''
    const copyText = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`Скопировано: ${what}`, 'ok'), () => toast('Буфер обмена недоступен', 'error'))
    const tab = `s:${session.id}`
    return [
      ...(picked.trim() ? [{ label: 'Копировать', icon: <Copy />, onSelect: () => copyText(picked, 'выделенное') }] : []),
      { label: 'Найти в чате', icon: <Search />, hint: `${isMac ? '⌘' : 'Ctrl'}+F`, onSelect: () => setFind((n) => n + 1) },
      { label: 'Обзор чата', icon: <LayoutList />, onSelect: () => showPanel('overview') },
      { label: 'Изменения', icon: <GitCompareArrows />, onSelect: () => showPanel('changes') },
      ...(reconnect ? [{ label: 'Переподключить MCP', icon: <PlugZap />, divider: true, tip: 'Перезапустить процесс агента: MCP-серверы подключатся заново, контекст чата сохранится', onSelect: reconnect }] : []),
      { label: 'Лог агента', icon: <ScrollText />, divider: !reconnect, onSelect: showLog },
      { label: 'Копировать ID сессии', icon: <Copy />, divider: true, onSelect: () => copyText(session.id, session.id) },
      { label: 'Копировать путь папки', icon: <Copy />, onSelect: () => copyText(session.cwd, session.cwd) },
      ...(openOn ? [{ label: REVEAL, icon: <FolderOpen />, onSelect: () => openFile(session.cwd, 'reveal') }] : []),
      { label: 'Закрыть вкладку', icon: <X />, danger: true, divider: true, hint: `${isMac ? '⌘' : 'Ctrl'}+W`, onSelect: () => { closeTab(session.worktreePath || session.cwd, tab); closeTab(session.cwd, tab) } },
    ]
  }
  const takeOver = () => openDialog({
    kind: 'confirm', title: 'Перехватить чат у терминала?', ok: 'Перехватить',
    text: 'GigaCode сейчас ведёт этот чат в терминале. Сообщение отсюда пойдёт в ту же сессию CLI и может помешать его работе. Лучше дождаться, пока он закончит.',
    onConfirm: () => setTakenOver(true),
  })

  const showOlder = () => {
    const el = scroller.current
    anchor.current = el ? el.scrollHeight - el.scrollTop : null
    setLimit(limit + PAGE)
  }

  return (
    <div className="chat" ref={chatRoot} data-find={find > 0 || undefined}>
      <ChatHeader session={session} cliLive={cliLive} onLog={showLog} onReset={reset} onReconnect={reconnect} onDelete={() => openDialog({ kind: 'session-delete', id })} />
      <SddStrip cwd={session.cwd} sessionId={session.id} />
      {log !== null && (
        <div className="chat-log">
          <div className="row"><strong>Лог агента (stderr)</strong><span className="grow" /><button type="button" className="btn btn-ghost btn-sm" onClick={() => setLog(null)}>Скрыть</button></div>
          <pre>{log}</pre>
        </div>
      )}

      {/* its own row above the find bar's anchor: the bar never covers the find bar or the messages */}
      <TaskBar session={session} list={list} onTop={() => list[0] && jump(list[0].id)} />
      {find > 0 && <FindBar root={transcript} focusKey={find} older={older} reveal={reveal} onClose={closeFind} />}
      <PointMenu at={menuAt} onClose={() => setMenuAt(null)} items={menuAt ? chatMenu() : []} label="Чат" />
      {/* right click in the chat (as in Orca): an inner card with its own menu (a file) has handled it already */}
      <div className="chat-scroll" ref={scroller} tabIndex={-1} onScroll={(e) => syncBottom(e.currentTarget)}
        onContextMenu={(e) => { if (e.defaultPrevented || (e.target as HTMLElement).closest('a, input, textarea')) return; e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }) }}>
        <div className="chat-col" ref={transcript} role="log" aria-live="polite" aria-relevant="additions">
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
              <h2>Опишите задачу агенту</h2>
              <p><kbd>Enter</kbd> отправляет, <kbd>Shift</kbd>+<kbd>Enter</kbd> переносит строку. Файлы добавляются через @, команды через /.</p>
            </div>
          )}
          {hidden > 0 && (
            <button ref={olderBtn} type="button" className="btn btn-ghost btn-sm chat-older" onClick={showOlder}>
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
          {outgoing.map((o) => <OutgoingItem key={o.id} o={o} />)}
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
          <WorkersPanel sessionId={id} />
          {sessionVisualState(session) === 'stalled' && <StallBanner session={session} />}
          <SlowStartHint session={session} />
          {session.interrupted && session.status !== 'running' && <InterruptedBar session={session} />}
          {session.status === 'error' && (
            <div className="chat-alert" role="alert">
              <span className="chat-alert-text">{retryIn > 0 ? `Агент не запустился вовремя. Повторю запуск сам через ${retryIn} с` : errorLine(session, list)}</span>
              <span className="chat-alert-actions">
                {reviveOn && <button type="button" className="btn btn-sm btn-primary" onClick={() => void tryApi('POST', `/sessions/${session.id}/revive`)} data-tip="Продолжить с того места, где оборвался"><RotateCcw />Повторить</button>}
                <button type="button" className="btn btn-sm" onClick={() => void showLog()}>Лог</button>
                {reconnect && <button type="button" className="btn btn-sm" onClick={reconnect} data-tip="Перезапустить процесс агента: MCP-серверы подключатся заново, контекст чата сохранится"><PlugZap />Переподключить MCP</button>}
                <button type="button" className="btn btn-sm" onClick={reset} data-tip={NEW_CLI_SESSION_TIP}>Новая сессия CLI</button>
              </span>
            </div>
          )}
          {session.archived ? (
            <div className="virtual-bar">
              <span>Чат в архиве: только чтение.</span>
              <button type="button" className="btn btn-sm" onClick={() => void archiveSession(session, false)}>Вернуть из архива</button>
            </div>
          ) : session.virtual ? (
            <div className="virtual-bar">
              <span>Внутренний субагент GigaCode: писать можно в родительский чат.</span>
              {session.parentId && <button type="button" className="btn btn-sm" onClick={() => openSession(session.parentId!)}>Открыть родительский чат</button>}
            </div>
          ) : cliLive && !takenOver ? (
            <div className="virtual-bar" role="status">
              <span>Этот чат сейчас ведёт GigaCode в терминале. Чтобы не помешать, пишите сюда, когда он закончит.</span>
              <button type="button" className="btn btn-sm" onClick={takeOver} data-tip="Писать отсюда, не дожидаясь терминала">Перехватить</button>
            </div>
          ) : <Composer session={session} active={active} force={cliLive} />}
          <WhereLine session={session} />
        </div>
      </div>
    </div>
  )
}

/** Above the transcript: the chat's original task in one line; unfolded (remembered per chat) its whole text. */
function TaskBar({ session, list, onTop }: { session: Session; list: Message[]; onTop: () => void }) {
  const task = useStore((s) => (session.taskId ? s.tasks.find((t) => t.id === session.taskId) : undefined))
  const key = `taskbar:${session.id}`
  const [open, setOpen] = useState(() => !!loadDraft<boolean>(key))
  const first = firstTask(list)
  const t = useMemo(() => (first ? chatTask(first, task) : null), [first, task])
  if (!t?.head) return null
  return (
    <div className="task-bar">
      <TaskFold head={t.head} full={t.full} onTop={onTop} open={open} onToggle={(o) => { saveDraft(key, o || null); setOpen(o) }} />
    </div>
  )
}

/** A message on its way (or refused): the person's bubble at once, «Отправляется…», else the error and «Повторить». */
function OutgoingItem({ o }: { o: Outgoing }) {
  const { text, paths } = splitAttachments(o.text)
  return (
    <div className="msg-wrap msg-out" data-kind="user" data-enter data-failed={!!o.error || undefined}>
      <div className="msg msg-user">
        {paths.length > 0 && <div className="msg-from">Вложений: {paths.length}</div>}
        {text && <Markdown text={text} />}
      </div>
      {o.error ? (
        <div className="msg-out-state" role="alert">
          <TriangleAlert aria-hidden />
          <span>Не отправлено: {o.error}</span>
          <button type="button" className="btn btn-sm" onClick={() => void retryOutgoing(o.id)}><RotateCcw />Повторить</button>
          <IconButton size="sm" label="Убрать сообщение" icon={<X />} onClick={() => dropOutgoing(o.id)} />
        </div>
      ) : (
        <div className="msg-out-state" role="status">
          {!o.sent && <LoaderCircle className="spinner" aria-hidden />}
          <span>{o.sent ? 'Отправлено' : 'Отправляется…'}</span>
        </div>
      )}
    </div>
  )
}

function ChatHeader({ session, cliLive, onLog, onReset, onReconnect, onDelete }: { session: Session; cliLive: boolean; onLog: () => void; onReset: () => void; onReconnect?: () => void; onDelete: () => void }) {
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
  const kids = useStore((s) => descendants(s.sessions, session.id).length)
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
      {kids > 0 && (
        <button type="button" className="chip chat-kids" onClick={() => showPanel('overview')} data-tip="Кто что делал: субагенты, исполнители, их отчёты: вкладка «Обзор»">
          <Bot aria-hidden />{kids} {plural(kids, 'субагент', 'субагента', 'субагентов')}
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
          ...(onReconnect ? [{ label: 'Переподключить MCP', icon: <PlugZap />, tip: 'Перезапустить процесс агента: MCP-серверы подключатся заново, контекст чата сохранится', onSelect: onReconnect }] : []),
          { label: 'Новая сессия CLI', icon: <RotateCcw />, tip: NEW_CLI_SESSION_TIP, onSelect: onReset },
          { label: 'Удалить сессию', icon: <Trash2 />, onSelect: onDelete, ...(cliLive ? { disabled: true, tip: CLI_LIVE_TIP } : {}) },
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
      <span>Каждое сообщение заново запускает GigaCode и MCP-серверы. Включите режим ACP в настройках, и процесс останется запущенным между сообщениями.</span>
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
  const parts: string[] = [agent?.label ?? session.agent]
  if (ws?.kind === 'root') parts.push(basename(ws.path) || ws.path)
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
  return last ? `Ход прервался: ${last}` : 'Ход завершился с ошибкой. Подробности в логе.'
}
