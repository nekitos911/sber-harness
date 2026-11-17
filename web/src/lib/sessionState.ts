import type { Session } from '../types'

/** What a session is doing, as the UI shows it: every state has its own icon, colour and words. */
export type VisualState =
  | 'waiting_answer' | 'stalled' | 'auth' | 'starting' | 'running' | 'error' | 'stopped' | 'done' | 'exited' | 'terminal' | 'idle'

type StateInput = Pick<Session, 'status' | 'kind'> & Partial<Pick<Session, 'phase' | 'waitingFor' | 'stalled'>>

/** The contract's priority order; fields an older server does not send count as absent. */
export function sessionVisualState(s: StateInput): VisualState {
  if (s.waitingFor === 'answer') return 'waiting_answer'
  if (s.status === 'running' && s.stalled) return 'stalled'
  if (s.phase === 'auth' || s.waitingFor === 'auth') return 'auth'
  if (s.status === 'running' && s.phase === 'starting') return 'starting'
  if (s.status === 'running') return 'running'
  if (s.status === 'error' || s.status === 'failed') return 'error'
  if (s.status === 'stopped') return 'stopped'
  if (s.status === 'done') return 'done'
  if (s.status === 'exited') return 'exited'
  return s.kind === 'terminal' ? 'terminal' : 'idle'
}

export const STATE_LABEL: Record<VisualState, string> = {
  waiting_answer: 'ждёт ответа', stalled: 'нет вывода', auth: 'нужен вход', starting: 'запуск', running: 'работает',
  error: 'ошибка', stopped: 'остановлен', done: 'готово', exited: 'завершён', terminal: 'запущен', idle: 'свободен',
}

/** 40 с · 7 мин · 3 ч */
export function dur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч`
}

/** States that need a person come first in summaries. */
const SUMMARY: [VisualState[], (n: number) => string][] = [
  [['waiting_answer'], (n) => (n === 1 ? 'ждёт ответа' : 'ждут ответа')],
  [['auth'], () => 'нужен вход'],
  [['stalled'], () => 'без вывода'],
  [['error'], (n) => (n % 10 === 1 && n % 100 !== 11 ? 'ошибка' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'ошибки' : 'ошибок')],
  [['running', 'starting'], (n) => (n === 1 ? 'работает' : 'работают')],
]

/** «1 ждёт ответа · 2 работают» over chat sessions: only non-zero groups, attention first; calm states are not counted. */
export function stateSummary(list: StateInput[]): { state: VisualState; text: string }[] {
  const n = new Map<VisualState, number>()
  for (const s of list) if (s.kind === 'chat') { const v = sessionVisualState(s); n.set(v, (n.get(v) ?? 0) + 1) }
  const out: { state: VisualState; text: string }[] = []
  for (const [states, word] of SUMMARY) {
    const c = states.reduce((a, st) => a + (n.get(st) ?? 0), 0)
    if (c) out.push({ state: states[0], text: `${c} ${word(c)}` })
  }
  return out
}
