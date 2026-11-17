import { Circle, CircleCheck, CircleDashed, CircleDot, CircleHelp, CircleSlash, CircleX, Clock, GitBranch, KeyRound, Lock, LoaderCircle, RotateCw, Square, SquareTerminal, TriangleAlert, type LucideIcon } from 'lucide-react'
import { sessionVisualState, STATE_LABEL, type VisualState } from '../lib/sessionState'
import type { Session, SubAgentState } from '../types'

type StatusLike = Pick<Session, 'status' | 'kind'> & Partial<Pick<Session, 'phase' | 'waitingFor' | 'stalled'>>

export const statusText = (s: StatusLike) => STATE_LABEL[sessionVisualState(s)]

const ICONS: Record<VisualState, LucideIcon> = {
  waiting_answer: CircleHelp,
  stalled: TriangleAlert,
  auth: KeyRound,
  starting: CircleDashed,
  running: LoaderCircle,
  error: CircleX,
  stopped: Square,
  done: CircleCheck,
  exited: SquareTerminal,
  terminal: SquareTerminal,
  idle: Circle,
}

/** The session's state as an icon whose colour and shape differ per state; the words are in aria-label. */
export function StatusIcon({ session }: { session: StatusLike }) {
  const v = sessionVisualState(session)
  const Icon = ICONS[v]
  return <Icon className="st" data-s={v} role="img" aria-label={STATE_LABEL[v]} />
}

const LEGEND: VisualState[] = ['running', 'starting', 'waiting_answer', 'stalled', 'auth', 'idle', 'done', 'error', 'stopped']

/** One line explaining the state icons (agents screen header). */
export function StateLegend() {
  return (
    <ul className="state-legend" aria-label="Обозначения состояний">
      {LEGEND.map((v) => {
        const Icon = ICONS[v]
        return <li key={v}><Icon className="st" data-s={v} aria-hidden />{STATE_LABEL[v]}</li>
      })}
    </ul>
  )
}

/** Branch names like feature/JIRA-1234-release-1.54.0: mono, truncated, full name in the tooltip. */
export function Branch({ name }: { name: string | null | undefined }) {
  if (!name) return null
  return (
    <span className="branch" data-tip={name}>
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

/** Placeholder rows shaped like the content that is loading (no spinner in the middle of a list). */
export function Skeleton({ rows = 3, label = 'Загрузка…' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <span key={i} style={{ width: `${88 - ((i * 23) % 40)}%` }} />)}
    </div>
  )
}
