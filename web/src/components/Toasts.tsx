import { CircleAlert, CircleCheck, Info, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { dismissToast, useStore, type Job } from '../store'
import { endJob } from '../lib/jobs'
import { useElapsed } from '../lib/live'

const ICON = { info: Info, ok: CircleCheck, error: CircleAlert }

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const jobs = useStore((s) => s.jobs)
  return (
    <div className="toasts" aria-live="polite">
      {jobs.filter((j) => !j.inline).map((j) => <JobToast key={j.id} job={j} />)}
      {toasts.map((t) => {
        const Icon = ICON[t.tone]
        return (
          <div key={t.id} className="toast" data-tone={t.tone} data-leaving={t.leaving || undefined} role={t.tone === 'error' ? 'alert' : 'status'}>
            <Icon className="toast-icon" aria-hidden />
            <p>
              {t.text}
              {t.href && <> <a href={t.href} target="_blank" rel="noreferrer noopener">Открыть</a></>}
            </p>
            <button type="button" className="icon-btn icon-btn-sm" onClick={() => dismissToast(t.id)} aria-label="Закрыть уведомление">
              <X />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** «Синхронизация с трекером · страница 2/4 · 3 с»; on failure the error and «Повторить». */
function JobToast({ job }: { job: Job }) {
  const sec = useElapsed(job.started, !job.error)
  return (
    <div className="toast toast-job" data-tone={job.error ? 'error' : 'info'} role={job.error ? 'alert' : 'status'}>
      {job.error ? <CircleAlert className="toast-icon" aria-hidden /> : <LoaderCircle className="toast-icon spinner" aria-hidden />}
      <p>
        {job.label}
        {job.error ? <>: {job.error}</> : <span className="muted">{job.step && ` · ${job.step}`}{sec >= 1 && ` · ${sec} с`}</span>}
      </p>
      {job.error && job.retry && <button type="button" className="btn btn-sm" onClick={job.retry}><RotateCcw />Повторить</button>}
      {job.error && <button type="button" className="icon-btn icon-btn-sm" onClick={() => endJob(job.id)} aria-label="Закрыть уведомление"><X /></button>}
    </div>
  )
}
