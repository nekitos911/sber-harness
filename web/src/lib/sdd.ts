import { useEffect } from 'react'
import { api, qs } from '../api'
import { getState, hasFeature, setState, useFeature, useStore, wtKey } from '../store'
import type { GitStatus, SddPlan } from '../types'

const inflight = new Set<string>()

/** Store key: a folder's plans, or only those relevant to one chat (its task key, files it changed). */
export const sddKey = (cwd: string, sessionId?: string | null) => (sessionId ? `${wtKey(cwd)}|${sessionId}` : wtKey(cwd))

/** Server plans in a safe shape (missing arrays → []); keeps progress.done (null = no markers in the ledger). */
export const normalizePlans = (plans: unknown): SddPlan[] => (Array.isArray(plans) ? (plans as SddPlan[]).map((p) => ({
  ...p,
  progress: { raw: p?.progress?.raw ?? '', items: Array.isArray(p?.progress?.items) ? p.progress.items : [], done: p?.progress?.done },
  verdicts: Array.isArray(p?.verdicts) ? p.verdicts : [],
})) : [])

/**
 * /full-task ledger and verdicts of a worktree — with `sessionId` only the plans of that chat; null when this server
 * has no /api/sdd. Live updates come over WS.
 */
export function loadSdd(cwd: string, force = false, sessionId?: string | null) {
  if (!hasFeature('sdd')) return
  const k = sddKey(cwd, sessionId)
  if (inflight.has(k) || (!force && k in getState().sdd)) return
  inflight.add(k)
  api<{ plans: SddPlan[] }>('GET', `/sdd${qs({ cwd, sessionId })}`)
    .then((r) => normalizePlans(r?.plans), () => null)
    .then((plans) => setState((s) => ({ sdd: { ...s.sdd, [k]: plans } })))
    .finally(() => inflight.delete(k))
}

const sigs = new WeakMap<GitStatus, string>()
const gitSig = (st: GitStatus | null | undefined) => {
  if (!st) return ''
  let k = sigs.get(st)
  if (k === undefined) sigs.set(st, (k = `${st.branch}|${st.files.map((x) => `${x.path}:${x.status}:${x.added}:${x.removed}`).join()}`))
  return k
}

export function useSdd(cwd: string | null, sessionId?: string | null) {
  // what changed in the worktree, not each git poll: every chat tab kept open re-read its plans on every poll (6 calls a switch)
  const git = useStore((s) => gitSig(cwd ? s.git[wtKey(cwd)]?.status : undefined))
  const on = useFeature('sdd')
  useEffect(() => { if (cwd && on) loadSdd(cwd, true, sessionId) }, [cwd, git, on, sessionId])
  return useStore((s) => (cwd ? s.sdd[sddKey(cwd, sessionId)] : undefined))
}

/** Items done, or null when the ledger has no statuses at all (then it is a plain list, not progress). */
export function planDone(p: SddPlan): number | null {
  if (p.progress.done !== undefined) return p.progress.done
  if (!p.progress.items.some((i) => i.status)) return null
  return p.progress.items.filter((i) => /done|готов|pass|\[x\]/i.test(i.status ?? '')).length
}

export const failCount = (plans: SddPlan[] | null | undefined) =>
  (plans ?? []).reduce((n, p) => n + p.verdicts.filter((v) => v.status === 'FAIL').length, 0)

export const VERDICT_LABEL: Record<string, string> = {
  PASS: 'PASS', FAIL: 'FAIL', ESCALATION_REQUIRED: 'нужна эскалация', INDEPENDENT_VERIFICATION_REQUIRED: 'нужна независимая проверка',
}
