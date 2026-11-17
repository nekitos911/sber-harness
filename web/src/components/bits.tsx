import { CircleCheck, CircleDashed, CircleDot, CirclePause, CircleSlash, CircleStop, Clock, GitBranch, Lock, LoaderCircle, RotateCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { SESSION_STATUS } from '../lib/format'
import type { Session, SubAgentState } from '../types'

type StatusLike = Pick<Session, 'status' | 'kind'>

export const statusText = (s: StatusLike) => (s.kind === 'terminal' && s.status === 'idle' ? 'запущен' : SESSION_STATUS[s.status])

const ICONS = {
  running: LoaderCircle,
  idle: CircleDot,
  stopped: CirclePause,
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

const SUB: Record<SubAgentState, { icon: LucideIcon; tone: string; label: string }> = {
  queued: { icon: Clock, tone: 'off', label: 'в очереди' },
  working: { icon: LoaderCircle, tone: 'running', label: 'работает' },
  restarting: { icon: RotateCw, tone: 'running', label: 'перезапуск' },
  compacting: { icon: LoaderCircle, tone: 'running', label: 'сжатие контекста' },
  waiting: { icon: CircleDot, tone: 'idle', label: 'ждёт' },
  blocked: { icon: Lock, tone: 'failed', label: 'заблокирован' },
  idle: { icon: CircleDot, tone: 'idle', label: 'простаивает' },
  done: { icon: CircleCheck, tone: 'done', label: 'готово' },
  failed: { icon: TriangleAlert, tone: 'failed', label: 'провал' },
  interrupted: { icon: CircleSlash, tone: 'off', label: 'прерван' },
  unverifiable: { icon: CircleDashed, tone: 'off', label: 'нет сигнала' },
}

export const subStateLabel = (s: SubAgentState) => SUB[s]?.label ?? s

/** State of an agent-internal sub-agent; "unverifiable" is a grey dashed circle. */
export function SubStateIcon({ state }: { state: SubAgentState }) {
  const { icon: Icon, tone } = SUB[state] ?? SUB.unverifiable
  return <Icon className="st" data-s={tone} role="img" aria-label={subStateLabel(state)} />
}
