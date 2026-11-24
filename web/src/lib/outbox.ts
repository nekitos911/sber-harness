import { useSyncExternalStore } from 'react'
import { api, ApiError, errorText } from '../api'
import { getState, setDraft, toast } from '../store'
import type { Message, Session } from '../types'

/**
 * A message the person sent that the chat has not shown yet: it shows at the end of the chat at once («Отправляется»),
 * until the server's own copy (a user message or a queue item with this text) comes over WS. One the server refused
 * stays, «Не отправлено» with «Повторить».
 */
export interface Outgoing { id: string; sessionId: string; text: string; cut: boolean; force?: boolean; at: number; error: string | null; sent: boolean; draft: string }

let list: Outgoing[] = []
const subs = new Set<() => void>()
const put = (next: Outgoing[]) => { list = next; subs.forEach((f) => f()) }
const patch = (id: string, fields: Partial<Outgoing>) => put(list.map((o) => (o.id === id ? { ...o, ...fields } : o)))
export const dropOutgoing = (id: string) => put(list.filter((o) => o.id !== id))

export function useOutbox(): Outgoing[] {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => list)
}

/** The server's copy is here: a user message or a queued one with the same text, not older than this send. */
export const arrived = (o: Outgoing, messages: Message[], session: Session) =>
  (session.queue ?? []).some((q) => q.from === 'user' && q.text === o.text)
  || messages.some((m) => m.kind === 'user' && m.text === o.text && m.at >= o.at - 5000)

async function post(o: Outgoing): Promise<boolean> {
  try {
    await api('POST', `/sessions/${o.sessionId}/messages`, { text: o.text, ...(o.cut ? { cut: true } : {}), ...(o.force ? { force: true } : {}) })
    patch(o.id, { sent: true, error: null })
    // its own copy normally came over WS already; a lost one must not leave the bubble forever
    window.setTimeout(() => dropOutgoing(o.id), 15_000)
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) toast(errorText(e), 'info') // e.g. GigaCode took the chat in a terminal meanwhile
    patch(o.id, { error: e instanceof ApiError && e.status === 401 ? 'сервер перезапущен — обновите страницу' : errorText(e) })
    return false
  }
}

/**
 * `draft`: what the input held, so a retry that goes through can clear it if it was put back there unchanged.
 * `force`: sent even though GigaCode is writing this chat in a terminal (the person took it over).
 */
export function deliver(sessionId: string, text: string, cut: boolean, draft: string, force = false): Promise<boolean> {
  const o: Outgoing = { id: `out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, sessionId, text, cut, force, at: Date.now(), error: null, sent: false, draft }
  put([...list, o])
  sent(sessionId)
  return post(o)
}

/** «Повторить» on a refused one; when it goes through, the same text put back into the input leaves it. */
export async function retryOutgoing(id: string) {
  const o = list.find((x) => x.id === id)
  if (!o || !o.error) return
  patch(id, { error: null })
  if (!(await post(o))) return
  if (getState().drafts[o.sessionId] === o.draft) setDraft(o.sessionId, '')
  sent(o.sessionId)
}

/** The chat scrolls to the bottom; its input, emptied, drops the attachment cards that were put back with the text. */
const sent = (sessionId: string) => window.dispatchEvent(new CustomEvent('harness:sent', { detail: sessionId }))
