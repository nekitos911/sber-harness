import { useEffect } from 'react'
import { Files, FolderOpen, GitCompareArrows, RefreshCw, X } from 'lucide-react'
import { openFolder } from './WorktreeMenu'
import { setState, useActiveCwd, useStore } from '../store'
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
  const changed = git?.status?.files.length ?? 0
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
          Файлы
        </button>
        <button type="button" role="tab" className="wpanel-tab" aria-selected={tab === 'changes'} onClick={() => setState({ panelTab: 'changes' })}>
          <GitCompareArrows aria-hidden />
          Изменения
          {changed > 0 && <span className="count count-run" aria-label={`изменённых файлов: ${changed}`}>{changed}</span>}
        </button>
        <span className="grow" />
        <button type="button" className="icon-btn" data-tip="Открыть папку" aria-label="Открыть папку в проводнике" onClick={() => openFolder(cwd)}>
          <FolderOpen />
        </button>
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
        {tab === 'files' ? <FilesTab key={cwd} cwd={cwd} status={git?.status ?? null} /> : <ChangesTab key={cwd} cwd={cwd} />}
      </div>
    </aside>
  )
}
