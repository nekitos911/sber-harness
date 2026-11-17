import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, Bot, ChevronDown, Ellipsis, Folder, GitPullRequest, Pin, ChevronRight, FolderGit2, FolderPlus, GitBranch, GitBranchPlus, House, Inbox, MessageSquarePlus, Moon, Search, Settings, SquareKanban, SquareTerminal, Sun } from 'lucide-react'
import { openDialog, openScreen, openSession, openWorktree, setState, showPanel, useActiveCwd, useStore, type Screen } from '../store'
import { useHistory } from '../lib/history'
import { archiveSession, renameSession, sessionMenu } from '../lib/sessionActions'
import { loadWorktrees } from '../ws'
import { useCurrentTool, useStateLine } from '../lib/live'
import { dur, sessionVisualState } from '../lib/sessionState'
import { basename, normPath, plural, relTime, tokens } from '../lib/format'
import { loadDraft, saveDraft } from '../lib/draft'
import { newChat, newTerminal } from '../lib/actions'
import type { Session, Workspace, Worktree } from '../types'
import { Skeleton, StatusIcon, SubStateIcon, subStateLabel } from './bits'
import { BranchPicker } from './pickers/BranchPicker'
import { Menu } from './ui'
import { ideEnabled, isUnread, onWorktreeKey, projectMenu, setUnread, worktreeMenu } from './WorktreeMenu'
import { useNow } from '../lib/useNow'

const depth = (d: number) => ({ '--depth': d }) as CSSProperties
const APP_START = Date.now() // rows for sessions born after this animate in; the initial list does not

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() }
}

