import { ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, TriangleAlert } from 'lucide-react'
import { PR_STATE, reviewText } from '../lib/pr'
import type { PrInfo, TaskPr } from '../types'

const ICON = { open: GitPullRequest, merged: GitMerge, declined: GitPullRequestClosed }

/** PR state glyph in its colour (open blue, merged violet, declined grey). */
export function PrGlyph({ pr }: { pr: TaskPr | PrInfo }) {
  const Icon = ICON[pr.state]
  const tip = `PR #${pr.index} · ${PR_STATE[pr.state]}${'reviewers' in pr && reviewText(pr) ? ` · ${reviewText(pr)}` : ''}`
  return <Icon className="pr-glyph" data-state={pr.state} role="img" aria-label={tip} data-tip={tip} />
}

/** Compact «#562 · открыт · на ревью 1/2 · ⚠ конфликт» chip linking to the PR in a new tab. */
export function PrChip({ pr }: { pr: TaskPr | PrInfo }) {
  const review = 'reviewers' in pr ? reviewText(pr) : ''
  const conflict = 'mergeable' in pr && pr.mergeable === false && pr.state === 'open'
  return (
    <a className="pr-chip" data-state={pr.state} href={pr.url} target="_blank" rel="noreferrer noopener" data-tip="Открыть PR в новой вкладке">
      <PrGlyph pr={pr} />
      <span className="num">#{pr.index}</span>
      <span>{PR_STATE[pr.state]}</span>
      {review && <span className="muted">{review}</span>}
      {conflict && <span className="pr-warn"><TriangleAlert aria-hidden />конфликт</span>}
      <ExternalLink className="pr-open" aria-hidden />
    </a>
  )
}

/** The branch's PR in the changes panel: state line, title, target, «Открыть». */
export function PrCard({ pr }: { pr: PrInfo }) {
  const review = reviewText(pr)
  const conflict = pr.mergeable === false && pr.state === 'open'
  return (
    <div className="pr-card" data-state={pr.state}>
      <div className="pr-card-head">
        <PrGlyph pr={pr} />
        <span className="ellipsis">#{pr.index} · {PR_STATE[pr.state]}{review ? ` · ${review.replace('на ревью', 'ревью')}` : ''}</span>
        {conflict && <TriangleAlert className="pr-warn-ico" aria-label="конфликт" data-tip="Есть конфликт с базовой веткой" />}
        <a className="icon-btn icon-btn-sm pr-card-open" href={pr.url} target="_blank" rel="noreferrer noopener" aria-label="Открыть PR" data-tip="Открыть PR в новой вкладке"><ExternalLink /></a>
      </div>
      <p className="pr-card-title ellipsis" data-tip={`${pr.title}\nв ${pr.base}`}>{pr.title}</p>
    </div>
  )
}
