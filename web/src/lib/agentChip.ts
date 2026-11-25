import type { Task } from '../types'

/** A chat as the chip needs it; `state`/`label` are sessionVisualState / STATE_LABEL (kept out: this module has no runtime imports). */
export interface ChipChat { id: string; title: string; state: string; label: string; since: number | null; archived?: boolean; queued?: number }

export interface Chip {
  text: string
  tone: 'run' | 'wait' | 'done' | 'fail'
  spin: boolean
  stalled: boolean // a review that should run but nothing runs it: looks stuck, not busy
  tip: string // what happens, since when, which chat — and what a click opens
  open: string | null // the chat the chip opens
  retry: boolean // «Повторить ревью» makes sense
}

const RUNNING = new Set(['running', 'starting'])
const ASKING = new Set(['waiting_answer', 'waiting_permission', 'auth'])
const GRACE_MS = 60_000 // between the reviewer's turns (a queued message, a restart) the review still counts as running

/**
 * The board chip of a task's agent state, explained: «Ревью силами harness, раунд 2 из 2: ревьюер «Ревью X» работает 12 мин.
 * Открыть чат ревьюера». A review whose reviewer does not run (gone, idle, failed) for a while reads as stalled.
 */
export function agentChip(task: Pick<Task, 'agentState' | 'review' | 'checks'>, worker: ChipChat, reviewer: ChipChat | null, now: number, dur: (ms: number) => string): Chip {
  const rv = task.review
  const round = rv ? `раунд ${rv.round}${rv.maxRounds ? ` из ${rv.maxRounds}` : ''}` : ''
  const head = `Ревью силами harness, ${round}`
  const toWorker = `открыть чат агента «${worker.title}»`
  const ToWorker = `Открыть чат агента «${worker.title}»`
  const base = { spin: false, stalled: false, retry: false }
  switch (task.agentState) {
    case 'reviewing': {
      const started = rv?.startedAt ?? now
      if (!reviewer || reviewer.archived) {
        if (!reviewer && now - started < GRACE_MS) return { ...base, text: 'ревью: запуск…', tone: 'run', spin: true, open: worker.id, tip: `${head}: ревьюер запускается. ${ToWorker}` }
        return { ...base, text: 'ревью стоит', tone: 'wait', stalled: true, retry: true, open: reviewer?.id ?? worker.id,
          tip: `${head}: ${reviewer ? 'чат ревьюера в архиве' : 'чата ревьюера нет'} уже ${dur(now - started)}, вердикта не будет. Повторите ревью или ${reviewer ? 'откройте чат ревьюера' : toWorker}` }
      }
      const r = `ревьюер «${reviewer.title}»`
      if (RUNNING.has(reviewer.state)) return { ...base, text: 'ревью…', tone: 'run', spin: true, open: reviewer.id, tip: `${head}: ${r} работает ${dur(now - started)}. Открыть чат ревьюера` }
      const idleFor = now - (reviewer.since ?? started)
      if (ASKING.has(reviewer.state)) return { ...base, text: `ревью: ${reviewer.label}`, tone: 'wait', open: reviewer.id, tip: `${head}: ${r} ${reviewer.label} ${dur(idleFor)}. Открыть чат ревьюера и ответить` }
      if (reviewer.state === 'stalled') return { ...base, text: 'ревью: нет вывода', tone: 'wait', stalled: true, open: reviewer.id, tip: `${head}: ${r} работает, но молчит ${dur(idleFor)}. Открыть чат ревьюера` }
      if (reviewer.queued || idleFor < GRACE_MS) return { ...base, text: 'ревью…', tone: 'run', spin: true, open: reviewer.id, tip: `${head}: ${r} начинает ход. Открыть чат ревьюера` }
      return { ...base, text: 'ревью стоит', tone: 'wait', stalled: true, retry: true, open: reviewer.id,
        tip: `${head}: ${r} не работает (${reviewer.label}) ${dur(idleFor)}, вердикт не получен. Откройте чат ревьюера и попросите закончить ревью (worker_done с VERDICT) или повторите ревью` }
    }
    case 'approved':
      return { ...base, text: 'ревью ✓', tone: 'done', open: reviewer?.id ?? worker.id, tip: `${head}: одобрено${reviewer ? ` ревьюером «${reviewer.title}». Открыть его чат` : `. ${ToWorker}`}` }
    case 'changes_requested': {
      const last = !!rv?.maxRounds && rv.round >= rv.maxRounds
      return { ...base, text: last ? 'ревью не сошлось' : 'замечания ревью', tone: last ? 'fail' : 'run', retry: last, open: worker.id,
        tip: last ? `${head}: замечания остались после последнего раунда. Дайте доработку или повторите ревью. ${ToWorker}`
          : `${head}: есть замечания, агент получил их и должен исправить, затем ревью повторится. ${ToWorker}` }
    }
    case 'review_stopped':
      return { ...base, text: 'ревью прервано', tone: 'fail', retry: true, open: worker.id,
        tip: `Ревью прервано${rv?.stoppedAt ? ` ${dur(now - rv.stoppedAt)} назад` : ''}: ${rv?.stoppedReason ?? 'причина неизвестна'}. Агент закончил, вердикта нет. ${ToWorker}` }
    case 'checking': {
      const ck = task.checks
      return { ...base, text: 'проверка…', tone: 'run', spin: true, open: worker.id,
        tip: `Проверка проекта перед «готово»${ck ? `, раунд ${ck.round}` : ''}${ck?.startedAt ? `: идёт ${dur(now - ck.startedAt)}` : ''}. Команду запускает harness. ${ToWorker}` }
    }
    case 'failed':
      return { ...base, text: task.checks?.state === 'failed' ? 'проверка не прошла' : 'агент: ошибка', tone: 'fail', open: worker.id,
        tip: task.checks?.state === 'failed' ? `Проверка проекта не прошла за ${task.checks.round} раунд(а): вывод в журнале задачи и в чате агента. ${ToWorker}` : `Агент «${worker.title}» остановился с ошибкой. Открыть чат` }
    default:
      return { ...base, text: worker.label, tone: 'run', open: worker.id, tip: `Агент «${worker.title}»: ${worker.label}. Открыть чат` }
  }
}

/** States shown as the chip instead of the live line (the session itself is idle while the harness checks or reviews). */
export const chipStates = (t: Pick<Task, 'agentState' | 'checks'>) =>
  t.agentState === 'reviewing' || t.agentState === 'approved' || t.agentState === 'changes_requested' || t.agentState === 'review_stopped'
  || t.agentState === 'checking' || (t.agentState === 'failed' && t.checks?.state === 'failed')
