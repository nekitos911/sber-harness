import { useEffect } from 'react'
import { getState, openSession, openTask, useStore } from '../store'
import type { Notification as Note } from '../types'

const KEY = 'harness.desktopNotify'
const KINDS = new Set(['question', 'done', 'failed', 'escalation', 'error'])
const TITLE: Record<string, string> = { question: 'Вопрос агента', done: 'Готово', failed: 'Провал', escalation: 'Эскалация', error: 'Ошибка' }

export function desktopNotifyOn() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

/** Turn desktop notifications on (asks the browser for permission the first time) or off. */
export async function setDesktopNotify(on: boolean): Promise<boolean> {
  if (on && 'Notification' in window && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission()
    if (p !== 'granted') return false
  }
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* storage blocked: off after reload */ }
  return on
}

/** Called for every new inbox entry: a desktop notification when the tab is hidden; click focuses and opens it. */
export function desktopNotify(n: Note) {
  if (n.read || !KINDS.has(n.kind) || !document.hidden || !desktopNotifyOn()) return
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const session = n.sessionId ? getState().sessions.find((s) => s.id === n.sessionId) : undefined
  const note = new Notification(`${TITLE[n.kind] ?? 'Harness'}${session ? `: ${session.title}` : ''}`, { body: n.text.slice(0, 240), tag: n.id })
  note.onclick = () => {
    window.focus()
    if (n.sessionId) openSession(n.sessionId)
    else if (n.taskId) openTask(n.taskId)
    note.close()
  }
}

/** «(2) Harness» in the browser tab while there are unread inbox entries. */
export function useUnreadTitle() {
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length)
  useEffect(() => { document.title = unread ? `(${unread}) Harness` : 'Harness' }, [unread])
}
