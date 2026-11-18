import { api, ApiError, errorText, qs } from '../api'
import { getState, hasFeature, setState } from '../store'

/** GET /api/prs (feature prs-mine): every open PR of the person across repositories, or those behind tasks. */
export type PrScope = 'mine' | 'tracked'
export interface PrItem {
  workspaceId: string | null; repo: string; project?: string | null; index: number; title: string
  state: 'open' | 'merged' | 'declined'; url: string; head: string; base: string; author?: string | null
  reviewers: { name: string; status: string }[]; mergeable: boolean | null; updatedAt: number; createdAt?: number
  taskId?: string | null; taskKey?: string | null; sessionId?: string | null; byAgent?: boolean
}
export interface PrList { me?: string | null; items: PrItem[]; errors: { repo: string; error: string }[]; at: number }
/** null = loading; 'off' = no PR server on this machine; { error } = could not ask. */
export type PrListState = PrList | null | 'off' | { error: string }

const inflight = new Set<string>()

export function loadPrsMine(scope: PrScope, refresh = false) {
  if (!hasFeature('prs-mine') || inflight.has(scope)) return
  if (!refresh && getState().prsMine[scope] !== undefined) return
  inflight.add(scope)
  if (refresh && !getState().prsMine[scope]) setState((s) => ({ prsMine: { ...s.prsMine, [scope]: null } }))
  api<PrList>('GET', `/prs${qs({ scope, refresh: refresh ? 1 : undefined })}`)
    .then((r): PrListState => ({ me: r?.me ?? null, items: Array.isArray(r?.items) ? r.items : [], errors: Array.isArray(r?.errors) ? r.errors : [], at: r?.at ?? Date.now() }))
    .catch((e): PrListState => (e instanceof ApiError && (e.status === 501 || e.status === 404) ? 'off' : { error: errorText(e) }))
    .then((v) => setState((s) => ({ prsMine: { ...s.prsMine, [scope]: v } })))
    .finally(() => inflight.delete(scope))
}

