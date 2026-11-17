import type { Session, Task } from '../types'

/** A chat that waits for the person (question, permission, login); a sub-agent's request shows in its parent. */
export const waitsForMe = (s: Session) => !s.archived && !s.virtual && (s.waitingFor === 'answer' || s.waitingFor === 'permission' || s.waitingFor === 'auth')

/** A task whose agent reported it done and nobody has taken it further yet (no PR, not closed, not reworked). */
export const doneForReview = (t: Task) => t.agentState === 'done' && t.status !== 'done' && !t.pr

/** «Ждёт меня»: what needs the person now — for the inbox, the tab title and the sidebar count. */
export const pendingCount = (sessions: Session[], tasks: Task[]) => sessions.filter(waitsForMe).length + tasks.filter(doneForReview).length
