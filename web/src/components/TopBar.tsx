import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Command, FileText, FolderOpen, GitCompare, MessageSquare, MessageSquarePlus, PanelLeft, PanelRight, Plus, SquareTerminal, X } from 'lucide-react'
import { activateTab, closeTab, dirtyKey, hasFeature, navigate, openDialog, setState, tabKey, useStore, wtKey, type Tab } from '../store'
import { basename } from '../lib/format'
import { useGit } from '../lib/git'
import type { GitStatus, Session } from '../types'
import { StatusIcon } from './bits'
import { MenuButton } from './ui/Menu'
import { newChat, newTerminal, workspaceFor } from '../lib/actions'
import { shortcut } from '../lib/keys'

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M4.5 2.5v11M4.5 8c0-2.4 7-2 7-5.5M11.5 13.5V9.5" />
      <circle cx="11.5" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function TopBar({ onCommand }: { onCommand: () => void }) {
  const sidebar = useStore((s) => s.sidebar)
  const panel = useStore((s) => s.panel)
  const canBack = useStore((s) => s.back.length > 0)
  const canForward = useStore((s) => s.forward.length > 0)
  const cwd = useStore((s) => (s.view.kind === 'wt' ? s.view.cwd : null))
  return (
    <header className="topbar">
      <div className="topbar-left">
        <BrandMark />
        <button type="button" className="icon-btn" aria-pressed={sidebar} aria-label="Боковая панель" data-tip="Боковая панель" onClick={() => setState({ sidebar: !sidebar })}>
          <PanelLeft />
        </button>
        <button type="button" className="icon-btn" disabled={!canBack} aria-label="Назад" data-tip="Назад" onClick={() => navigate('back')}>
          <ArrowLeft />
        </button>
        <button type="button" className="icon-btn" disabled={!canForward} aria-label="Вперёд" data-tip="Вперёд" onClick={() => navigate('forward')}>
          <ArrowRight />
        </button>
      </div>
      {cwd ? <TabBar key={wtKey(cwd)} cwd={cwd} /> : <div className="grow" />}
      <div className="topbar-right">
        <button type="button" className="btn btn-ghost" onClick={onCommand} data-tip={`Команды (${shortcut('K')})`}>
          <Command />
          Команда
        </button>
        {cwd && (
          <button type="button" className="icon-btn" aria-pressed={panel} aria-label="Панель файлов и изменений" data-tip="Панель файлов и изменений" onClick={() => setState({ panel: !panel })}>
            <PanelRight />
          </button>
        )}
      </div>
    </header>
  )
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** The tab strip of one worktree: its chats, terminals, files and diffs. */
function TabBar({ cwd }: { cwd: string }) {
  const k = wtKey(cwd)
  const entry = useStore((s) => s.wt[k])
  const sessions = useStore((s) => s.sessions)
  const dirty = useStore((s) => s.dirty)
  const git = useGit(cwd)
  const [closing, setClosing] = useState<string | null>(null)
  const tabs = entry?.tabs ?? []
  const active = entry?.active ?? null

  // Only tabs opened while this strip is on screen animate in; switching worktrees must not replay every tab.
  const seen = useRef<Set<string> | null>(null)
  if (!seen.current) seen.current = new Set(tabs.map((t) => `${k}|${tabKey(t)}`))
  useLayoutEffect(() => { for (const t of tabs) seen.current!.add(`${k}|${tabKey(t)}`) })

  const close = (key: string, animate: boolean) => {
    if (!animate || dirty[dirtyKey(cwd, key)] || reduceMotion()) { closeTab(cwd, key); return }
    setClosing(key)
    window.setTimeout(() => { setClosing(null); closeTab(cwd, key) }, 120)
  }

  const where = () => ({ cwd, workspaceId: workspaceFor(cwd) })

  return (
    <div className="tabstrip">
      <div className="tabbar" role="tablist" aria-label="Вкладки рабочего дерева">
        {tabs.map((t) => {
          const key = tabKey(t)
          const { icon, title, badge, file } = describeTab(t, sessions, git?.status ?? null)
          return (
            <div
              key={`${k}|${key}`}
              className="tab"
              role="tab"
              tabIndex={key === active ? 0 : -1}
              aria-selected={key === active}
              data-enter={!seen.current!.has(`${k}|${key}`) || undefined}
              data-leaving={closing === key || undefined}
              data-file={file || undefined}
              data-tip={title} data-tip-trunc
              onClick={() => activateTab(cwd, key)}
              onAuxClick={(e) => { if (e.button === 1) close(key, true) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(cwd, key) }
                if (e.key === 'Delete') close(key, false)
              }}
            >
              {icon}
              <span className="tab-title">{title}</span>
              {badge && <span className="gs" data-s={badge}>{badge}</span>}
              {dirty[dirtyKey(cwd, key)] && <span className="tab-dirty" aria-label="не сохранено" />}
              <button
                type="button"
                className="icon-btn icon-btn-sm tab-close"
                aria-label={`Закрыть «${title}»`}
                onClick={(e) => { e.stopPropagation(); close(key, true) }}
              >
                <X />
              </button>
            </div>
          )
        })}
      </div>
      <MenuButton
        label="Новая вкладка в этом дереве"
        icon={<Plus />}
        items={[
          { label: 'Новый чат', icon: <MessageSquarePlus />, onSelect: () => void newChat(where()) },
          { label: 'Новый терминал', icon: <SquareTerminal />, onSelect: () => void newTerminal(where()) },
          { label: 'Новый чат с настройками…', icon: <MessageSquare />, onSelect: () => openDialog({ kind: 'chat', cwd, workspaceId: workspaceFor(cwd) ?? undefined }) },
          ...(hasFeature('folders') ? [{ label: 'Новый чат в папке…', icon: <FolderOpen />, onSelect: () => openDialog({ kind: 'folder-chat' }) }] : []),
        ]}
      />
      <div className="grow" />
    </div>
  )
}

function describeTab(t: Tab, sessions: Session[], status: GitStatus | null) {
  switch (t.kind) {
    case 'session': {
      const s = sessions.find((x) => x.id === t.id)
      if (!s) return { icon: <MessageSquare />, title: 'Сессия', hint: t.id }
      return {
        icon: s.kind === 'terminal' ? <SquareTerminal /> : <StatusIcon session={s} />,
        title: s.title || s.id,
        hint: `${s.title}\n${s.cwd}`,
      }
    }
    case 'file': {
      const p = t.path.replace(/\\/g, '/')
      const badge = status?.files.find((f) => f.path.replace(/\\/g, '/') === p)?.status
      return { icon: <FileText />, title: basename(t.path), hint: t.path, badge, file: true }
    }
    case 'diff': return { icon: <GitCompare />, title: t.path ? basename(t.path) : 'Все изменения', hint: `Изменения: ${t.path ?? 'все файлы'}` }
  }
}
