import type { NotificationKind, SessionRole, SessionStatus, TaskStatus } from '../types'

export const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'Бэклог' },
  { id: 'todo', label: 'К работе' },
  { id: 'in_progress', label: 'В работе' },
  { id: 'review', label: 'Ревью' },
  { id: 'done', label: 'Готово' },
]
export const statusLabel = (s: TaskStatus) => COLUMNS.find((c) => c.id === s)?.label ?? s

export const SESSION_STATUS: Record<SessionStatus, string> = {
  idle: 'ждёт ввода',
  running: 'работает',
  done: 'готово',
  failed: 'провал',
  exited: 'завершён',
  error: 'ошибка запуска',
}

export const ROLE: Record<SessionRole, string> = { solo: 'solo', coordinator: 'координатор', worker: 'исполнитель' }

export const PRIORITY = { high: 'Высокий', medium: 'Средний', low: 'Низкий' } as const

export const NOTIFY_KIND: Record<NotificationKind, string> = {
  question: 'Вопрос', done: 'Готово', failed: 'Провал', escalation: 'Эскалация', info: 'Инфо', error: 'Ошибка',
}

export function relTime(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'сейчас'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} мин`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} д`
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

export const fullTime = (at: number) => new Date(at).toLocaleString('ru-RU')

export const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** Path identity for matching sessions to worktrees (Windows paths are case-insensitive). */
export const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export const isAbsolutePath = (p: string) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p.trim())

export const shortHash = (h: string) => h.slice(0, 7)

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
