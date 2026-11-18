import { api, errorText } from '../api'
import { getState, setState, toast, wtKey } from '../store'
import { endJob, startJob, watchJob } from './jobs'
import { refreshGit } from './git'
import { loadPr } from './pr'
import { shortHash } from './format'

export type GitKind = 'commit' | 'push' | 'pr'
export type GitVia = 'agent' | 'harness'

/** A commit / push / PR the agent does (git.via «agent»): its hooks and skills run; the result comes when its turn ends. */
export interface AgentGitJob {
  kind: GitKind
  sessionId: string | null
  started: number
  status: 'running' | 'ok' | 'error'
  text?: string // «Коммит a1b2c3d создан» / «Ветка отправлена» / «PR #562 создан»
  url?: string | null
  error?: string
  direct?: () => void // «Сделать напрямую»: the same with via harness
}

/** The server finishes the job with the effect it verified: { ok, hash | url | branch, error } (also accepted at the top level). */
interface JobDone { error?: string; result?: { ok?: boolean; hash?: string; url?: string; branch?: string; index?: number; error?: string }; ok?: boolean; hash?: string; url?: string; branch?: string; index?: number }

const DONE_TEXT: Record<GitKind, (r: NonNullable<JobDone['result']>) => string> = {
  commit: (r) => `Коммит ${r.hash ? shortHash(r.hash) + ' ' : ''}создан`,
  push: (r) => (r.branch ? `Ветка ${r.branch} отправлена` : 'Ветка отправлена'),
  pr: (r) => { const n = r.index ?? Number(/(\d+)\/?$/.exec(r.url ?? '')?.[1] ?? NaN); return Number.isFinite(n) ? `PR #${n} создан` : 'PR создан' },
}

/**
 * POST /git/<kind> with `via`. Direct (harness): resolves to the answer as before. Through the agent: the answer comes at
 * once with the session that does it; the line under the buttons follows the job; `onOk` runs when the effect is there.
 */
export async function gitAction<T>(cwd: string, kind: GitKind, body: Record<string, unknown>, via: GitVia | undefined, onOk?: () => void): Promise<T | 'agent' | undefined> {
  const jobId = startJob('', true)
  try {
    const res = await api<T & { via?: string; sessionId?: string; job?: string }>('POST', `/git/${kind}`, { cwd, ...body, ...(via ? { via } : {}) }, { jobId })
    if (res?.via !== 'agent') return res
    const k = wtKey(cwd)
    const direct = () => void gitAction(cwd, kind, body, 'harness', onOk).then((r) => { if (r && r !== 'agent') { clear(cwd); onOk?.(); refreshGit(cwd); loadPr(cwd, true) } })
    setState((s) => ({ agentGit: { ...s.agentGit, [k]: { kind, sessionId: res.sessionId ?? null, started: Date.now(), status: 'running', direct } } }))
    watchJob(typeof res.job === 'string' ? res.job : jobId, (ev: JobDone) => {
      const r = ev.result ?? ev
      const ok = !ev.error && !r.error && r.ok !== false
      setState((s) => ({ agentGit: { ...s.agentGit, [k]: { ...s.agentGit[k]!, status: ok ? 'ok' : 'error', text: ok ? DONE_TEXT[kind](r) : undefined, url: r.url ?? null, error: ok ? undefined : ev.error || r.error || 'агент не подтвердил результат' } } }))
      refreshGit(cwd)
      loadPr(cwd, true)
      if (ok) onOk?.()
    })
    return 'agent'
  } catch (e) {
    toast(errorText(e), 'error')
    return undefined
  } finally {
    endJob(jobId)
  }
}

export const clear = (cwd: string) => setState((s) => { const a = { ...s.agentGit }; delete a[wtKey(cwd)]; return { agentGit: a } })

/** git.via from the settings: «agent» unless set otherwise; undefined when this server cannot do it through the agent. */
export const currentVia = (): GitVia | undefined => (getState().features.includes('git-via-agent') ? (getState().settings?.git.via ?? 'agent') : undefined)
