import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { ensureMessages } from '../ws'
import type { Session } from '../types'
import { CLI_LIVE_MS, cliLive, dur, sessionVisualState, STATE_LABEL } from './sessionState'

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

/** Whole seconds left until `at` (a start the harness will retry by itself), ticking; 0 once due or unset. */
export function useCountdown(at: number | null | undefined) {
  const left = at ? Math.ceil((at - Date.now()) / 1000) : 0
  useSecondTick(left > 0)
  return Math.max(0, left)
}

/** cliLive(s), re-checked when its 3 min run out: the chat unlocks by itself. */
export function useCliLive(s: Session) {
  const [, tick] = useState(0)
  const live = cliLive(s, Date.now())
  useEffect(() => {
    if (!live || !s.cliLiveAt) return
    const t = window.setTimeout(() => tick((n) => n + 1), s.cliLiveAt + CLI_LIVE_MS - Date.now() + 50)
    return () => window.clearTimeout(t)
  }, [live, s.cliLiveAt])
  return live
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
  if (v === 'starting') return s.startWait ? `ждёт запуска · ${s.startWait}-й в очереди` : `запуск · ${dur(now - s.lastActivityAt)}`
  if (v === 'stalled') return `нет вывода ${dur(now - (s.lastEventAt ?? s.lastActivityAt))}`
  return v === 'idle' || v === 'terminal' ? '' : STATE_LABEL[v]
}

/** «Запуск… ждём MCP · 12 с» while the agent process is up but has not said anything yet. */
export function useStartingLabel(s: Session) {
  const starting = s.status === 'running' && s.phase === 'starting'
  const sec = useElapsed(s.lastActivityAt, starting)
  if (starting && s.startWait) return `Ждёт своей очереди на запуск (${s.startWait}-й): агенты стартуют по очереди, чтобы не перегружать машину`
  return starting ? `Запуск… ждём MCP · ${sec} с` : ''
}
