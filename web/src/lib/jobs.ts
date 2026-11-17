import { ApiError, errorText } from '../api'
import { getState, setState, useStore } from '../store'

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `job-${Date.now()}-${Math.random().toString(36).slice(2)}`)

/** Register a job (its id goes to the server as x-job-id; WS `job` events fill in the step). */
export function startJob(label: string, inline = false): string {
  const id = newId()
  setState((s) => ({ jobs: [...s.jobs, { id, label, step: null, started: Date.now(), error: null, inline }] }))
  return id
}

export const endJob = (id: string) => setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }))

/**
 * A long operation with visible progress: a toast «Создаю рабочее дерево… 3 с» with the server's steps, gone when done;
 * on failure it stays with the error and «Повторить». Resolves to undefined on failure.
 */
export async function runJob<T>(label: string, fn: (jobId: string) => Promise<T>): Promise<T | undefined> {
  const id = startJob(label)
  try {
    const res = await fn(id)
    endJob(id)
    return res
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { endJob(id); return undefined } // the auth card explains it
    setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, error: errorText(e), retry: () => { endJob(id); void runJob(label, fn) } } : j)) }))
    return undefined
  }
}

/** WS `{ t: 'job', id, text?, step?, total?, done?, error? }` from the server. */
export function applyJobEvent(ev: { id: string; text?: string; step?: number; total?: number; done?: boolean; error?: string }) {
  if (!getState().jobs.some((j) => j.id === ev.id)) return
  if (ev.done && !ev.error) return // the request itself ends the job
  const step = ev.text ?? (ev.step && ev.total ? `шаг ${ev.step}/${ev.total}` : null)
  setState((s) => ({ jobs: s.jobs.map((j) => (j.id === ev.id ? { ...j, step: step ?? j.step, error: ev.error ?? j.error } : j)) }))
}

/** The server's current step of a job shown inline (a dialog's submit button). */
export const useJobStep = (id: string | null) => useStore((s) => (id ? s.jobs.find((j) => j.id === id)?.step ?? null : null))
