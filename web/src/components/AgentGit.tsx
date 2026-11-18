import { X } from 'lucide-react'
import { api } from '../api'
import { openSession, setState, toast, useFeature, useStore, wtKey } from '../store'
import { useElapsed } from '../lib/live'
import { clear, type GitVia } from '../lib/agentGit'
import type { Settings } from '../types'
import { Button, Segmented } from './ui'

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

const VIA_TIP = 'Через агента — работают хуки и навыки GigaCode, медленнее; напрямую — git из harness'

/** «Через агента · Напрямую»: git.via, saved in the settings at once. */
export function ViaSwitch() {
  const on = useFeature('git-via-agent')
  const settings = useStore((s) => s.settings)
  if (!on || !settings) return null
  const via: GitVia = settings.git.via ?? 'agent'
  const set = async (v: GitVia) => {
    try {
      const saved = await api<Settings>('PUT', '/settings', { ...settings, git: { ...settings.git, via: v } })
      setState({ settings: saved ?? { ...settings, git: { ...settings.git, via: v } } })
    } catch (e) {
      toast(`Не удалось сохранить: ${(e as Error).message}`, 'error')
    }
  }
  return (
    <span className="via-switch" data-tip={VIA_TIP}>
      <Segmented size="sm" label="Как коммитить и отправлять" value={via} onChange={(v) => void set(v)}
        options={[{ value: 'agent', label: 'Через агента' }, { value: 'harness', label: 'Напрямую' }]} />
    </span>
  )
}
