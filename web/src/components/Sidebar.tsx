import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Bot, ChevronDown, ChevronRight, FolderGit2, FolderPlus, GitBranch, GitBranchPlus, House, Inbox, MessageSquarePlus, Moon, Search, Settings, SquareKanban, SquareTerminal, Sun } from 'lucide-react'
import { openDialog, openScreen, openSession, openWorktree, setState, useActiveCwd, useStore, type Screen } from '../store'
import { loadWorktrees } from '../ws'
import { useCurrentTool, useStartingLabel } from '../lib/live'
import { basename, normPath, relTime, tokens } from '../lib/format'
import { newChat, newTerminal } from '../lib/actions'
import type { Session, Workspace, Worktree } from '../types'
import { StatusIcon, SubStateIcon, subStateLabel } from './bits'
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
  const chats = sessions.filter((s) => s.kind === 'chat').length
  const tree = useMemo(() => buildTree(sessions, query), [sessions, query])

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
            ? <span className="count count-run" title={`Работают: ${running} из ${chats}`}>{running}</span>
            : chats > 0 && <span className="count" title={`Чатов: ${chats}`}>{chats}</span>}
        />
        <NavItem screen="inbox" icon={<Inbox />} label="Входящие" end={unread > 0 && <span className="count count-signal" aria-label={`непрочитанных: ${unread}`}>{unread}</span>} />
      </div>

      <div className="sb-head">
        <span>Проекты</span>
        <button type="button" className="icon-btn icon-btn-sm" title="Добавить проект" aria-label="Добавить проект" onClick={() => openDialog({ kind: 'workspace' })}>
          <FolderPlus />
        </button>
      </div>

      <div className="tree" aria-label="Проекты и сессии">
        {workspaces.map((ws) => (
          <ProjectNode key={ws.id} ws={ws} tree={tree} filtering={!!query.trim()} />
        ))}
        {tree.loose.length > 0 && (
          <div className="tree-group">
            <div className="tree-note" style={depth(-1)}>Вне проектов</div>
            {tree.loose.map((s) => <SessionNode key={s.id} s={s} kids={tree.kids} />)}
          </div>
        )}
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
          title={scheme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
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
        title="Потяните, чтобы изменить ширину"
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
  roots: Session[] // sessions without a (living) parent; workers hang under their coordinator
  kids: Map<string, Session[]>
  loose: Session[] // roots that match no workspace
}

function buildTree(sessions: Session[], query: string): Tree {
  const ids = new Set(sessions.map((s) => s.id))
  const sorted = [...sessions].sort((a, b) => a.createdAt - b.createdAt)
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
  return { roots, kids, loose: roots.filter((s) => !s.workspaceId) }
}

function ProjectNode({ ws, tree, filtering }: { ws: Workspace; tree: Tree; filtering: boolean }) {
  const [open, setOpen] = useState(true)
  const worktrees = useStore((s) => s.worktrees[ws.id])
  const activeCwd = useActiveCwd()

  const mine = tree.roots.filter((s) => s.workspaceId === ws.id)
  const loaded = worktrees !== undefined
  // Git worktrees, plus folders sessions run in that git does not list (so every session sits under a worktree).
  const list = useMemo(() => {
    const out: Worktree[] = worktrees?.length ? [...worktrees] : [{ path: ws.path, branch: null, head: '', main: true }]
    for (const s of mine) {
      if (!out.some((w) => normPath(w.path) === normPath(s.cwd))) out.push({ path: s.cwd, branch: s.branch, head: '', main: false })
    }
    return out
  }, [worktrees, ws.path, mine])
  const unknown = loaded && list.length > (worktrees?.length || 1)

  useEffect(() => {
    if (open && ws.isGit && (!loaded || unknown)) void loadWorktrees(ws.id)
  }, [open, ws.id, ws.isGit, loaded, unknown])

  if (filtering && mine.length === 0) return null
  const expanded = open || filtering
  const toggle = () => setOpen(!open)

  return (
    <div className="tree-group">
      <div className="tree-row tree-project" role="button" tabIndex={0} aria-expanded={expanded} title={ws.path} onClick={toggle} onKeyDown={activate(toggle)}>
        <ChevronRight className="chev" aria-hidden />
        <FolderGit2 aria-hidden />
        <span className="label">{ws.name}</span>
        {ws.isGit && (
          <span className="actions">
            <RowAction label="Новое рабочее дерево" icon={<GitBranchPlus />} onClick={() => openDialog({ kind: 'worktree', workspaceId: ws.id })} />
          </span>
        )}
      </div>
      {expanded && list.map((wt) => {
        const here = mine.filter((s) => normPath(s.cwd) === normPath(wt.path))
        if (filtering && here.length === 0) return null
        return <WorktreeNode key={wt.path} ws={ws} wt={wt} sessions={here} kids={tree.kids} active={!!activeCwd && normPath(activeCwd) === normPath(wt.path)} />
      })}
    </div>
  )
}

