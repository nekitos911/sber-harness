// Where a worktree is on the way to a merged PR (the changes panel's strip): Коммит → Push → PR → Влит, and what is next.

export type FlowNext = 'commit' | 'push' | 'pushed' | 'create-pr' | 'pr-off' | 'review' | 'merged' | 'declined'
export interface FlowInput {
  changed: number
  ahead: number
  upstream: boolean
  onBase: boolean // the branch PRs go into (develop): no PR steps
  pr: { state: 'open' | 'merged' | 'declined' } | null
  prEnabled: boolean
}

/** null: the base branch at rest — nothing to walk through. */
export function flowState(f: FlowInput): { steps: { label: string; state: 'done' | 'now' | 'later' }[]; next: FlowNext } | null {
  if (f.onBase && !f.changed && !f.ahead) return null
  const pushed = f.upstream && !f.ahead && !f.changed
  const all = [
    { label: 'Коммит', done: !f.changed },
    { label: 'Push', done: pushed },
    // an open PR is «На ревью» until the merge is confirmed: a lit «Влит» read as merged
    ...(f.onBase ? [] : [{ label: 'PR', done: !!f.pr }, { label: f.pr?.state === 'open' ? 'На ревью' : 'Влит', done: f.pr?.state === 'merged' }]),
  ]
  const current = all.findIndex((s) => !s.done) // the first step not done yet
  const steps = all.map((s, i) => ({ label: s.label, state: (s.done ? 'done' : i === current ? 'now' : 'later') as 'done' | 'now' | 'later' }))
  const next: FlowNext = f.changed ? 'commit' : !pushed ? 'push' : f.onBase ? 'pushed' : !f.pr ? (f.prEnabled ? 'create-pr' : 'pr-off')
    : f.pr.state === 'open' ? 'review' : f.pr.state === 'merged' ? 'merged' : 'declined'
  return { steps, next }
}
