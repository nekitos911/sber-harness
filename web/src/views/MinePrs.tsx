import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Bot, Check, ChevronRight, Clock, GitPullRequest, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { openSession, openTask, useStore } from '../store'
import { loadPrsMine, type PrItem, type PrScope } from '../lib/prsMine'
import { openPrSettings } from '../lib/pr'
import { ago, plural, reviewKind } from '../lib/format'
import { loadDraft, saveDraft } from '../lib/draft'
import { useNow } from '../lib/useNow'
import { Skeleton } from '../components/bits'
import { Button, Disclosure, Segmented } from '../components/ui'

const stop = (e: MouseEvent) => e.stopPropagation()

/**
 * «Пулл-реквесты»: every open PR of the person across repositories («Мои»), or the PRs behind tasks («По задачам»),
 * grouped by repository; a task key and an «агент» badge when the harness is behind it. A row opens the PR.
 */
export function MinePrs() {
  const [scope, setScopeState] = useState<PrScope>(() => loadDraft<PrScope>('prs:scope') ?? 'mine')
  const setScope = (v: PrScope) => { setScopeState(v); saveDraft('prs:scope', v === 'mine' ? null : v) }
  const data = useStore((s) => s.prsMine[scope])
  const now = useNow()
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => { loadPrsMine(scope) }, [scope])
  useEffect(() => { if (refreshing && data && typeof data === 'object' && !('error' in data)) setRefreshing(false) }, [data, refreshing])
  const refresh = () => { setRefreshing(true); loadPrsMine(scope, true) }

  const list = data && typeof data === 'object' && 'items' in data ? data : null
  const repos = useMemo(() => {
    const by = new Map<string, PrItem[]>()
    for (const it of list?.items ?? []) by.set(it.repo, [...(by.get(it.repo) ?? []), it])
    return [...by.entries()].map(([repo, items]) => ({ repo, items: items.sort((a, b) => b.updatedAt - a.updatedAt) })).sort((a, b) => a.repo.localeCompare(b.repo, 'ru'))
  }, [list])

  return (
    <div className="prs-view">
      <header className="view-head">
        <h1>Пулл-реквесты</h1>
        {list && <span className="count">{list.items.length}</span>}
        <Segmented size="sm" label="Какие PR" value={scope} onChange={setScope}
          options={[{ value: 'mine', label: 'Мои', hint: 'Все мои открытые PR во всех репозиториях' }, { value: 'tracked', label: 'По задачам', hint: 'PR веток задач harness' }]} />
        <span className="grow" />
        {list && <span className="muted num">обновлено {ago(list.at, now)}</span>}
        {data !== 'off' && <Button size="sm" variant="ghost" icon={<RefreshCw className={refreshing ? 'spinner' : undefined} />} disabled={refreshing} onClick={refresh}>Обновить</Button>}
      </header>
      {data === undefined || data === null ? (
        <div className="prs-list"><Skeleton rows={6} label="Загрузка PR…" /></div>
      ) : data === 'off' ? (
        <div className="empty">
          <GitPullRequest className="empty-icon" aria-hidden />
          <h2>PR-интеграция не настроена</h2>
          <p>Нужен MCP-сервер sourcecontrol: тогда здесь видны ваши открытые PR во всех репозиториях — статус, ревьюеры, конфликты.</p>
          <Button variant="primary" onClick={openPrSettings}>Настроить</Button>
        </div>
      ) : 'error' in data ? (
        <div className="empty">
          <TriangleAlert className="empty-icon" aria-hidden />
          <h2>Не удалось получить PR</h2>
          <p className="mono">{data.error}</p>
          <Button onClick={refresh}>Повторить</Button>
        </div>
      ) : (
        <div className="prs-list">
          {repos.length === 0 && (
            <div className="empty">
              <GitPullRequest className="empty-icon" aria-hidden />
              <h2>Открытых PR нет</h2>
              <p>{scope === 'mine' ? 'Ваши открытые PR во всех репозиториях появятся здесь.' : 'PR веток задач появятся здесь, когда их создадут.'}</p>
            </div>
          )}
          {repos.map(({ repo, items }) => <RepoGroup key={repo} repo={repo} items={items} now={now} />)}
          {list!.errors.length > 0 && (
            <Disclosure className="prs-errors" summary={<span className="muted">Не ответили {list!.errors.length} {plural(list!.errors.length, 'репозиторий', 'репозитория', 'репозиториев')}</span>}>
              <ul>{list!.errors.map((e) => <li key={e.repo}><strong>{e.repo}</strong> <span className="muted mono">{e.error}</span></li>)}</ul>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  )
}

function RepoGroup({ repo, items, now }: { repo: string; items: PrItem[]; now: number }) {
  const [open, setOpenState] = useState(() => loadDraft<boolean>(`prs:open:${repo}`) ?? true)
  const toggle = () => { setOpenState(!open); saveDraft(`prs:open:${repo}`, open ? false : null) }
  return (
    <section className="prs-repo">
      <button type="button" className="prs-group" aria-expanded={open} onClick={toggle}>
        <ChevronRight className="chev" aria-hidden />
        {repo} <span className="count">{items.length}</span>
      </button>
      {open && items.map((it) => <PrRow key={it.url} it={it} now={now} />)}
    </section>
  )
}

const REVIEW_ICON = { approved: Check, changes: X, pending: Clock }
const REVIEW_TIP = { approved: 'одобрил', changes: 'просит изменения', pending: 'ещё не ответил' }

function PrRow({ it, now }: { it: PrItem; now: number }) {
  const session = useStore((s) => (it.sessionId ? s.sessions.find((x) => x.id === it.sessionId) : undefined))
  const open = () => window.open(it.url, '_blank', 'noopener,noreferrer')
  return (
    <div className="pr-row pr-row-link" role="link" tabIndex={0} data-tip="Открыть PR в новой вкладке" onClick={open}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open() } }}>
      <span className="pr-row-main">
        <span className="pr-row-title"><span className="mono muted">#{it.index}</span> <strong>{it.title}</strong></span>
        <span className="pr-row-meta">
          <span className="mono">{it.head} → {it.base}</span>
          {it.mergeable === false && <span className="pr-warn"><TriangleAlert aria-hidden />конфликт</span>}
          <span>обновлён {ago(it.updatedAt, now)}</span>
        </span>
      </span>
      {it.reviewers.length > 0 && (
        <span className="pr-reviewers">
          {it.reviewers.map((r) => {
            const k = reviewKind(r.status)
            const Icon = REVIEW_ICON[k]
            return <span key={r.name} className="chip pr-reviewer" data-k={k} data-tip={`${r.name}: ${REVIEW_TIP[k]} (${r.status})`}><Icon aria-hidden />{r.name}</span>
          })}
        </span>
      )}
      {it.taskId && (
        <button type="button" className="chip chip-mono" onClick={(e) => { stop(e); openTask(it.taskId!) }} data-tip="Открыть задачу">{it.taskKey ?? it.taskId}</button>
      )}
      {it.sessionId && (
        <button type="button" className="chip pr-agent" onClick={(e) => { stop(e); openSession(it.sessionId!) }} data-tip={session ? `${session.title}: открыть чат` : 'Открыть чат агента'}>
          <Bot aria-hidden />агент
        </button>
      )}
    </div>
  )
}