export function Sidebar() {
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length)
  const scheme = useStore((s) => s.scheme)
  const width = useStore((s) => s.sidebarWidth)
  const [query, setQuery] = useState('')

  const running = sessions.filter((s) => s.kind === 'chat' && s.status === 'running').length
  const openPrs = useStore((s) => s.tasks.filter((t) => t.pr?.state === 'open').length)
  const chats = sessions.filter((s) => s.kind === 'chat').length
  const allWorktrees = useStore((s) => s.worktrees)
  const tree = useMemo(() => buildTree(sessions.filter((s) => !s.archived), query, allWorktrees), [sessions, query, allWorktrees])
  const filtering = !!query.trim()
  const rootWs = workspaces.find((w) => w.kind === 'root')
  const projects = workspaces.filter((w) => w.kind !== 'root')
  // «Активные»: projects with sessions or a dirty worktree (or the one on screen); the rest wait behind «Ещё N».
  const [showAll, setShowAllState] = useState(() => loadDraft<boolean>('sb:all') ?? false)
  const setShowAll = (v: boolean) => { setShowAllState(v); saveDraft('sb:all', v || null) }
  const activeCwd = useActiveCwd()
  const dirtyIn = useStore((s) => s.worktrees)
  const isActive = (ws: Workspace) =>
    tree.roots.some((x) => tree.owner(x) === ws.id) ||
    (dirtyIn[ws.id] ?? []).some((w) => (w.dirty ?? 0) > 0) ||
    (!!activeCwd && (normPath(activeCwd) === normPath(ws.path) || normPath(activeCwd).startsWith(`${normPath(ws.path)}/`) || (dirtyIn[ws.id] ?? []).some((w) => normPath(w.path) === normPath(activeCwd))))
  const shownProjects = showAll || filtering ? projects : projects.filter(isActive)
  const quiet = showAll || filtering ? [] : projects.filter((w) => !isActive(w))

  return (
    <nav className="sidebar" aria-label="Навигация">
      <div className="sb-search">
        <Search aria-hidden />
        <input className="input" type="search" placeholder="Поиск" aria-label="Поиск по сессиям и проектам" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="nav">
        <NavItem screen="board" icon={<SquareKanban />} label="Задачи" />
        <NavItem
          screen="agents"
          icon={<Bot />}
          label="Агенты"
          end={running > 0
            ? <span className="count count-run" data-tip={`Работают: ${running} из ${chats}`}>{running}</span>
            : chats > 0 && <span className="count" data-tip={`Чатов: ${chats}`}>{chats}</span>}
        />
        <NavItem screen="prs" icon={<GitPullRequest />} label="Пулл-реквесты" end={openPrs > 0 && <span className="count" data-tip={`Открытых PR задач: ${openPrs}`}>{openPrs}</span>} />
        <NavItem screen="inbox" icon={<Inbox />} label="Входящие" end={unread > 0 && <span className="count count-signal" aria-label={`непрочитанных: ${unread}`}>{unread}</span>} />
      </div>

      <div className="tree" aria-label="Проекты и сессии">
        {!filtering && <AttentionSection tree={tree} />}
        {rootWs && <ProjectNode ws={rootWs} tree={tree} filtering={filtering} />}
        <div className="sb-head">
          <span>Проекты <span className="num">· {projects.length}</span></span>
          {projects.length > 1 && (
            <span className="sb-scope" role="group" aria-label="Какие проекты показывать">
              <button type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)} data-tip="С сессиями или изменениями">Активные</button>
              <button type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>Все</button>
            </span>
          )}
          <button type="button" className="icon-btn icon-btn-sm" data-tip="Добавить проект" aria-label="Добавить проект" onClick={() => openDialog({ kind: 'workspace' })}>
            <FolderPlus />
          </button>
        </div>
        {shownProjects.map((ws) => <ProjectNode key={ws.id} ws={ws} tree={tree} filtering={filtering} />)}
        {quiet.length > 0 && (
          <button type="button" className="tree-row tree-more" style={depth(0)} onClick={() => setShowAll(true)}>
            <Ellipsis aria-hidden />
            Ещё {quiet.length} {plural(quiet.length, 'проект', 'проекта', 'проектов')}
            <span className="muted">без сессий и изменений</span>
          </button>
        )}
        {tree.loose.length > 0 && (
          <div className="tree-group">
            <div className="tree-note">Вне проектов</div>
            {tree.loose.map((s) => <SessionNode key={s.id} s={s} kids={tree.kids} base={1} />)}
          </div>
        )}
        {tree.system.length > 0 && <SystemGroup sessions={tree.system} />}
        {workspaces.length === 0 && (
          <div className="sb-empty">
            <p>Добавьте папку проекта: агенты работают в её рабочих деревьях.</p>
            <button type="button" className="btn btn-sm" onClick={() => openDialog({ kind: 'workspace' })}>
              <FolderPlus />
              Добавить проект
            </button>
          </div>
        )}
      </div>

      <div className="sb-foot">
        <NavItem screen="settings" icon={<Settings />} label="Настройки" />
        <span className="grow" />
        <button
          type="button"
          className="icon-btn"
          data-tip={scheme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          aria-label={scheme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
          onClick={() => setState({ theme: scheme === 'dark' ? 'light' : 'dark' })}
        >
          {scheme === 'dark' ? <Sun /> : <Moon />}
        </button>
      </div>

      <button
        type="button"
        className="sb-resize"
        aria-label="Ширина боковой панели"
        data-tip="Потяните, чтобы изменить ширину"
        onPointerDown={(e) => {
          const startX = e.clientX
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          const move = (ev: PointerEvent) => setState({ sidebarWidth: clampWidth(width + ev.clientX - startX) })
          const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', up)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setState({ sidebarWidth: clampWidth(width - 16) })
          if (e.key === 'ArrowRight') setState({ sidebarWidth: clampWidth(width + 16) })
        }}
      />
    </nav>
  )
}

const clampWidth = (w: number) => Math.round(Math.min(520, Math.max(220, w)))

function NavItem({ screen, icon, label, end }: { screen: Screen; icon: ReactNode; label: string; end?: ReactNode }) {
  const active = useStore((s) => s.view.kind === 'screen' && s.view.screen === screen)
  return (
    <button type="button" className="nav-item" aria-current={active ? 'page' : undefined} onClick={() => openScreen(screen)}>
      {icon}
      {label}
      {end && <span className="end">{end}</span>}
    </button>
  )
}

interface Tree {
  owner: (s: Session) => string | null // the project a session shows under: the one whose worktree it runs in, else its workspaceId
  roots: Session[] // chats without a (living) parent; workers hang under their coordinator
  kids: Map<string, Session[]>
  loose: Session[] // roots that match no workspace
  terminals: Session[] // shell tabs: counted on their worktree row, not listed
  system: Session[] // harness-internal sessions: «Служебное»
  all: Session[] // every listed chat (roots and their workers), for the attention section
}

