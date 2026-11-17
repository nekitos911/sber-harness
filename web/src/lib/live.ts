import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { ensureMessages } from '../ws'
import type { Session } from '../types'
import { dur, sessionVisualState, STATE_LABEL } from './sessionState'

/** Name of the tool the session is running right now (from its transcript, when loaded). */
export function useCurrentTool(s: Session) {
  const running = s.kind === 'chat' && s.status === 'running'
  useEffect(() => { if (running) ensureMessages(s.id) }, [running, s.id])
  return useStore((st) => {
    if (!running) return ''
    const list = st.messages[s.id]
    if (!list) return ''
    for (let i = list.length - 1; i >= 0 && i >= list.length - 40; i--) {
      const m = list[i]
      if (m.kind === 'tool' && m.tool) return m.tool.status === 'running' ? m.tool.name : ''
    }
    return ''
  })
}


/** Re-render every second while `on`. */
function useSecondTick(on: boolean) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [on])
}

/** Seconds since `since`, ticking every second while `on` (cold starts take 30-60 s, a 30 s clock is too coarse). */
export function useElapsed(since: number, on: boolean) {
  useSecondTick(on)
  return on ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0
}

/** When the current turn started: its user message (transcript loaded for running sessions), else 0. */
export function useTurnStart(s: Session) {
  return useStore((st) => {
    if (s.status !== 'running') return 0
    const list = st.messages[s.id]
    for (let i = (list?.length ?? 0) - 1; i >= 0; i--) if (list![i].kind === 'user') return list![i].at
    return 0
  })
}

/** Words for a session's state with a ticking clock where time matters; '' for idle (rows show model and age). */
export function useStateLine(s: Session) {
  const v = sessionVisualState(s)
  const start = useTurnStart(s)
  useSecondTick(v === 'running' || v === 'starting' || v === 'stalled')
  const now = Date.now()
  if (v === 'running') return start ? `работает · ${dur(now - start)}` : 'работает'
  if (v === 'starting') return `запуск · ${dur(now - s.lastActivityAt)}`
  if (v === 'stalled') return `нет вывода ${dur(now - (s.lastEventAt ?? s.lastActivityAt))}`
  return v === 'idle' || v === 'terminal' ? '' : STATE_LABEL[v]
}

/** «Запуск… ждём MCP · 12 с» while the agent process is up but has not said anything yet. */
export function useStartingLabel(s: Session) {
  const starting = s.status === 'running' && s.phase === 'starting'
  const sec = useElapsed(s.lastActivityAt, starting)
  return starting ? `Запуск… ждём MCP · ${sec} с` : ''
}
