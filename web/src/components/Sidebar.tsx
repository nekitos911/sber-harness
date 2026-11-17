import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Bot, ChevronRight, FolderGit2, FolderPlus, GitBranch, GitBranchPlus, Inbox, MessageSquarePlus, Moon, Search, Settings, SquareKanban, SquareTerminal, Sun } from 'lucide-react'
import { openDialog, openSession, openTab, setState, tabKey, useActiveCwd, useStore } from '../store'
import { loadWorktrees } from '../ws'
import { basename, normPath, relTime, tokens } from '../lib/format'
import { currentWhere, newChat } from '../lib/actions'
import type { Session, Workspace, Worktree } from '../types'
import { StatusIcon, SubStateIcon, subStateLabel } from './bits'
import { useNow } from '../lib/useNow'

const depth = (d: number) => ({ '--depth': d }) as CSSProperties

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() }
}

export function Sidebar() {
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const notifications = useStore((s) => s.notifications)
  const scheme = useStore((s) => s.scheme)
  const width = useStore((s) => s.sidebarWidth)
  const [query, setQuery] = useState('')

  const unread = notifications.filter((n) => !n.read).length
  const running = sessions.filter((s) => s.kind === 'chat' && s.status === 'running').length
  const agents = sessions.filter((s) => s.kind === 'chat').length

  const tree = useMemo(() => buildTree(sessions, query), [sessions, query])

  return (
    <nav className="sidebar" aria-label="Навигация">
      <div className="sb-search">
        <Search aria-hidden />
        <input className="input" type="search" placeholder="Поиск" aria-label="Поиск по сессиям и проектам" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="sb-new">
        <button type="button" className="btn" onClick={() => void newChat(currentWhere())} title="Чат с агентом по умолчанию в текущей папке">
          <MessageSquarePlus />
          Новый чат
        </button>
      </div>

      <div className="nav">
        <NavItem tab="board" icon={<SquareKanban />} label="Задачи" />
        <NavItem
          tab="agents"
          icon={<Bot />}
          label="Агенты"
          end={agents > 0 && <>{running > 0 && <span className="dot" aria-label={`работают: ${running}`} />}<span className="count">{agents}</span></>}
        />
        <NavItem tab="inbox" icon={<Inbox />} label="Входящие" end={unread > 0 && <span className="count count-run" aria-label={`непрочитанных: ${unread}`}>{unread}</span>} />
      </div>

      <div className="sb-head">
        <span>Проекты</span>
        <button type="button" className="icon-btn icon-btn-sm" title="Добавить проект" aria-label="Добавить проект" onClick={() => openDialog({ kind: 'workspace' })}>
          <FolderPlus />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" title="Новое рабочее дерево" aria-label="Новое рабочее дерево" onClick={() => openDialog({ kind: 'worktree' })}>
          <GitBranchPlus />
        </button>
      </div>

      <div className="tree" aria-label="Проекты и сессии">
        {workspaces.map((ws) => (
          <ProjectNode key={ws.id} ws={ws} tree={tree} filtering={!!query.trim()} />
        ))}
        {tree.loose.length > 0 && (
          <div className="tree-group">
            <div className="tree-note" style={depth(-1)}>Вне проектов</div>
            {tree.loose.map((s) => <SessionNode key={s.id} s={s} kids={tree.kids} d={0} />)}
          </div>
        )}
        {workspaces.length === 0 && (
          <div className="tree-note" style={depth(-1)}>
            Добавьте папку проекта, чтобы запускать агентов в её рабочих копиях.
          </div>
        )}
      </div>

      <div className="sb-foot">
        <button type="button" className="icon-btn" title="Настройки" aria-label="Настройки" onClick={() => openTab({ kind: 'settings' })}>
          <Settings />
        </button>
        <button type="button" className="icon-btn" title="Новый терминал" aria-label="Новый терминал" onClick={() => openDialog({ kind: 'terminal' })}>
          <SquareTerminal />
        </button>
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

function NavItem({ tab, icon, label, end }: { tab: 'board' | 'agents' | 'inbox'; icon: ReactNode; label: string; end?: ReactNode }) {
  const active = useStore((s) => s.active === tab)
  return (
    <button type="button" className="nav-item" aria-current={active ? 'page' : undefined} onClick={() => openTab({ kind: tab })}>
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
      [s.title, s.agent, s.taskId ?? '', s.branch ?? '', s.cwd].some((v) => v.toLowerCase().includes(q)) ||
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
  const list: Worktree[] = worktrees?.length ? worktrees : [{ path: ws.path, branch: null, head: '', main: true }]
  const known = new Set(list.map((w) => normPath(w.path)))
  const unknown = mine.some((s) => !known.has(normPath(s.cwd)))
  const loaded = worktrees !== undefined

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
        <span className="actions">
          <RowAction label="Новый чат здесь" icon={<MessageSquarePlus />} onClick={() => void newChat({ workspaceId: ws.id, cwd: ws.path })} />
          <RowAction label="Новый терминал здесь" icon={<SquareTerminal />} onClick={() => openDialog({ kind: 'terminal', workspaceId: ws.id, cwd: ws.path })} />
          {ws.isGit && <RowAction label="Новое рабочее дерево" icon={<GitBranchPlus />} onClick={() => openDialog({ kind: 'worktree', workspaceId: ws.id })} />}
        </span>
      </div>
      {expanded && (
        <div>
          {list.map((wt) => {
            const here = mine.filter((s) => normPath(s.cwd) === normPath(wt.path))
            if (filtering && here.length === 0) return null
            return <WorktreeNode key={wt.path} ws={ws} wt={wt} sessions={here} kids={tree.kids} active={!!activeCwd && normPath(activeCwd) === normPath(wt.path)} />
          })}
          {mine.filter((s) => !list.some((w) => normPath(w.path) === normPath(s.cwd))).map((s) => (
            <SessionNode key={s.id} s={s} kids={tree.kids} d={1} />
          ))}
        </div>
      )}
    </div>
  )
}

function WorktreeNode({ ws, wt, sessions, kids, active }: { ws: Workspace; wt: Worktree; sessions: Session[]; kids: Map<string, Session[]>; active: boolean }) {
  const pick = () => setState({ cwd: wt.path, panel: true })
  const name = wt.branch ?? (wt.main ? 'основная копия' : basename(wt.path))
  return (
    <div className="wt" data-active={active}>
      <div className="tree-row" role="button" style={depth(1)} tabIndex={0} title={wt.path} onClick={pick} onKeyDown={activate(pick)}>
        <GitBranch aria-hidden />
        <span className="label mono" style={{ fontSize: 12 }}>{name}</span>
        {wt.main && wt.branch && <span className="meta">основная</span>}
        <span className="actions">
          <RowAction label="Новый чат в этом дереве" icon={<MessageSquarePlus />} onClick={() => void newChat({ workspaceId: ws.id, cwd: wt.path })} />
          <RowAction label="Новый терминал в этом дереве" icon={<SquareTerminal />} onClick={() => openDialog({ kind: 'terminal', workspaceId: ws.id, cwd: wt.path })} />
        </span>
      </div>
      {sessions.map((s) => <SessionNode key={s.id} s={s} kids={kids} d={2} />)}
    </div>
  )
}

function SessionNode({ s, kids, d }: { s: Session; kids: Map<string, Session[]>; d: number }) {
  const children = kids.get(s.id) ?? []
  return (
    <>
      <SessionRow s={s} d={d} />
      {children.length > 0 && (
        <div className="rail" style={depth(d)} aria-label={`Исполнители ${s.title}`}>
          {children.map((c) => <SessionNode key={c.id} s={c} kids={kids} d={0} />)}
        </div>
      )}
      <InternalAgents sessionId={s.id} d={d} />
    </>
  )
}

/** Agent-internal sub-agents (read-only registry rows): no chat of their own, so no actions. */
function InternalAgents({ sessionId, d }: { sessionId: string; d: number }) {
  const sub = useStore((st) => st.subagents[sessionId])
  if (!sub?.items.length) return null
  return (
    <div className="rail rail-sub" style={depth(d)} aria-label="Внутренние агенты">
      <div className="tree-sublabel">внутренние · {sub.items.length}</div>
      {sub.items.map((a) => (
        <div key={a.id} className="tree-row tree-sub" title={`${a.name} — ${subStateLabel(a.state)}${a.lastText ? `
${a.lastText}` : ''}`}>
          <SubStateIcon state={a.state} />
          <span className="label">{a.name}</span>
          <span className="agent">{a.activity?.tool ?? a.model ?? ''}</span>
          {a.tokensIn + a.tokensOut > 0 && <span className="meta">{tokens(a.tokensIn + a.tokensOut)}</span>}
        </div>
      ))}
    </div>
  )
}

function SessionRow({ s, d }: { s: Session; d: number }) {
  const current = useStore((st) => st.active === tabKey({ kind: 'session', id: s.id }))
  const now = useNow()
  const open = () => openSession(s.id)
  return (
    <div
      className="tree-row"
      role="button"
      data-s={s.status}
      style={depth(d)}
      tabIndex={0}
      aria-current={current}
      title={`${s.title}\n${s.cwd}`}
      onClick={open}
      onKeyDown={activate(open)}
    >
      {s.kind === 'terminal' && s.status !== 'exited' ? <SquareTerminal aria-label="терминал" /> : <StatusIcon session={s} />}
      <span className="label">{s.title || s.id}</span>
      <span className="agent">{s.model ?? s.agent}</span>
      <span className="meta">{relTime(s.lastActivityAt, now)}</span>
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
