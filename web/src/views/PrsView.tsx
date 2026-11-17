import { useEffect, useMemo, useState } from 'react'
import { Ellipsis, ExternalLink, GitPullRequest, GitPullRequestClosed, RefreshCw } from 'lucide-react'
import { tryApi } from '../api'
import { openTask, toast, useFeature, useStore, wtKey } from '../store'
import { loadPr, openPrSettings, PR_STATE, reviewText } from '../lib/pr'
import { relTime } from '../lib/format'
import { useNow } from '../lib/useNow'
import { loadWorktrees } from '../ws'
import type { PrInfo, Task, TaskPr } from '../types'
import { PrGlyph } from '../components/PrChip'
import { Button, Dialog, MenuButton } from '../components/ui'

interface Row { key: string; pr: PrInfo | TaskPr; repo: string; head: string | null; task: Task | null; cwd: string | null }

const GROUPS: { state: Row['pr']['state']; label: string }[] = [
  { state: 'open', label: 'Открытые' }, { state: 'merged', label: 'Влитые' }, { state: 'declined', label: 'Отклонённые' },
]

/** Every PR the harness knows: of tasks (task.pr) and of the branch checked out in each worktree. */
export function PrsView() {
  const tasks = useStore((s) => s.tasks)
  const workspaces = useStore((s) => s.workspaces)
  const worktrees = useStore((s) => s.worktrees)
  const prs = useStore((s) => s.prs)
  const enabled = useStore((s) => s.integrations.pr && s.features.includes('pr-status'))
  const now = useNow()

  useEffect(() => { for (const w of workspaces) if (w.isGit && !worktrees[w.id]) void loadWorktrees(w.id) }, [workspaces, worktrees])
  const paths = useMemo(() => Object.values(worktrees).flat(), [worktrees])
  useEffect(() => { if (enabled) for (const w of paths) loadPr(w.path) }, [paths, enabled])

  const rows = useMemo(() => {
    const out = new Map<string, Row>()
    for (const [wsId, list] of Object.entries(worktrees)) {
      const repo = workspaces.find((w) => w.id === wsId)?.name ?? ''
      for (const w of list) {
        const pr = prs[wtKey(w.path)]
        if (!pr || typeof pr !== 'object' || 'error' in pr) continue
        const task = tasks.find((t) => t.branch && t.branch === w.branch) ?? null
        out.set(pr.url, { key: pr.url, pr, repo, head: w.branch, task, cwd: w.path })
      }
    }
    for (const t of tasks) {
      if (!t.pr || out.has(t.pr.url)) continue
      const ws = workspaces.find((w) => w.id === t.workspaceId)
      out.set(t.pr.url, { key: t.pr.url, pr: t.pr, repo: ws?.name ?? '', head: t.branch, task: t, cwd: ws?.path ?? null })
    }
    return [...out.values()].sort((a, b) => b.pr.updatedAt - a.pr.updatedAt)
  }, [worktrees, workspaces, prs, tasks])

  const refresh = () => { for (const w of paths) loadPr(w.path, true) }
  const declineOn = useFeature('pr-decline')
  const [declining, setDeclining] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const decline = async (r: Row) => {
    setBusy(true)
    const res = await tryApi('POST', '/git/pr/decline', { cwd: r.cwd, index: r.pr.index })
    setBusy(false)
    if (res === undefined) return
    toast(`PR #${r.pr.index} отклонён`, 'ok')
    setDeclining(null)
    if (r.cwd) loadPr(r.cwd, true)
  }

  return (
    <div className="prs-view">
      <header className="view-head">
        <h1>Пулл-реквесты</h1>
        <span className="count">{rows.length}</span>
        <span className="grow" />
        {enabled && <Button icon={<RefreshCw />} onClick={refresh}>Обновить</Button>}
      </header>
      {!enabled ? (
        <div className="empty">
          <GitPullRequest className="empty-icon" aria-hidden />
          <h2>PR-интеграция не настроена</h2>
          <p>Когда она включена, здесь видны PR веток задач и рабочих деревьев: статус, ревьюеры, конфликты.</p>
          <Button variant="primary" onClick={openPrSettings}>Настроить</Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <GitPullRequest className="empty-icon" aria-hidden />
          <h2>PR пока нет</h2>
          <p>PR появляется здесь, когда вы создаёте его из панели «Изменения» рабочего дерева или из карточки задачи, либо когда он уже открыт для ветки задачи.</p>
        </div>
      ) : (
        <div className="prs-list">
          {GROUPS.map((g) => {
            const list = rows.filter((r) => r.pr.state === g.state)
            if (!list.length) return null
            return (
              <section key={g.state}>
                <h2 className="prs-group">{g.label} <span className="count">{list.length}</span></h2>
                {list.map((r) => {
                  const full = 'title' in r.pr ? r.pr : null
                  return (
                    <div key={r.key} className="pr-row">
                      <PrGlyph pr={r.pr} />
                      <span className="pr-row-main">
                        <span className="pr-row-title">
                          <span className="num muted">#{r.pr.index}</span> {full?.title ?? r.task?.title ?? 'Pull request'}
                        </span>
                        <span className="pr-row-meta">
                          {r.repo && <span>{r.repo}</span>}
                          {r.head && <span className="mono">{r.head} → {full?.base ?? r.task?.targets[0] ?? '?'}</span>}
                          {full && reviewText(full) && <span>{reviewText(full)}</span>}
                          {full?.mergeable === false && r.pr.state === 'open' && <span className="pr-warn">конфликт</span>}
                          <span>{PR_STATE[r.pr.state]} {relTime(r.pr.updatedAt, now)} назад</span>
                        </span>
                      </span>
                      {r.task && <button type="button" className="chip chip-mono" onClick={() => openTask(r.task!.id)} data-tip={r.task.title}>{r.task.externalId ?? r.task.id}</button>}
                      <a className="btn btn-sm" href={r.pr.url} target="_blank" rel="noreferrer noopener"><ExternalLink />Открыть</a>
                      {declineOn && r.pr.state === 'open' && r.cwd && (
                        <MenuButton label={`Действия с PR #${r.pr.index}`} icon={<Ellipsis />} align="right" className="icon-btn-sm"
                          items={[{ label: 'Отклонить PR…', icon: <GitPullRequestClosed />, danger: true, onSelect: () => setDeclining(r) }]} />
                      )}
                    </div>
                  )
                })}
              </section>
            )
          })}
        </div>
      )}
      {declining && (
        <Dialog title={`Отклонить PR #${declining.pr.index}?`} submitLabel="Отклонить PR" danger busy={busy} onClose={() => setDeclining(null)} onSubmit={() => void decline(declining)}>
          <p>PR #{declining.pr.index} будет отклонён в sourcecontrol. Ветка останется; новый PR можно будет создать заново.</p>
        </Dialog>
      )}
    </div>
  )
}

