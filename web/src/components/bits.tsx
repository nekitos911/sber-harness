import { CircleCheck, CircleDot, CircleStop, GitBranch, LoaderCircle, TriangleAlert } from 'lucide-react'
import { SESSION_STATUS } from '../lib/format'
import type { Session } from '../types'

type StatusLike = Pick<Session, 'status' | 'kind'>

export const statusText = (s: StatusLike) => (s.kind === 'terminal' && s.status === 'idle' ? 'запущен' : SESSION_STATUS[s.status])

const ICONS = {
  running: LoaderCircle,
  idle: CircleDot,
  done: CircleCheck,
  failed: TriangleAlert,
  error: TriangleAlert,
  exited: CircleStop,
}

export function StatusIcon({ session }: { session: StatusLike }) {
  const Icon = ICONS[session.status]
  return (
    <Icon className="st" data-s={session.status} data-kind={session.kind} role="img" aria-label={statusText(session)} />
  )
}

/** Branch names like feature/JIRA-1234-release-1.54.0: mono, truncated, full name in the tooltip. */
export function Branch({ name }: { name: string | null | undefined }) {
  if (!name) return null
  return (
    <span className="branch" title={name}>
      <GitBranch aria-hidden />
      <span>{name}</span>
    </span>
  )
}

export function Loading({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="empty" role="status">
      <LoaderCircle className="spinner empty-icon" aria-hidden />
      <p>{label}</p>
    </div>
  )
}