function WorktreeNode({ ws, wt, sessions, kids, active }: { ws: Workspace; wt: Worktree; sessions: Session[]; kids: Map<string, Session[]>; active: boolean }) {
  const changed = useStore((s) => s.git[normPath(wt.path)]?.status?.files.length ?? 0)
  const pick = () => openWorktree(wt.path)
  const name = wt.branch ?? (wt.main ? ws.name : basename(wt.path))
  const where = { workspaceId: ws.id, cwd: wt.path }
  return (
    <div className="wt" data-active={active}>
      <div className="tree-row tree-wt" role="button" tabIndex={0} title={`${wt.main ? 'Основная рабочая копия' : 'Рабочее дерево'}\n${wt.path}`} aria-current={active ? 'location' : undefined} onClick={pick} onKeyDown={activate(pick)}>
        {wt.main ? <House aria-label="основная копия" /> : <GitBranch aria-hidden />}
        <span className="label">{name}</span>
        {changed > 0 && <span className="wt-changes num" title={`Изменённых файлов: ${changed}`}>{changed}</span>}
        <span className="actions">
          <RowAction label="Новый чат в этом дереве" icon={<MessageSquarePlus />} onClick={() => void newChat(where)} />
          <RowAction label="Новый терминал в этом дереве" icon={<SquareTerminal />} onClick={() => void newTerminal(where)} />
        </span>
      </div>
      {sessions.map((s) => <SessionNode key={s.id} s={s} kids={kids} />)}
    </div>
  )
}

/** A top-level session and, under it, its workers (harness chats) and the agent's own internal sub-agents. */
function SessionNode({ s, kids }: { s: Session; kids: Map<string, Session[]> }) {
  const children = kids.get(s.id) ?? []
  const internal = useStore((st) => st.subagents[s.id])
  const [open, setOpen] = useState(true)
  const has = children.length > 0 || !!internal?.items.length
  return (
    <>
      <SessionRow s={s} nested={false} caret={has ? { open, toggle: () => setOpen(!open) } : undefined} />
      {has && open && (
        <div className="tree-kids" role="group" aria-label={`Агенты сессии ${s.title}`}>
          {children.map((c) => <SessionRow key={c.id} s={c} nested />)}
          {internal?.items.map((a) => (
            <div
              key={a.id}
              className="tree-row tree-sess tree-sub"
              title={`${a.name}: ${subStateLabel(a.state)} (внутренний агент, только просмотр)${a.lastText ? `\n${a.lastText}` : ''}`}
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

function SessionRow({ s, nested, caret }: { s: Session; nested: boolean; caret?: { open: boolean; toggle: () => void } }) {
  const current = useStore((st) => st.view.kind === 'wt' && st.wt[normPath(st.view.cwd)]?.active === `s:${s.id}`)
  const now = useNow()
  const tool = useCurrentTool(s)
  const starting = useStartingLabel(s)
  const open = () => openSession(s.id)
  const preview = s.preview.split('\n').map((l) => l.trim()).filter(Boolean).pop()
  const doing = starting || (nested ? (tool || (s.status === 'running' ? 'работает' : '')) : (tool || preview))
  return (
    <div
      className="tree-row tree-sess"
      role="button"
      data-s={s.status}
      data-nested={nested || undefined}
      data-enter={s.createdAt > APP_START || undefined}
      tabIndex={0}
      aria-current={current ? 'true' : undefined}
      title={`${s.title}${preview ? `\n${preview}` : ''}\n${s.cwd}`}
      onClick={open}
      onKeyDown={activate(open)}
      style={depth(0)}
    >
      {s.kind === 'terminal' && s.status !== 'exited' ? <SquareTerminal className="st" aria-label="терминал" /> : <StatusIcon session={s} />}
      <span className="label">
        {s.title || s.id}
        {doing && <span className="sess-doing">{nested ? ' · ' : ' - '}{doing}</span>}
      </span>
      <span className="agent">{s.kind === 'terminal' ? 'shell' : s.model ?? s.agent}</span>
      {caret ? (
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
      ) : (
        <span className="meta">{relTime(s.lastActivityAt, now)}</span>
      )}
    </div>
  )
}

function RowAction({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn-sm"
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {icon}
    </button>
  )
}
