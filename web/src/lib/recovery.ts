import { api } from '../api'
import { getState, hasFeature, openDialog, setState } from '../store'
import { loadDraft, saveDraft } from './draft'
import type { RecoveryState } from '../types'

/**
 * After a (re)connect: sessions whose turn a restart cut off (GET /recovery). The dialog opens by itself once per
 * batch of interruptions; «Не сейчас» leaves an Inbox item that opens it again.
 */
export async function loadRecovery(open = true) {
  if (!hasFeature('recovery')) return
  try {
    const r = await api<RecoveryState>('GET', '/recovery')
    const list = Array.isArray(r?.sessions) ? r.sessions : []
    setState({ recovery: list.length ? { sessions: list, message: r.message ?? '' } : null })
    if (!open || !list.length || getState().dialog) return
    const batch = String(Math.max(...list.map((s) => s.at)))
    if (loadDraft<string>('recovery:shown') === batch) return
    saveDraft('recovery:shown', batch)
    openDialog({ kind: 'recovery' })
  } catch { /* the Inbox item stays as it was */ }
}

