import { useCallback, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { api, errorText } from '../api'
import { useFeature } from '../store'
import { endJob, startJob } from '../lib/jobs'
import { useElapsed } from '../lib/live'

export interface Generated { title: string; body: string }

/**
 * POST /git/generate (feature git-generate): GigaCode writes the commit / PR message from the diff and the task.
 * `cancel` only drops the answer (the run finishes on the server); an older result never lands after a newer request.
 */
export function useGenerate(cwd: string, kind: 'commit' | 'pr', base?: string | null) {
  const on = useFeature('git-generate')
  const [st, setSt] = useState<{ running: boolean; started: number; error: string | null }>({ running: false, started: 0, error: null })
  const token = useRef(0)
  const run = useCallback(async (): Promise<Generated | null> => {
    const my = ++token.current
    setSt({ running: true, started: Date.now(), error: null })
    const jobId = startJob('Сообщение', true)
    try {
      const r = await api<Generated>('POST', '/git/generate', { cwd, kind, base: base || undefined }, { jobId })
      if (my !== token.current) return null
      setSt({ running: false, started: 0, error: null })
      return { title: r?.title ?? '', body: r?.body ?? '' }
    } catch (e) {
      if (my === token.current) setSt({ running: false, started: 0, error: errorText(e) })
      return null
    } finally {
      endJob(jobId)
    }
  }, [cwd, kind, base])
  const cancel = useCallback(() => { token.current++; setSt({ running: false, started: 0, error: null }) }, [])
  return { on, ...st, run, cancel }
}

export type Generator = ReturnType<typeof useGenerate>

/** «✨ Сгенерировать»: the agent writes the message again. */
export function GenerateButton({ g, onClick }: { g: Generator; onClick: () => void }) {
  if (!g.on) return null
  return (
    <button type="button" className="icon-btn icon-btn-sm gen-btn" aria-label="Сгенерировать сообщение" data-tip="Сгенерировать: GigaCode напишет по изменениям и задаче"
      disabled={g.running} onClick={onClick}>
      <Sparkles />
    </button>
  )
}

/** «GigaCode пишет сообщение… 4 с · Отмена», or why it did not work with «Повторить». */
export function GenerateStatus({ g, onRetry }: { g: Generator; onRetry: () => void }) {
  const sec = useElapsed(g.started, g.running)
  if (g.running) {
    return <p className="gen-status" role="status">GigaCode пишет сообщение… <span className="num">{sec} с</span> <button type="button" className="link" onClick={g.cancel}>Отмена</button></p>
  }
  if (g.error) {
    return <p className="gen-status gen-error">Не удалось: {g.error} — заполните вручную или <button type="button" className="link" onClick={onRetry}>повторите</button></p>
  }
  return null
}
