import { useEffect } from 'react'
import { api, ApiError, errorText, qs } from '../api'
import { getState, hasFeature, openScreen, setState, useFeature, useStore, wtKey } from '../store'
import type { PrInfo } from '../types'

/** null = no PR for this branch; 'off' = PR integration disabled; error = could not ask. */
export type PrState = PrInfo | null | 'off' | { error: string }

const inflight = new Set<string>()

export function loadPr(cwd: string, force = false) {
  if (!hasFeature('pr-status')) return
  const k = wtKey(cwd)
  if (inflight.has(k) || (!force && k in getState().prs)) return
  inflight.add(k)
  api<{ pr: PrInfo | null; error?: string }>('GET', `/git/pr-status${qs({ cwd })}`)
    .then((r): PrState => (r.error && !r.pr ? { error: r.error } : r.pr ?? null))
    .catch((e): PrState => (e instanceof ApiError && (e.status === 501 || e.status === 404) ? 'off' : { error: errorText(e) }))
    .then((v) => setState((s) => ({ prs: { ...s.prs, [k]: v } })))
    .finally(() => inflight.delete(k))
}

/** PR of the branch checked out in `cwd`; re-asked when the git state there changes (commit, push, checkout). */
export function usePr(cwd: string | null) {
  const git = useStore((s) => (cwd ? s.git[wtKey(cwd)] : undefined))
  const on = useFeature('pr-status')
  useEffect(() => { if (cwd && on) loadPr(cwd, true) }, [cwd, git?.status?.branch, git?.status?.ahead, on])
  return useStore((s) => (cwd ? s.prs[wtKey(cwd)] : undefined))
}

export const PR_STATE: Record<PrInfo['state'], string> = { open: 'открыт', merged: 'влит', declined: 'отклонён' }

/** «на ревью 1/2»: approvals out of reviewers. */
export function reviewText(pr: Pick<PrInfo, 'reviewers' | 'state'>) {
  const all = pr.reviewers?.length ?? 0
  if (!all || pr.state !== 'open') return ''
  const ok = pr.reviewers.filter((r) => /approv|принят|одобр/i.test(r.status)).length
  return `на ревью ${ok}/${all}`
}

/** Settings → «Pull requests». */
export function openPrSettings() {
  openScreen('settings')
  window.setTimeout(() => document.getElementById('set-pr')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 200)
}
