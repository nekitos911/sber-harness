import { useEffect, useState } from 'react'
import { ownerWorkspace } from '../lib/actions'
import { HistoryList } from './HistoryList'
import { Files, FolderOpen, GitCompareArrows, History, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { failCount, useSdd } from '../lib/sdd'
import { VerdictsTab } from './panel/VerdictsTab'
import { ErrorBoundary } from './ErrorBoundary'
import { openFolder } from './WorktreeMenu'
import { setState, useActiveCwd, useFeature, useStore, wtKey } from '../store'
import { basename, normPath } from '../lib/format'
import { refreshGit, useGit } from '../lib/git'
import { Branch } from './bits'
import { BranchPicker } from './pickers/BranchPicker'
import { FilesTab } from './panel/FilesTab'
import { ChangesTab } from './panel/ChangesTab'

export function WorkspacePanel() {
  const cwd = useActiveCwd()
  const tab = useStore((s) => s.panelTab)
  const workspaces = useStore((s) => s.workspaces)
  const wtOwner = useStore((s) => (cwd ? Object.entries(s.worktrees).find(([, list]) => list.some((w) => normPath(w.path) === normPath(cwd)))?.[0] : undefined))
  const project = cwd ? workspaces.find((w) => w.id === wtOwner) ?? ownerWorkspace(workspaces, cwd) : undefined
  const git = useGit(cwd)
  const changed = git?.status?.files.filter((f) => !f.service).length ?? 0
  // «Вердикты» of the chat on screen (its task, the files it changed); «Показать все планы папки» drops the filter
  const activeSession = useStore((s) => { const a = cwd ? s.wt[wtKey(cwd)]?.active : null; return a?.startsWith('s:') ? a.slice(2) : null })
  const [allPlans, setAllPlans] = useState(false)
  const plans = useSdd(cwd, allPlans ? null : activeSession)
  const openOn = useFeature('open')
  const historyOn = useFeature('cli-history')
  const fails = failCount(plans)
  const hasChanges = changed > 0

  // A worktree with uncommitted changes opens on «Изменения»: that is what the user came to check.
  useEffect(() => {
    if (hasChanges) setState({ panelTab: 'changes' })
  }, [cwd, hasChanges])

  if (!cwd) return null
  const name = project && normPath(project.path) !== normPath(cwd) ? `${project.name} / ${basename(cwd)}` : project?.name ?? basename(cwd)

  return (
    <aside className="wpanel" aria-label="Файлы и изменения">
      <div className="wpanel-head" role="tablist" aria-label="Раздел панели">
        <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'files'} onClick={() => setState({ panelTab: 'files' })} data-tip="Файлы" data-tip-trunc>
          <Files aria-hidden />
          <span className="wtab-text ellipsis">Файлы</span>
        </button>
        <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'changes'} onClick={() => setState({ panelTab: 'changes' })} data-tip="Изменения" data-tip-trunc>
          <GitCompareArrows aria-hidden />
          <span className="wtab-text ellipsis">Изменения</span>
          {changed > 0 && <span className="count count-run" aria-label={`изменённых файлов: ${changed}`}>{changed}</span>}
        </button>
        {(!!plans?.length || allPlans) && (
          <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'verdicts'} onClick={() => setState({ panelTab: 'verdicts' })} data-tip="Вердикты" data-tip-trunc>
            <ShieldCheck aria-hidden />
            <span className="wtab-text ellipsis">Вердикты</span>
            {fails > 0 && <span className="count count-fail" aria-label={`провалено шагов: ${fails}`}>{fails}</span>}
          </button>
        )}
        {historyOn && (
          <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'history'} onClick={() => setState({ panelTab: 'history' })} data-tip="История GigaCode: сессии, начатые в CLI">
            <History aria-hidden />
            <span className="wtab-text ellipsis">История</span>
          </button>
        )}
        <span className="grow" />
        {openOn && (
          <button type="button" className="icon-btn" data-tip="Открыть папку" aria-label="Открыть папку в файловом менеджере" onClick={() => openFolder(cwd)}>
            <FolderOpen />
          </button>
        )}
        <button type="button" className="icon-btn" data-tip="Обновить" aria-label="Обновить git-статус" onClick={() => refreshGit(cwd)}>
          <RefreshCw />
        </button>
        <button type="button" className="icon-btn" data-tip="Скрыть панель" aria-label="Скрыть панель" onClick={() => setState({ panel: false, panelOverlay: false })}>
          <X />
        </button>
      </div>
      <div className="wpanel-where" data-tip={cwd}>
        <strong className="ellipsis">{name}</strong>
        {git?.status?.branch && <BranchPicker cwd={cwd} branch={git.status.branch} placement="bottom-start"><Branch name={git.status.branch} /></BranchPicker>}
      </div>
      <div className="wpanel-body" key={`${cwd}|${tab}`}>
        <ErrorBoundary key={tab} area={tab === 'files' ? 'файлы' : tab === 'verdicts' ? 'вердикты' : tab === 'history' ? 'историю' : 'изменения'}>
          {tab === 'history' && historyOn ? <div className="wpanel-section"><HistoryList cwd={cwd} /></div>
            : tab === 'files' ? <FilesTab key={cwd} cwd={cwd} status={git?.status ?? null} />
            : tab === 'verdicts' && (plans?.length || allPlans) ? <VerdictsTab cwd={cwd} plans={plans ?? []} scope={activeSession ? { all: allPlans, set: setAllPlans } : undefined} />
              : <ChangesTab key={cwd} cwd={cwd} />}
        </ErrorBoundary>
      </div>
    </aside>
  )
}
