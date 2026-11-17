import { useEffect } from 'react'
import { api, qs } from '../api'
import { getState, hasFeature, setState, useFeature, useStore, wtKey } from '../store'
import type { HistoryItem } from '../types'

const inflight = new Set<string>()

/** CLI sessions recorded for a folder (GET /history?cwd=), newest first; cached per folder in the store. */
export function loadHistory(cwd: string, force = false) {
  if (!hasFeature('cli-history')) return
  const k = wtKey(cwd)
  if (inflight.has(k) || (!force && k in getState().history)) return
  inflight.add(k)
  api<HistoryItem[]>('GET', `/history${qs({ cwd })}`)
    .then((list) => (Array.isArray(list) ? [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) : []))
    .catch(() => [] as HistoryItem[])
    .then((list) => setState((s) => ({ history: { ...s.history, [k]: list } })))
    .finally(() => inflight.delete(k))
}

export function useHistory(cwd: string | null, on = true) {
  const enabled = useFeature('cli-history')
  useEffect(() => { if (cwd && on && enabled) loadHistory(cwd) }, [cwd, on, enabled])
  return useStore((s) => (cwd ? s.history[wtKey(cwd)] : undefined))
}
