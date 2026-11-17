import { useEffect } from 'react'
import { Files, FolderOpen, GitCompareArrows, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { failCount, useSdd } from '../lib/sdd'
import { VerdictsTab } from './panel/VerdictsTab'
import { ErrorBoundary } from './ErrorBoundary'
import { openFolder } from './WorktreeMenu'
import { setState, useActiveCwd, useFeature, useStore } from '../store'
import { basename, normPath } from '../lib/format'
import { refreshGit, useGit } from '../lib/git'
import { Branch } from './bits'
import { BranchPicker } from './pickers/BranchPicker'
import { FilesTab } from './panel/FilesTab'
import { ChangesTab } from './panel/ChangesTab'

export function WorkspacePanel() {
  const cwd = useActiveCwd()
  const tab = useStore((s) => s.panelTab)
  const project = useStore((s) => (cwd ? s.workspaces.find((w) => normPath(cwd) === normPath(w.path) || normPath(cwd).startsWith(`${normPath(w.path)}/`)) : undefined))
  const git = useGit(cwd)
  const changed = git?.status?.files.filter((f) => !f.service).length ?? 0
  const plans = useSdd(cwd)
  const openOn = useFeature('open')
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
        <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'files'} onClick={() => setState({ panelTab: 'files' })}>
          <Files aria-hidden />
          <span className="wtab-text">Файлы</span>
        </button>
        <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'changes'} onClick={() => setState({ panelTab: 'changes' })}>
          <GitCompareArrows aria-hidden />
          <span className="wtab-text">Изменения</span>
          {changed > 0 && <span className="count count-run" aria-label={`изменённых файлов: ${changed}`}>{changed}</span>}
        </button>
        {!!plans?.length && (
          <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'verdicts'} onClick={() => setState({ panelTab: 'verdicts' })}>
            <ShieldCheck aria-hidden />
            <span className="wtab-text">Вердикты</span>
            {fails > 0 && <span className="count count-fail" aria-label={`провалено шагов: ${fails}`}>{fails}</span>}
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
        <button type="button" className="icon-btn" data-tip="Скрыть панель" aria-label="Скрыть панель" onClick={() => setState({ panel: false })}>
          <X />
        </button>
      </div>
      <div className="wpanel-where" data-tip={cwd}>
        <strong className="ellipsis">{name}</strong>
        {git?.status?.branch && <BranchPicker cwd={cwd} branch={git.status.branch} placement="bottom-start"><Branch name={git.status.branch} /></BranchPicker>}
      </div>
      <div className="wpanel-body" key={`${cwd}|${tab}`}>
        <ErrorBoundary key={tab} area={tab === 'files' ? 'файлы' : tab === 'verdicts' ? 'вердикты' : 'изменения'}>
          {tab === 'files' ? <FilesTab key={cwd} cwd={cwd} status={git?.status ?? null} />
            : tab === 'verdicts' && plans?.length ? <VerdictsTab cwd={cwd} plans={plans} />
              : <ChangesTab key={cwd} cwd={cwd} />}
        </ErrorBoundary>
      </div>
    </aside>
  )
}
