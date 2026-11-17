import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, FileText, FolderPlus, Inbox, MessageSquare, Moon, PanelLeft, PanelRight, SquareKanban, SquareTerminal } from 'lucide-react'
import { getState, openDialog, openSession, openTab, openTask, setState, useStore } from '../store'
import { StatusIcon } from './bits'

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
    { id: 'chat', label: 'Новый чат', icon: <MessageSquare />, run: () => openDialog({ kind: 'chat' }) },
    { id: 'term', label: 'Новый терминал', icon: <SquareTerminal />, run: () => openDialog({ kind: 'terminal' }) },
    { id: 'ws', label: 'Добавить проект', icon: <FolderPlus />, run: () => openDialog({ kind: 'workspace' }) },
    { id: 'board', label: 'Доска задач', icon: <SquareKanban />, run: () => openTab({ kind: 'board' }) },
    { id: 'agents', label: 'Агенты', icon: <Bot />, run: () => openTab({ kind: 'agents' }) },
    { id: 'inbox', label: 'Входящие', icon: <Inbox />, run: () => openTab({ kind: 'inbox' }) },
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
      onClose={onClose}
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
