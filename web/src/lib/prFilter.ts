/** «Пулл-реквесты»: search and the «Фильтры» popover over the fields /api/prs gives (repo, author, reviewers, base). */
export interface PrLike { repo: string; index: number; title: string; head: string; base: string; author?: string | null; reviewers: { name: string; status: string }[]; taskKey?: string | null }
export interface PrFilters { repo: string; author: string; reviewer: string; base: string }
export const NO_PR_FILTERS: PrFilters = { repo: '', author: '', reviewer: '', base: '' }

/** Every word of the query is somewhere in the PR (title, #number, branches, author, repository, task key); filters match exactly. */
export function filterPrs<T extends PrLike>(items: T[], query: string, f: PrFilters): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((it) => {
    if (f.repo && it.repo !== f.repo) return false
    if (f.author && it.author !== f.author) return false
    if (f.base && it.base !== f.base) return false
    if (f.reviewer && !it.reviewers.some((r) => r.name === f.reviewer)) return false
    if (!words.length) return true
    const hay = [it.title, `#${it.index}`, it.head, it.base, it.author ?? '', it.repo, it.taskKey ?? ''].join(' ').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** The values each filter can take in this list, sorted. */
export function prFilterOptions(items: PrLike[]): Record<keyof PrFilters, string[]> {
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, 'ru'))
  return {
    repo: uniq(items.map((i) => i.repo)),
    author: uniq(items.map((i) => i.author)),
    reviewer: uniq(items.flatMap((i) => i.reviewers.map((r) => r.name))),
    base: uniq(items.map((i) => i.base)),
  }
}

export const activePrFilters = (f: PrFilters) => Object.values(f).filter(Boolean).length
