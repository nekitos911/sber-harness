import type { Notification, Session, Task } from '../types'

/** The agents the UI counts and lists: chats, not archived, not harness-internal, not a CLI's internal sub-agent. */
export const listedChat = (s: Session) => s.kind === 'chat' && !s.archived && !s.system && !s.virtual

/** A chat that waits for the person (question, permission, login); a sub-agent's request shows in its parent. */
export const waitsForMe = (s: Session) => !s.archived && !s.virtual && (s.waitingFor === 'answer' || s.waitingFor === 'permission' || s.waitingFor === 'auth')

/** A task whose agent reported it done and nobody has taken it further yet (no PR, not closed, not reworked). */
export const doneForReview = (t: Task) => t.agentState === 'done' && t.status !== 'done' && !t.pr

/** An escalation the person has not handled yet (an agent stopped without a report or with an error). */
export const openEscalation = (n: Notification) => n.kind === 'escalation' && !n.read

/** «Ждёт меня»: what needs the person now — for the inbox, the tab title and the sidebar count. */
export const pendingCount = (sessions: Session[], tasks: Task[], notifications: Notification[] = []) =>
  sessions.filter(waitsForMe).length + tasks.filter(doneForReview).length + notifications.filter(openEscalation).length
