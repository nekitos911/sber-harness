import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { ensureMessages } from '../ws'
import type { Session } from '../types'

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


/** Seconds since `since`, ticking every second while `on` (cold starts take 30-60 s, a 30 s clock is too coarse). */
export function useElapsed(since: number, on: boolean) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [on])
  return on ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0
}

/** «Запуск… ждём MCP · 12 с» while the agent process is up but has not said anything yet. */
export function useStartingLabel(s: Session) {
  const starting = s.status === 'running' && s.phase === 'starting'
  const sec = useElapsed(s.lastActivityAt, starting)
  return starting ? `Запуск… ждём MCP · ${sec} с` : ''
}