/** The worktree a session belongs to: worktreePath from the server, else the longest known worktree containing its cwd. */
export function worktreeOf(s: Session, paths: string[]): string | null {
  if (s.worktreePath) return normPath(s.worktreePath)
  const cwd = normPath(s.cwd)
  return paths.filter((p) => cwd === p || cwd.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0] ?? null
}

function buildTree(sessions: Session[], query: string, worktrees: Record<string, Worktree[]>): Tree {
  // A known worktree decides the project (a folder workspace may contain another project's worktrees).
  const byPath = new Map<string, string>()
  for (const [id, list] of Object.entries(worktrees)) for (const w of list) byPath.set(normPath(w.path), id)
  const paths = [...byPath.keys()]
  const owner = (s: Session) => { const w = worktreeOf(s, paths); return (w && byPath.get(w)) ?? s.workspaceId }
  const system = sessions.filter((s) => s.system)
  const listed = sessions.filter((s) => !s.system)
  const terminals = listed.filter((s) => s.kind === 'terminal')
  const chats = listed.filter((s) => s.kind !== 'terminal')
  const ids = new Set(chats.map((s) => s.id))
  const sorted = [...chats].sort((a, b) => a.createdAt - b.createdAt)
  const kids = new Map<string, Session[]>()
  for (const s of sorted) {
    if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s])
  }
  let roots = sorted.filter((s) => !s.parentId || !ids.has(s.parentId))
  const q = query.trim().toLowerCase()
  if (q) {
    const hit = (s: Session): boolean =>
      [s.title, s.agent, s.model ?? '', s.taskId ?? '', s.branch ?? '', s.cwd].some((v) => v.toLowerCase().includes(q)) ||
      (kids.get(s.id) ?? []).some(hit)
    roots = roots.filter(hit)
  }
  return { owner, roots, kids, loose: roots.filter((s) => !owner(s)), terminals, system, all: sorted }
}

const WAITS: Partial<Record<string, string>> = { waiting_permission: 'разрешение', waiting_answer: 'вопрос', auth: 'вход', stalled: 'нет вывода' }

/** «Требуют внимания»: every chat waiting for a person (or silent), longest waiting first; the tree stays calm. */
function AttentionSection({ tree }: { tree: Tree }) {
  const workspaces = useStore((s) => s.workspaces)
  const now = useNow()
  const list = tree.all
    .filter((s) => WAITS[sessionVisualState(s)])
    .sort((a, b) => (a.lastEventAt ?? a.lastActivityAt) - (b.lastEventAt ?? b.lastActivityAt))
  if (!list.length) return null
  return (
    <section className="attention" aria-label="Требуют внимания">
      <div className="attention-head">Требуют внимания <span className="num">· {list.length}</span></div>
      {list.map((s) => {
        const v = sessionVisualState(s)
        const ws = workspaces.find((w) => w.id === tree.owner(s))
        const where = [ws?.kind === 'root' ? 'Все проекты' : ws?.name, s.branch ?? (ws && normPath(ws.path) !== normPath(s.cwd) ? basename(s.cwd) : null)].filter(Boolean).join(' · ')
        const since = s.lastEventAt ?? s.lastActivityAt
        return (
          <div key={s.id} className="tree-row tree-sess attention-row" role="button" tabIndex={0} style={depth(0)} data-s={v}
            data-tip={s.title} data-tip-trunc onClick={() => openSession(s.id)} onKeyDown={activate(() => openSession(s.id))}>
            <StatusIcon session={s} />
            <span className="label"><strong>{s.title || s.id}</strong>{where && <span className="sess-doing"> · {where}</span>}</span>
            <span className="sess-state">{v === 'stalled' ? `нет вывода ${dur(now - since)}` : WAITS[v]}</span>
          </div>
        )
      })}
    </section>
  )
}

