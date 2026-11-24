import { api, ApiError, errorText, qs } from '../api'
import { getState, hasFeature, setState } from '../store'

/** GET /api/prs (feature prs-mine): every open PR of the person across repositories, or those behind tasks. */
export type PrScope = 'mine' | 'tracked' | 'review' | 'all' // review / all and states other than open: feature prs-filters
export type PrState = 'open' | 'merged' | 'declined' | 'all'
/** The store key of one list: the open lists keep their old keys ('mine', 'tracked'). */
export type PrKey = PrScope | `${PrScope}|${Exclude<PrState, 'open'>}`
export const prsKey = (scope: PrScope, state: PrState = 'open'): PrKey => (state === 'open' ? scope : `${scope}|${state}`)
export interface PrItem {
  workspaceId: string | null; repo: string; project?: string | null; index: number; title: string
  state: 'open' | 'merged' | 'declined'; url: string; head: string; base: string; author?: string | null
  reviewers: { name: string; status: string }[]; mergeable: boolean | null; updatedAt: number; createdAt?: number
  taskId?: string | null; taskKey?: string | null; sessionId?: string | null; byAgent?: boolean
}
// meSource: where my login came from — 'os' is a guess by the OS account name (Settings → PR → «Ваш логин» fixes it)
export interface PrList { me?: string | null; meSource?: 'config' | 'tool' | 'os' | null; items: PrItem[]; errors: { repo: string | null; error: string }[]; at: number }
/** null = loading; 'off' = no PR server on this machine; { error } = could not ask. */
export type PrListState = PrList | null | 'off' | { error: string }

const inflight = new Set<string>()

export function loadPrsMine(scope: PrScope, refresh = false, state: PrState = 'open') {
  const key = prsKey(scope, state)
  if (!hasFeature('prs-mine') || inflight.has(key)) return
  if (!refresh && getState().prsMine[key] !== undefined) return
  inflight.add(key)
  if (refresh && !getState().prsMine[key]) setState((s) => ({ prsMine: { ...s.prsMine, [key]: null } }))
  api<PrList>('GET', `/prs${qs({ scope, state: state === 'open' ? undefined : state, refresh: refresh ? 1 : undefined })}`)
    .then((r): PrListState => ({ me: r?.me ?? null, items: Array.isArray(r?.items) ? r.items : [], errors: Array.isArray(r?.errors) ? r.errors : [], at: r?.at ?? Date.now() }))
    .catch((e): PrListState => (e instanceof ApiError && (e.status === 501 || e.status === 404) ? 'off' : { error: errorText(e) }))
    .then((v) => setState((s) => ({ prsMine: { ...s.prsMine, [key]: v } })))
    .finally(() => inflight.delete(key))
}

/** After a merge / close: every list already shown is read again. */
export function reloadPrsMine() {
  for (const key of Object.keys(getState().prsMine) as PrKey[]) {
    const [scope, state] = key.split('|') as [PrScope, PrState | undefined]
    loadPrsMine(scope, true, state ?? 'open')
  }
}

