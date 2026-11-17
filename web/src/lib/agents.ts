import { useEffect } from 'react'
import { api, ApiError } from '../api'
import { getState, hasFeature, setState, useFeature, useStore } from '../store'
import type { AgentMeta, Grade, ModelEntry, Settings } from '../types'

export const GRADES: Grade[] = ['default', 'fast', 'review', 'explore']

/** Catalog entries may arrive as plain strings from older configs. */
export const normModels = (list: (ModelEntry | string)[] | undefined): ModelEntry[] =>
  (list ?? []).map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m && m.id)

export const modelLabel = (id: string | null | undefined, catalog: ModelEntry[]) =>
  !id ? '' : catalog.find((m) => m.id === id)?.label ?? id

/** Short names for approval modes; the server's approvalModeLabels give the long explanation. */
export const MODE_SHORT: Record<string, string> = {
  plan: 'План', default: 'С подтверждением', 'auto-edit': 'Авто-правки', auto: 'Полный доступ',
  acceptEdits: 'Авто-правки', bypassPermissions: 'Полный доступ', yolo: 'Полный доступ',
}
export const FULL_ACCESS = new Set(['auto', 'yolo', 'bypassPermissions'])
export const modeShort = (m: string) => MODE_SHORT[m] ?? m

const inflight = new Set<string>()

/** CLI resolution + what the last session reported; null when the server does not have the endpoint. */
/** The server answers `seen: {}` before the agent's first session: treat that as none, and lists as lists. */
export function normMeta(m: AgentMeta): AgentMeta {
  const seen = m.seen && typeof m.seen.at === 'number'
    ? { ...m.seen, models: m.seen.models ?? [], slashCommands: m.seen.slashCommands ?? [], mcpServers: m.seen.mcpServers ?? [], agents: m.seen.agents ?? [] }
    : null
  return { ...m, seen }
}

export function loadAgentMeta(id: string, force = false) {
  if (!hasFeature('agent-info')) { if (!(id in getState().agentMeta)) setState((s) => ({ agentMeta: { ...s.agentMeta, [id]: null } })); return }
  if (inflight.has(id) || (!force && id in getState().agentMeta)) return
  inflight.add(id)
  api<AgentMeta>('GET', `/agents/${encodeURIComponent(id)}/info`)
    .then((m) => setState((s) => ({ agentMeta: { ...s.agentMeta, [id]: normMeta(m) } })))
    .catch(() => setState((s) => ({ agentMeta: { ...s.agentMeta, [id]: null } })))
    .finally(() => inflight.delete(id))
}

export function useAgentMeta(id: string | null | undefined) {
  const on = useFeature('agent-info')
  useEffect(() => { if (id) loadAgentMeta(id, on) }, [id, on])
  return useStore((s) => (id ? s.agentMeta[id] : undefined))
}

let settingsLoading: Promise<Settings | null> | null = null

/** Server settings (grades, presets, labels). Missing endpoint resolves to null. */
export function loadSettings(force = false): Promise<Settings | null> {
  if (!force && getState().settings) return Promise.resolve(getState().settings)
  if (settingsLoading && !force) return settingsLoading
  settingsLoading = api<Settings>('GET', '/settings')
    .then((st) => { setState({ settings: st }); return st })
    .catch((e) => { if (!(e instanceof ApiError)) throw e; return null })
    .finally(() => { settingsLoading = null })
  return settingsLoading
}

export function useSettings() {
  useEffect(() => { void loadSettings().catch(() => undefined) }, [])
  return useStore((s) => s.settings)
}