/** «Служебное»: harness-internal sessions (login terminal, discovery), folded at the bottom, never under a project. */
function SystemGroup({ sessions }: { sessions: Session[] }) {
  const [open, setOpenState] = useState(() => loadDraft<boolean>('sb:system') ?? false)
  const toggle = () => { setOpenState(!open); saveDraft('sb:system', !open || null) }
  return (
    <div className="tree-group tree-system" data-open={open || undefined}>
      <div className="tree-row tree-project tree-system-head" role="button" tabIndex={0} aria-expanded={open} style={depth(0)} onClick={toggle} onKeyDown={activate(toggle)}>
        <ChevronRight className="chev" aria-hidden />
        <Settings aria-hidden />
        <span className="label">Служебное <span className="tree-path">{sessions.length}</span></span>
      </div>
      {open && <div className="tree-children">{sessions.map((s) => <SessionRow key={s.id} s={s} nested={false} level={1} />)}</div>}
    </div>
  )
}

/** Whether a worktree is worth a row by default: it is where something is, was recently, or is about to happen. */
function worktreeMatters(wt: Worktree, here: Session[], taskStatus: string | null | undefined, active: boolean, now: number, terminals = 0) {
  return wt.main || active || here.length > 0 || terminals > 0 || (wt.dirty ?? 0) > 0 || (wt.ahead ?? 0) > 0 || !!wt.meta?.pinned ||
    taskStatus === 'in_progress' || taskStatus === 'review' || (!!wt.lastActivityAt && now - wt.lastActivityAt < WEEK)
}
const WEEK = 7 * 24 * 3600 * 1000
const ATTENTION = new Set(['waiting_answer', 'waiting_permission', 'stalled', 'auth', 'error'])
const BUSY = new Set(['running', 'starting'])

