import type { NotificationKind, SessionRole, TaskStatus } from '../types'

export const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'Бэклог' },
  { id: 'todo', label: 'К работе' },
  { id: 'in_progress', label: 'В работе' },
  { id: 'review', label: 'Ревью' },
  { id: 'done', label: 'Готово' },
]
export const statusLabel = (s: TaskStatus) => COLUMNS.find((c) => c.id === s)?.label ?? s

export const ROLE: Record<SessionRole, string> = { solo: 'solo', coordinator: 'координатор', worker: 'исполнитель', reviewer: 'ревью', subagent: 'субагент' }

export const PRIORITY = { high: 'Высокий', medium: 'Средний', low: 'Низкий' } as const

export const NOTIFY_KIND: Record<NotificationKind, string> = {
  question: 'Вопрос', permission: 'Разрешение', recovery: 'Восстановление', done: 'Готово', failed: 'Провал', escalation: 'Эскалация', info: 'Инфо', error: 'Ошибка',
}

export function relTime(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'только что' // never seconds: clocks tick every 30 s
  const m = Math.round(s / 60)
  if (m < 60) return `${m} мин`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} д`
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

// one formatter: toLocaleString builds a new one per call (~0.1 ms each, a long chat calls it per message)
const FULL_TIME = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' })
export const fullTime = (at: number) => FULL_TIME.format(at)

export const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export function folderCrumbs(path: string) {
  const windowsRoot = path.match(/^(?:[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/)?.[0]
  const root = windowsRoot ?? '/'
  const sep = root.includes('\\') ? '\\' : '/'
  const crumbs = [{ name: root, path: root }]
  let current = root
  for (const part of path.slice(root.length).split(windowsRoot ? /[\\/]+/ : /\/+/).filter(Boolean)) {
    current += (current.endsWith(sep) ? '' : sep) + part
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

/** Path identity for matching sessions to worktrees (Windows paths are case-insensitive). */
// cached: sidebar rows and the tree call it for every session on every store change (0.6 s of a 20-chat switch run)
const normed = new Map<string, string>()
export const normPath = (p: string) => {
  let n = normed.get(p)
  if (n === undefined) {
    if (normed.size > 5000) normed.clear()
    normed.set(p, (n = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()))
  }
  return n
}

export const isAbsolutePath = (p: string) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p.trim())

export const shortHash = (h: string) => h.slice(0, 7)

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/** 119500 -> "119.5k", 2400000 -> "2.4M" */
export function tokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${+(n / 1000).toFixed(1)}k`
  return `${+(n / 1_000_000).toFixed(1)}M`
}

/** A sub-agent's title «<profile> · <task>» (older: «<profile>: <task>») → [profile, task]. */
export const subTitle = (title: string): [string, string] | undefined => {
  const m = /^([\w.-]{2,40})(?: ·|:)\s+(.+)$/.exec(title)
  return m ? [m[1], m[2]] : undefined
}

/** A reviewer's status in three kinds (UNAPPROVED is not approved: the negatives are checked first). */
export function reviewKind(status: string): 'approved' | 'changes' | 'pending' {
  if (/needs|change|reject|declin|замеч|отклон/i.test(status)) return 'changes'
  if (/un.?approv|not.?approv|pending|waiting|не одобр/i.test(status)) return 'pending'
  return /approv|одобр|принят/i.test(status) ? 'approved' : 'pending'
}

/** «только что» · «5 мин назад» · «3 ч назад» */
export function ago(at: number, now = Date.now()) {
  const r = relTime(at, now)
  return /^\d+ (мин|ч|д)$/.test(r) ? `${r} назад` : r // «только что» and a date stay as they are
}
