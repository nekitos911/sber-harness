import { useCallback, useEffect, useState } from 'react'
import { Files, GitCompareArrows, RefreshCw, X } from 'lucide-react'
import { api, errorText, qs } from '../api'
import { setState, useActiveCwd, useStore } from '../store'
import { basename, normPath } from '../lib/format'
import type { GitStatus } from '../types'
import { Branch } from './bits'
import { FilesTab } from './panel/FilesTab'
import { ChangesTab } from './panel/ChangesTab'

export interface GitState { status: GitStatus | null; error: string | null; refresh: () => void }

function useGitStatus(cwd: string | null): GitState {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  // Re-read git status whenever an agent working in this folder changes state (e.g. finishes a turn).
  const sig = useStore((s) => (cwd ? s.sessions.filter((x) => normPath(x.cwd) === normPath(cwd)).map((x) => x.id + x.status).join() : ''))

  useEffect(() => {
    if (!cwd) return
    let live = true
    api<GitStatus>('GET', `/git/status${qs({ cwd })}`).then(
      (st) => { if (live) { setStatus(st); setError(null) } },
      (e) => { if (live) { setStatus(null); setError(errorText(e)) } },
    )
    return () => { live = false }
  }, [cwd, sig, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { status, error, refresh }
}

export function WorkspacePanel() {
  const cwd = useActiveCwd()
  const tab = useStore((s) => s.panelTab)
  const project = useStore((s) => (cwd ? s.workspaces.find((w) => normPath(cwd).startsWith(normPath(w.path))) : undefined))
  const git = useGitStatus(cwd)
  const changed = git.status?.files.length ?? 0

  return (
    <aside className="wpanel" aria-label="Файлы и изменения">
      <div className="wpanel-head" role="tablist" aria-label="Раздел панели">
        <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'files'} title="Файлы" onClick={() => setState({ panelTab: 'files' })}>
          <Files />
          <span className="sr-only">Файлы</span>
        </button>
        <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'changes'} title="Изменения" onClick={() => setState({ panelTab: 'changes' })}>
          <GitCompareArrows />
          <span className="sr-only">Изменения</span>
          {changed > 0 && <span className="count">{changed}</span>}
        </button>
        <span className="grow" />
        <button type="button" className="icon-btn" title="Обновить" aria-label="Обновить" onClick={git.refresh} disabled={!cwd}>
          <RefreshCw />
        </button>
        <button type="button" className="icon-btn" title="Скрыть панель" aria-label="Скрыть панель" onClick={() => setState({ panel: false })}>
          <X />
        </button>
      </div>
      {!cwd ? (
        <div className="empty"><p>Откройте сессию или добавьте проект — здесь появятся его файлы и изменения.</p></div>
      ) : (
        <>
          <div className="wpanel-where" title={cwd}>
            <strong className="ellipsis">{!project ? basename(cwd) : normPath(project.path) === normPath(cwd) ? project.name : `${project.name} / ${basename(cwd)}`}</strong>
            <Branch name={git.status?.branch} />
          </div>
          <div className="wpanel-body">
            {tab === 'files'
              ? <FilesTab key={cwd} cwd={cwd} status={git.status} />
              : <ChangesTab key={cwd} cwd={cwd} git={git} />}
          </div>
        </>
      )}
    </aside>
  )
}