function ProjectNode({ ws, tree, filtering }: { ws: Workspace; tree: Tree; filtering: boolean }) {
  const mine = tree.roots.filter((s) => tree.owner(s) === ws.id)
  const activeCwd = useActiveCwd()
  const worktrees = useStore((s) => s.worktrees[ws.id])
  const tasks = useStore((s) => s.tasks)
  const now = useNow()
  const holdsActive = !!activeCwd && (normPath(activeCwd) === normPath(ws.path) || (worktrees ?? []).some((w) => normPath(w.path) === normPath(activeCwd)) || mine.some((s) => normPath(s.cwd) === normPath(activeCwd)))
  // Open by default only where something is; a choice the user made sticks.
  const [choice, setChoice] = useState(() => loadDraft<boolean>(`sb:open:${ws.id}`))
  const open = choice ?? (mine.length > 0 || holdsActive)
  const toggle = () => { setChoice(!open); saveDraft(`sb:open:${ws.id}`, !open) }
  const [moreChoice, setMoreChoice] = useState(() => loadDraft<boolean>(`sb:more:${ws.id}`) ?? false)
  const setMore = (v: boolean) => { setMoreChoice(v); saveDraft(`sb:more:${ws.id}`, v || null) }
  const [menu, setMenu] = useState(false)
  const projRow = useRef<HTMLDivElement>(null)
  const plain = ws.kind === 'root' || ws.kind === 'folder' // the projects folder and plain folders hold chats directly
  const expanded = open || filtering
  const loaded = worktrees !== undefined

  // Git's worktrees only: a session in a subfolder belongs to the worktree containing it (no pseudo-worktree rows).
  const list = useMemo<Worktree[]>(() => (worktrees?.length ? worktrees : [{ path: ws.path, branch: null, head: '', main: true }]), [worktrees, ws.path])
  const paths = useMemo(() => list.map((w) => normPath(w.path)), [list])
  const mainPath = normPath(list.find((w) => w.main)?.path ?? ws.path)
  const placeOf = (x: Session) => worktreeOf(x, paths) ?? mainPath
  const myTerminals = tree.terminals.filter((t) => tree.owner(t) === ws.id)
  // Lazy: only an expanded project asks for its (enriched, slower) worktree list, and again when its sessions change.
  const sig = mine.map((s) => s.id + s.status).join()
  useEffect(() => {
    if (expanded && ws.isGit && !plain) void loadWorktrees(ws.id).then(() => loadWorktrees(ws.id, true)) // rows at once, badges next
  }, [expanded, ws.id, ws.isGit, plain, sig])

  const rows = useMemo(() => {
    // Same branch name twice (two clones, two «main»s): the folder tells them apart.
    const names = new Map<string, number>()
    for (const w of list) { const n = w.meta?.label || w.branch || basename(w.path); names.set(n, (names.get(n) ?? 0) + 1) }
    const out = list.map((wt) => {
      const here = mine.filter((s) => placeOf(s) === normPath(wt.path))
      const terms = myTerminals.filter((t) => placeOf(t) === normPath(wt.path))
      const dup = (names.get(wt.meta?.label || wt.branch || basename(wt.path)) ?? 0) > 1
      const states = withKids(here, tree.kids).map(sessionVisualState)
      const task = wt.taskStatus ?? tasks.find((t) => t.id === wt.taskId || (!!wt.branch && t.branch === wt.branch))?.status
      const active = !!activeCwd && normPath(activeCwd) === normPath(wt.path)
      const last = Math.max(wt.lastActivityAt ?? 0, ...here.map((s) => s.lastActivityAt))
      return { wt, here, terms, dup, active, last, rank: states.some((v) => ATTENTION.has(v)) ? 0 : states.some((v) => BUSY.has(v)) ? 1 : 2, matters: worktreeMatters(wt, here, task, active, now, terms.length) }
    })
    return out.sort((a, b) => a.rank - b.rank || b.last - a.last || (a.wt.branch ?? a.wt.path).localeCompare(b.wt.branch ?? b.wt.path))
  }, [list, mine, tree.kids, tasks, activeCwd, now, myTerminals, paths, mainPath])
  const visible = filtering ? rows.filter((r) => r.here.length > 0) : moreChoice ? rows : rows.filter((r) => r.matters)
  const hidden = filtering ? 0 : rows.length - rows.filter((r) => r.matters).length

  if (filtering && mine.length === 0) return null
  const isRoot = ws.kind === 'root'
  const name = isRoot ? 'Все проекты' : ws.name

  return (
    <div className="tree-group" data-open={expanded || undefined} data-root={isRoot || undefined}>
      <div ref={projRow} className="tree-row tree-project" role="button" tabIndex={0} aria-expanded={expanded} data-tip={plain ? ws.path : ws.name} data-tip-trunc onClick={toggle} onKeyDown={activate(toggle)}
        style={depth(0)} onContextMenu={(e) => { e.preventDefault(); setMenu(true) }}>
        <ChevronRight className="chev" aria-hidden />
        {plain ? <Folder aria-hidden /> : <FolderGit2 aria-hidden />}
        <span className="label">{name}{isRoot && <span className="tree-path"> {basename(ws.path)}</span>}</span>
        {!expanded && <RowSummary sessions={withKids(mine, tree.kids)} />}
        {plain && myTerminals.length > 0 && <TerminalCount terminals={myTerminals} />}
        {plain && <RowAction label={`Новый чат: ${name}`} icon={<MessageSquarePlus />} onClick={() => void newChat({ workspaceId: ws.id, cwd: ws.path })} />}
        <span className="actions">
          {ws.isGit && <RowAction label="Новое рабочее дерево" icon={<GitBranchPlus />} onClick={() => openDialog({ kind: 'worktree', workspaceId: ws.id })} />}
          <RowAction label="Действия с проектом" icon={<Ellipsis />} onClick={() => setMenu(true)} />
        </span>
      </div>
      <Menu anchor={projRow} open={menu} onClose={() => setMenu(false)} items={projectMenu(ws)} label={`Проект ${ws.name}`} placement="bottom-end" />
      {expanded && (
        <div className="tree-children">
          {plain ? mine.map((s) => <SessionNode key={s.id} s={s} kids={tree.kids} base={1} />)
            : !loaded && ws.isGit ? <div className="tree-skel"><Skeleton rows={2} label="Загрузка рабочих деревьев…" /></div>
              : (
                <>
                  {visible.map((r) => <WorktreeNode key={r.wt.path} ws={ws} wt={r.wt} sessions={r.here} terminals={r.terms} dup={r.dup} kids={tree.kids} active={r.active} />)}
                  {hidden > 0 && (
                    <button type="button" className="tree-row tree-more" style={depth(1)} aria-expanded={moreChoice} onClick={() => setMore(!moreChoice)}>
                      <Ellipsis aria-hidden />
                      {moreChoice ? 'Свернуть тихие рабочие деревья' : `Ещё ${hidden} ${plural(hidden, 'рабочее дерево', 'рабочих дерева', 'рабочих деревьев')}`}
                    </button>
                  )}
                </>
              )}
        </div>
      )}
    </div>
  )
}

