import { X } from 'lucide-react'
import { openSession, useStore, wtKey } from '../store'
import { useElapsed } from '../lib/live'
import { clear } from '../lib/agentGit'
import { Button } from './ui'

const DOING = { commit: 'Агент коммитит…', push: 'Агент отправляет ветку…', pr: 'Агент создаёт PR…' }

/** Under the commit / push buttons: the commit, push or PR the agent is doing, then what came of it. */
export function AgentGitLine({ cwd }: { cwd: string }) {
  const job = useStore((s) => s.agentGit[wtKey(cwd)])
  const sec = useElapsed(job?.started ?? 0, job?.status === 'running')
  if (!job) return null
  const chat = job.sessionId && <button type="button" className="link" onClick={() => openSession(job.sessionId!)}>открыть чат</button>
  if (job.status === 'running') return <p className="agent-git" role="status">{DOING[job.kind]} <span className="num">{sec} с</span> · {chat}</p>
  if (job.status === 'ok') {
    return (
      <p className="agent-git" data-ok role="status">
        {job.url ? <a href={job.url} target="_blank" rel="noreferrer noopener">{job.text}</a> : job.text}
        {chat && <> · {chat}</>}
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Скрыть" onClick={() => clear(cwd)}><X /></button>
      </p>
    )
  }
  return (
    <div className="agent-git" data-error role="alert">
      <span>Не вышло через агента: {job.error}</span>
      <span className="row">
        {job.sessionId && <Button size="sm" onClick={() => openSession(job.sessionId!)}>Открыть чат</Button>}
        {job.direct && <Button size="sm" onClick={() => { clear(cwd); job.direct!() }}>Сделать напрямую</Button>}
      </span>
    </div>
  )
}
