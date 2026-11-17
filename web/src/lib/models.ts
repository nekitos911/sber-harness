// The model picker's list (pure: also run by node --test, so no runtime imports).
import type { ModelEntry } from '../types'

const norm = (list: (ModelEntry | string)[] | null | undefined): ModelEntry[] =>
  (Array.isArray(list) ? list : []).map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m && typeof m.id === 'string' && m.id)

/**
 * Every model of the agent's catalogue (/api/state agents[].models, availability included), with the labels the user
 * set in settings; entries only the settings know are kept too. Nothing is filtered: unavailable ones (available ===
 * false) go to the end, unchecked ones (null/undefined) stay in place.
 */
export function pickerModels(catalogue: (ModelEntry | string)[] | null | undefined, configured?: (ModelEntry | string)[] | null): ModelEntry[] {
  const fromState = norm(catalogue)
  const fromSettings = norm(configured)
  const label = new Map(fromSettings.filter((m) => m.label).map((m) => [m.id, m.label]))
  const out = fromState.map((m) => (label.has(m.id) ? { ...m, label: label.get(m.id) } : m))
  for (const m of fromSettings) if (!out.some((x) => x.id === m.id)) out.push(m)
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => Number(a.m.available === false) - Number(b.m.available === false) || a.i - b.i)
    .map((x) => x.m)
}
