import { ArrowLeft, ArrowRight, Bot, Command, FileText, GitCompare, Inbox, MessageSquare, PanelLeft, PanelRight, Plus, SquareKanban, SquareTerminal, X } from 'lucide-react'
import { activateTab, closeTab, navigate, openDialog, setState, tabKey, useStore, type Tab } from '../store'
import { basename } from '../lib/format'
import type { Session } from '../types'
import { StatusIcon } from './bits'
import { MenuButton } from './Menu'

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
  const back = useStore((s) => s.back)
  const forward = useStore((s) => s.forward)
  return (
    <header className="topbar">
      <div className="topbar-left">
        <BrandMark />
        <button type="button" className="icon-btn" aria-pressed={sidebar} aria-label="Боковая панель" title="Боковая панель" onClick={() => setState({ sidebar: !sidebar })}>
          <PanelLeft />
        </button>
        <button type="button" className="icon-btn" disabled={!back.length} aria-label="Назад" title="Назад" onClick={() => navigate('back')}>
          <ArrowLeft />
        </button>
        <button type="button" className="icon-btn" disabled={!forward.length} aria-label="Вперёд" title="Вперёд" onClick={() => navigate('forward')}>
          <ArrowRight />
        </button>
      </div>
      <TabBar />
      <div className="topbar-right">
        <button type="button" className="btn btn-ghost" onClick={onCommand} title="Команды (Ctrl+K)">
          <Command />
          Команда
        </button>
        <button type="button" className="icon-btn" aria-pressed={panel} aria-label="Панель файлов и изменений" title="Панель файлов и изменений" onClick={() => setState({ panel: !panel })}>
          <PanelRight />
        </button>
      </div>
    </header>
  )
}

function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.active)
  const sessions = useStore((s) => s.sessions)
  const dirty = useStore((s) => s.dirty)

  return (
    <>
      <div className="tabbar" role="tablist" aria-label="Открытые вкладки">
        {tabs.map((t) => {
          const key = tabKey(t)
          const { icon, title, hint } = describeTab(t, sessions)
          return (
            <div
              key={key}
              className="tab"
              role="tab"
              tabIndex={key === active ? 0 : -1}
              aria-selected={key === active}
              title={hint}
              onClick={() => activateTab(key)}
              onAuxClick={(e) => { if (e.button === 1) closeTab(key) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(key) }
                if (e.key === 'Delete') closeTab(key)
              }}
            >
              {icon}
              <span className="tab-title">{title}</span>
              {dirty[key] && <span className="tab-dirty" aria-label="не сохранено" />}
              <button
                type="button"
                className="icon-btn icon-btn-sm tab-close"
                aria-label={`Закрыть «${title}»`}
                onClick={(e) => { e.stopPropagation(); closeTab(key) }}
              >
                <X />
              </button>
            </div>
          )
        })}
      </div>
      <MenuButton
        label="Новая вкладка"
        icon={<Plus />}
        items={[
          { label: 'Новый чат', icon: <MessageSquare />, onSelect: () => openDialog({ kind: 'chat' }) },
          { label: 'Новый терминал', icon: <SquareTerminal />, onSelect: () => openDialog({ kind: 'terminal' }) },
        ]}
      />
      <div className="grow" />
    </>
  )
}

function describeTab(t: Tab, sessions: Session[]) {
  switch (t.kind) {
    case 'board': return { icon: <SquareKanban />, title: 'Задачи', hint: 'Доска задач' }
    case 'agents': return { icon: <Bot />, title: 'Агенты', hint: 'Агенты' }
    case 'inbox': return { icon: <Inbox />, title: 'Входящие', hint: 'Входящие' }
    case 'session': {
      const s = sessions.find((x) => x.id === t.id)
      if (!s) return { icon: <MessageSquare />, title: 'Сессия', hint: t.id }
      return {
        icon: s.kind === 'terminal' ? <SquareTerminal /> : <StatusIcon session={s} />,
        title: s.title || s.id,
        hint: `${s.title} — ${s.cwd}`,
      }
    }
    case 'file': return { icon: <FileText />, title: basename(t.path), hint: `${t.path} — ${t.cwd}` }
    case 'diff': return { icon: <GitCompare />, title: t.path ? basename(t.path) : `Изменения ${basename(t.cwd)}`, hint: `diff: ${t.path ?? 'все файлы'} — ${t.cwd}` }
  }
}