function WorktreeNode({ ws, wt, sessions, terminals, dup, kids, active }: {
  ws: Workspace; wt: Worktree; sessions: Session[]; terminals: Session[]; dup: boolean; kids: Map<string, Session[]>; active: boolean
}) {
  const changed = useStore((s) => s.git[normPath(wt.path)]?.status?.files.length ?? wt.dirty ?? 0)
  const task = useStore((s) => (wt.taskId ? s.tasks.find((t) => t.id === wt.taskId) : s.tasks.find((t) => !!wt.branch && t.branch === wt.branch)))
  const [menu, setMenu] = useState(false)
  const [unread, setUnreadState] = useState(() => isUnread(wt.path))
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = () => setUnreadState(isUnread(wt.path))
    window.addEventListener('harness:unread', on)
    return () => window.removeEventListener('harness:unread', on)
  }, [wt.path])
  const pick = () => { openWorktree(wt.path); if (unread) setUnread(wt.path, false) }
  const name = wt.meta?.label || wt.branch || (wt.main ? ws.name : basename(wt.path))
  const where = { workspaceId: ws.id, cwd: wt.path }
  const sleeping = !!wt.meta?.sleeping
  const ahead = wt.ahead ?? 0
  const history = useHistory(wt.path, sessions.length === 0) // only rows without harness chats ask for it
  const ownHistory = (history ?? []).filter((h) => normPath(h.cwd) === normPath(wt.path)).length // not the main copy's, listed for every worktree
  return (
    <div className="wt" data-active={active} data-sleeping={sleeping || undefined}>
      <div ref={row} className="tree-row tree-wt" role="button" tabIndex={0} style={depth(1)}
        data-tip={name} data-tip-trunc
        aria-current={active ? 'location' : undefined} onClick={pick}
        onKeyDown={(e) => { onWorktreeKey(e, ws, wt); activate(pick)(e) }}
        onContextMenu={(e) => { e.preventDefault(); setMenu(true) }}>
        {sleeping ? <Moon aria-label="спит" /> : wt.main ? <House aria-label="основная копия" /> : <GitBranch aria-hidden />}
        <span className="label">{name}{dup && <span className="tree-path"> · {basename(wt.path)}</span>}</span>
        {wt.meta?.pinned && <Pin className="wt-pin" aria-label="закреплено" />}
        {unread && <span className="wt-unread" aria-label="непрочитано" />}
        {sessions.length === 0 && ownHistory > 0 && (
          <button type="button" className="wt-history" data-tip="Сессии GigaCode, начатые в CLI" onClick={(e) => { e.stopPropagation(); openWorktree(wt.path); showPanel('history') }}>
            история: {ownHistory}
          </button>
        )}
        <span className="wt-badges">
          <RowSummary sessions={withKids(sessions, kids)} />
          {changed > 0 && <span className="wt-stat num" data-tip={`${changed} ${plural(changed, 'изменённый файл', 'изменённых файла', 'изменённых файлов')}`}>±{changed}</span>}
          {ahead > 0 && <span className="wt-stat num" data-tip={`${ahead} ${plural(ahead, 'коммит', 'коммита', 'коммитов')} не в базовой ветке`}><ArrowUp aria-hidden />{ahead}</span>}
          {terminals.length > 0 && <TerminalCount terminals={terminals} />}
        </span>
        <span className="actions">
          <RowAction label="Новый чат в этом дереве" icon={<MessageSquarePlus />} onClick={() => void newChat(where)} />
          <RowAction label="Новый терминал в этом дереве" icon={<SquareTerminal />} onClick={() => void newTerminal(where)} />
          {ws.isGit && (
            <BranchPicker cwd={wt.path} branch={wt.branch} placement="bottom-start" className="icon-btn icon-btn-sm">
              <GitBranch />
            </BranchPicker>
          )}
          <RowAction label="Действия с деревом" icon={<Ellipsis />} onClick={() => setMenu(true)} />
        </span>
      </div>
      <Menu anchor={row} open={menu} onClose={() => setMenu(false)} items={worktreeMenu(ws, wt, task, ideEnabled())} label={`Рабочее дерево ${name}`} placement="bottom-end" />
      {sessions.map((s) => <SessionNode key={s.id} s={s} kids={kids} base={2} />)}
    </div>
  )
}

