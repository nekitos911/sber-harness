import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, FileText, FolderPlus, GitBranchPlus, Inbox, MessageSquare, Moon, PanelLeft, PanelRight, Settings, SquareKanban, SquareTerminal } from 'lucide-react'
import { getState, openDialog, openScreen, openSession, openTask, setState, useStore } from '../store'
import { StatusIcon } from './bits'
import { currentWhere, newChat, newTerminal } from '../lib/actions'

const dialogWhere = () => {
  const w = currentWhere()
  return { cwd: w.cwd ?? undefined, workspaceId: w.workspaceId ?? undefined }
}

interface Command { id: string; label: string; hint?: string; icon: ReactNode; run: () => void }

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const d = ref.current
    d?.showModal()
    return () => d?.close()
  }, [])

  const commands = useMemo<Command[]>(() => [
    { id: 'chat', label: 'Новый чат', icon: <MessageSquare />, run: () => void newChat(currentWhere()) },
    { id: 'chat-form', label: 'Новый чат с настройками…', icon: <MessageSquare />, run: () => openDialog({ kind: 'chat', ...dialogWhere() }) },
    { id: 'worktree', label: 'Новое рабочее дерево', icon: <GitBranchPlus />, run: () => openDialog({ kind: 'worktree' }) },
    { id: 'settings', label: 'Настройки', icon: <Settings />, run: () => openScreen('settings') },
    { id: 'term', label: 'Новый терминал', icon: <SquareTerminal />, run: () => { const w = currentWhere(); if (w.cwd) void newTerminal(w); else openDialog({ kind: 'terminal' }) } },
    { id: 'term-form', label: 'Новый терминал с настройками…', icon: <SquareTerminal />, run: () => openDialog({ kind: 'terminal', ...dialogWhere() }) },
    { id: 'ws', label: 'Добавить проект', icon: <FolderPlus />, run: () => openDialog({ kind: 'workspace' }) },
    { id: 'board', label: 'Доска задач', icon: <SquareKanban />, run: () => openScreen('board') },
    { id: 'agents', label: 'Агенты', icon: <Bot />, run: () => openScreen('agents') },
    { id: 'inbox', label: 'Входящие', icon: <Inbox />, run: () => openScreen('inbox') },
    { id: 'sidebar', label: 'Показать/скрыть боковую панель', icon: <PanelLeft />, run: () => setState((s) => ({ sidebar: !s.sidebar })) },
    { id: 'panel', label: 'Показать/скрыть панель файлов', icon: <PanelRight />, run: () => setState((s) => ({ panel: !s.panel })) },
    { id: 'theme', label: 'Переключить тему', icon: <Moon />, run: () => setState({ theme: getState().scheme === 'dark' ? 'light' : 'dark' }) },
    ...sessions.map((s) => ({
      id: `s:${s.id}`, label: s.title || s.id, hint: s.kind === 'terminal' ? 'терминал' : s.agent,
      icon: s.kind === 'terminal' ? <SquareTerminal /> : <StatusIcon session={s} />, run: () => openSession(s.id),
    })),
    ...tasks.map((t) => ({ id: `t:${t.id}`, label: `${t.externalId ?? t.id} ${t.title}`, hint: 'задача', icon: <FileText />, run: () => openTask(t.id) })),
  ], [sessions, tasks])

  const needle = q.trim().toLowerCase()
  const shown = (needle ? commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(needle)) : commands).slice(0, 50)
  const current = Math.min(index, shown.length - 1)

  const run = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  return (
    <dialog
      ref={ref}
      className="dialog palette"
      aria-label="Команды"
      onClose={(e) => { if (!e.currentTarget.open) onClose() }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <input
        className="input palette-input"
        autoFocus
        placeholder="Команда, сессия или задача…"
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={shown[current] ? `cmd-${current}` : undefined}
        value={q}
        onChange={(e) => { setQ(e.target.value); setIndex(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((current + 1) % Math.max(1, shown.length)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((current - 1 + shown.length) % Math.max(1, shown.length)) }
          if (e.key === 'Enter') { e.preventDefault(); run(shown[current]) }
        }}
      />
      <div className="palette-list" id="palette-list" role="listbox">
        {shown.map((c, i) => (
          <div
            key={c.id}
            id={`cmd-${i}`}
            role="option"
            aria-selected={i === current}
            className="palette-item"
            onMouseMove={() => setIndex(i)}
            onClick={() => run(c)}
          >
            {c.icon}
            <span className="ellipsis grow">{c.label}</span>
            {c.hint && <span className="muted mono">{c.hint}</span>}
          </div>
        ))}
        {shown.length === 0 && <p className="muted" style={{ padding: 12 }}>Ничего не найдено</p>}
      </div>
    </dialog>
  )
}
