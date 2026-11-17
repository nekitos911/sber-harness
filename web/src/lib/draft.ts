/**
 * Unsaved input that must survive a reload (commit message, PR dialog, task edits, chat scroll).
 * One localStorage entry per key; storage may be blocked, then drafts live until the page closes.
 */
const PREFIX = 'harness.draft.'

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** null removes the draft. */
export function saveDraft(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key)
    else localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch { /* storage blocked: the draft lives until the page closes */ }
}
