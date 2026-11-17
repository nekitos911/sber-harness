import { useEffect } from 'react'
import { api, qs } from '../api'
import { getState, setState, useStore, wtKey } from '../store'
import type { SddPlan } from '../types'

const inflight = new Set<string>()

/** /full-task ledger and verdicts of a worktree; null when this server has no /api/sdd. Live updates come over WS. */
export function loadSdd(cwd: string, force = false) {
  const k = wtKey(cwd)
  if (inflight.has(k) || (!force && k in getState().sdd)) return
  inflight.add(k)
  api<{ plans: SddPlan[] }>('GET', `/sdd${qs({ cwd })}`)
    .then((r) => r?.plans ?? [], () => null)
    .then((plans) => setState((s) => ({ sdd: { ...s.sdd, [k]: plans } })))
    .finally(() => inflight.delete(k))
}

export function useSdd(cwd: string | null) {
  const git = useStore((s) => (cwd ? s.git[wtKey(cwd)] : undefined))
  useEffect(() => { if (cwd) loadSdd(cwd, true) }, [cwd, git])
  return useStore((s) => (cwd ? s.sdd[wtKey(cwd)] : undefined))
}

export const failCount = (plans: SddPlan[] | null | undefined) =>
  (plans ?? []).reduce((n, p) => n + p.verdicts.filter((v) => v.status === 'FAIL').length, 0)

export const VERDICT_LABEL: Record<string, string> = {
  PASS: 'PASS', FAIL: 'FAIL', ESCALATION_REQUIRED: 'нужна эскалация', INDEPENDENT_VERIFICATION_REQUIRED: 'нужна независимая проверка',
}