/** A top-level session and, under it, its workers (harness chats) and the agent's own internal sub-agents. */
/** A sub-agent (built-in, or a worker_run child) whose run is over: folded under its parent. */
const isFinishedSub = (c: Session) => (c.virtual || c.role === 'subagent') && c.status !== 'running' && !c.waitingFor

function SessionNode({ s, kids, level = 0, base = 2 }: { s: Session; kids: Map<string, Session[]>; level?: number; base?: number }) {
  const all = kids.get(s.id) ?? []
  const finished = all.filter(isFinishedSub)
  const [showFinished, setShowFinished] = useState(false)
  const children = showFinished ? all : all.filter((c) => !isFinishedSub(c))
  const internal = useStore((st) => st.subagents[s.id])
  const [open, setOpen] = useState(true)
  const has = children.length > 0 || !!internal?.items.length
  const ok = finished.filter((c) => c.status === 'done' || c.status === 'idle').length
  const subs = finished.length ? { ok, bad: finished.length - ok, open: showFinished, toggle: () => setShowFinished(!showFinished) } : undefined
  return (
    <>
      <SessionRow s={s} nested={level > 0} level={base + level} caret={has ? { open, toggle: () => setOpen(!open) } : undefined} subs={subs} />
      {has && open && (
        <div className="tree-kids" role="group" aria-label={`Агенты сессии ${s.title}`}>
          {children.map((c) => <SessionNode key={c.id} s={c} kids={kids} level={level + 1} base={base} />)}
          {internal?.items.map((a) => (
            <div
              key={a.id}
              className="tree-row tree-sess tree-sub"
              style={depth(base + level + 1)}
              data-tip={a.name} data-tip-trunc aria-label={`${a.name}: ${subStateLabel(a.state)}, внутренний агент`}
            >
              <SubStateIcon state={a.state} />
              <span className="label">
                {a.name}
                {a.activity?.tool && <span className="sess-doing"> · {a.activity.tool}</span>}
              </span>
              {a.tokensIn + a.tokensOut > 0 && <span className="meta">{tokens(a.tokensIn + a.tokensOut)}</span>}
              {a.model && <span className="agent">{a.model}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function SessionRow({ s, nested, level = 0, caret, subs }: {
  s: Session; nested: boolean; level?: number; caret?: { open: boolean; toggle: () => void }
  subs?: { ok: number; bad: number; open: boolean; toggle: () => void }
}) {
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const items = sessionMenu(s, () => setEditing(true)).map((it) =>
    // «В архив» from the sidebar: the row slides out first, then goes.
    it.label === 'В архив' ? { ...it, onSelect: () => { setLeaving(true); window.setTimeout(() => void archiveSession(s).then((ok) => { if (!ok) setLeaving(false) }), 160) } } : it)
  const current = useStore((st) => st.view.kind === 'wt' && st.wt[normPath(st.view.cwd)]?.active === `s:${s.id}`)
  const now = useNow()
  const tool = useCurrentTool(s)
  const v = sessionVisualState(s)
  const line = useStateLine(s)
  const open = () => openSession(s.id)
  const preview = s.preview.split('\n').map((l) => l.trim()).filter(Boolean).pop()
  // A sub-agent's title «profile: task» reads as the profile with the task muted.
  const sub = (s.role === 'subagent' || s.virtual) ? /^([\w.-]{2,40}):\s+(.+)$/.exec(s.title)?.slice(1, 3) : undefined
  // Running: the tool in use; calm top-level rows: the last line of the answer.
  const doing = v === 'running' ? tool : !nested && (v === 'idle' || v === 'done') ? preview : ''
  return (
    <>
    <div
      ref={row}
      className="tree-row tree-sess"
      role="button"
      data-s={v}
      data-nested={nested || undefined}
      data-enter={s.createdAt > APP_START || undefined}
      data-leaving={leaving || undefined}
      tabIndex={0}
      aria-current={current ? 'true' : undefined}
      data-tip={editing ? undefined : s.title || s.id} data-tip-trunc
      onClick={editing ? undefined : open}
      onKeyDown={editing ? undefined : activate(open)}
      onContextMenu={(e) => { e.preventDefault(); setMenu(true) }}
      style={depth(level)}
    >
      <StatusIcon session={s} />
      {editing ? (
        <input className="input tree-rename" autoFocus defaultValue={s.title} aria-label="Название чата"
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => { setEditing(false); void renameSession(s, e.currentTarget.value) }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = s.title; setEditing(false) } }} />
      ) : (
        <span className="label">
          {nested && <span className="sub-glyph" aria-hidden>↳ </span>}
          {s.role === 'reviewer' && <span className="sess-doing">ревью · </span>}
          {sub ? <>{sub[0]}<span className="sess-doing">: {sub[1]}</span></> : s.title || s.id}
          {doing && <span className="sess-doing"> · {doing}</span>}
        </span>
      )}
      {subs && (
        <button type="button" className="sess-subs" aria-expanded={subs.open} data-tip={subs.open ? 'Свернуть завершённых субагентов' : 'Показать завершённых субагентов'}
          onClick={(e) => { e.stopPropagation(); subs.toggle() }} onKeyDown={(e) => e.stopPropagation()}>
          субагенты: {subs.ok > 0 && <>{subs.ok} ✓</>}{subs.bad > 0 && <> {subs.bad} ✗</>}
        </button>
      )}
      {s.interrupted && <span className="badge-interrupted" data-tip={s.interrupted.lastActivity ? `Прервана на: ${s.interrupted.lastActivity}` : 'Перезапуск прервал ход'}>прервана</span>}
      {s.warm !== undefined && <span className="sess-warm" data-warm={s.warm || undefined} aria-label={s.warm ? 'процесс запущен' : 'процесс выгружен'}>{s.warm ? '●' : '○'}</span>}
      <span className="sess-state" data-s={v}>
        {line || <><span className="agent">{s.kind === 'terminal' ? 'shell' : s.model ?? s.agent}</span> · {relTime(s.lastActivityAt, now)}</>}
      </span>
      {caret && (
        <button
          type="button"
          className="caret"
          aria-expanded={caret.open}
          aria-label={caret.open ? 'Свернуть агентов' : 'Показать агентов'}
          onClick={(e) => { e.stopPropagation(); caret.toggle() }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <ChevronDown />
        </button>
      )}
      <span className="actions">
        <RowAction label="Действия с чатом" icon={<Ellipsis />} onClick={() => setMenu(true)} />
      </span>
    </div>
    <Menu anchor={row} open={menu} onClose={() => setMenu(false)} items={items} label={`Чат ${s.title}`} placement="bottom-end" />
    </>
  )
}

/** A session and all its workers, for summaries. */
function withKids(roots: Session[], kids: Map<string, Session[]>): Session[] {
  const out: Session[] = []
  const walk = (s: Session) => { out.push(s); for (const k of kids.get(s.id) ?? []) walk(k) }
  roots.forEach(walk)
  return out
}

/** Right side of a worktree / collapsed project row: «2 ▶ · ⚠1», only non-zero, each explained in its tooltip. */
function RowSummary({ sessions }: { sessions: Session[] }) {
  const states = sessions.filter((x) => x.kind === 'chat').map(sessionVisualState)
  const busy = states.filter((v) => BUSY.has(v)).length
  const att = states.filter((v) => ATTENTION.has(v)).length
  return (
    <>
      {busy > 0 && <span className="wt-stat wt-stat-plain num" data-tip={`${busy} ${plural(busy, 'агент работает', 'агента работают', 'агентов работают')}`}>{busy} ▶</span>}
      {att > 0 && <span className="wt-stat wt-stat-plain num" data-tip={`${att} ${plural(att, 'чат ждёт', 'чата ждут', 'чатов ждут')} вас или с ошибкой`}>⚠{att}</span>}
    </>
  )
}

/** «⌨ 2»: shells of this worktree live in its tab strip; the click opens the most recent one. */
function TerminalCount({ terminals }: { terminals: Session[] }) {
  const last = [...terminals].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
  return (
    <button type="button" className="wt-stat wt-term num" data-tip={`${terminals.length} ${plural(terminals.length, 'терминал', 'терминала', 'терминалов')}: открыть последний`}
      onClick={(e) => { e.stopPropagation(); openSession(last.id) }} onKeyDown={(e) => e.stopPropagation()}>
      ⌨{terminals.length}
    </button>
  )
}

function RowAction({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn-sm"
      aria-label={label}
      data-tip={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {icon}
    </button>
  )
}
