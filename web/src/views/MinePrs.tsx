import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Bot, Ellipsis, ExternalLink, FolderGit2, GitMerge, GitPullRequest, ListFilter, MessageSquare, PanelRight, RefreshCw, Search, TriangleAlert, XCircle } from 'lucide-react'
import { openPr, openTask, useFeature, useStore } from '../store'
import { PrPage, prAction, prStanding, REVIEW_ICON, REVIEW_TIP, usePrWork } from './PrPage'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { loadPrsMine, prsKey, type PrItem, type PrScope, type PrState } from '../lib/prsMine'
import { activePrFilters, filterPrs, NO_PR_FILTERS, prFilterOptions, type PrFilters } from '../lib/prFilter'
import { openPrSettings } from '../lib/pr'
import { ago, plural, reviewKind } from '../lib/format'
import { loadDraft, saveDraft } from '../lib/draft'
import { useNow } from '../lib/useNow'
import { loadWorktreesOf } from '../ws'
import { Skeleton } from '../components/bits'
import { PrGlyph } from '../components/PrChip'
import { Button, Disclosure, Menu, MenuButton, Segmented, type MenuItem } from '../components/ui'

const stop = (e: MouseEvent) => e.stopPropagation()

const STATES: { value: PrState; label: string }[] = [
  { value: 'open', label: 'Открытые' }, { value: 'merged', label: 'Влитые' }, { value: 'declined', label: 'Закрытые' }, { value: 'all', label: 'Все' },
]
const FILTERS: { key: keyof PrFilters; label: string }[] = [
  { key: 'repo', label: 'Репозиторий' }, { key: 'author', label: 'Автор' }, { key: 'reviewer', label: 'Запрошено ревью у' }, { key: 'base', label: 'Целевая ветка' },
]
const NONE: Record<PrState, string> = { open: 'Открытых PR нет', merged: 'Влитых PR нет', declined: 'Закрытых PR нет', all: 'PR нет' }

/**
 * «Пулл-реквесты» as a table: status (Открытые · Влитые · Закрытые · Все) and whose (Все · Мои · На ревью · По задачам),
 * a search and «Фильтры» over the fields the PR service gives. A row opens the PR; its button goes to the branch's chat or
 * worktree when the harness has one.
 */
export function MinePrs() {
  const filtersOn = useFeature('prs-filters') // older servers: open PRs, «Мои» / «По задачам» only
  const [scopeRaw, setScopeState] = useState<PrScope>(() => loadDraft<PrScope>('prs:scope') ?? 'mine')
  const [stateRaw, setStateState] = useState<PrState>(() => loadDraft<PrState>('prs:state') ?? 'open')
  const scope: PrScope = filtersOn || scopeRaw === 'mine' || scopeRaw === 'tracked' ? scopeRaw : 'mine'
  const state: PrState = filtersOn ? stateRaw : 'open'
  const setScope = (v: PrScope) => { setScopeState(v); saveDraft('prs:scope', v === 'mine' ? null : v) }
  const setPrState = (v: PrState) => { setStateState(v); saveDraft('prs:state', v === 'open' ? null : v) }
  const key = prsKey(scope, state)
  const active = useStore((s) => s.settings?.integrations?.pr?.active)
  const cached = useStore((s) => s.prsMine[key])
  const data = active === false ? 'off' : cached
  const now = useNow()
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => { if (active !== false) loadPrsMine(scope, cached === 'off', state) }, [scope, state, active])
  useEffect(() => { if (refreshing && data && typeof data === 'object' && !('error' in data)) setRefreshing(false) }, [data, refreshing])
  const refresh = () => { setRefreshing(true); loadPrsMine(scope, true, state) }
  // the PR page over the list (store view): the list stays mounted under it, its filters and scroll kept
  const sel = useStore((s) => (s.view.kind === 'screen' && s.view.detail?.kind === 'pr' ? s.view.detail.pr : null))
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<PrFilters>(NO_PR_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersRef = useRef<HTMLButtonElement>(null)

  const list = data && typeof data === 'object' && 'items' in data ? data : null
  const repoErrors = (list?.errors ?? []).filter((e): e is { repo: string; error: string } => !!e.repo)
  const all = useMemo(() => [...(list?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt), [list])
  const rows = useMemo(() => filterPrs(all, query, filters), [all, query, filters])
  const options = useMemo(() => prFilterOptions(all), [all])
  const nFilters = activePrFilters(filters)
  const narrowed = nFilters > 0 || !!query.trim()

  // the row's button goes to a worktree of its branch: the repositories' worktree lists are needed
  const worktrees = useStore((s) => s.worktrees)
  useEffect(() => {
    const missing = [...new Set(all.map((i) => i.workspaceId).filter((id): id is string => !!id && !worktrees[id]))]
    if (missing.length) void loadWorktreesOf(missing)
  }, [all])

  const filterItems: MenuItem[] = FILTERS.map(({ key: k, label }) => ({
    label, hint: filters[k] || undefined, disabled: !options[k].length,
    children: [
      { label: 'Любой', hint: filters[k] ? undefined : '✓', onSelect: () => setFilters({ ...filters, [k]: '' }) },
      ...options[k].map((v) => ({ label: v, hint: filters[k] === v ? '✓' : undefined, onSelect: () => setFilters({ ...filters, [k]: v }) })),
    ],
  }))
  if (nFilters) filterItems.push({ label: 'Сбросить фильтры', divider: true, onSelect: () => setFilters(NO_PR_FILTERS) })

  const scopes = [
    ...(filtersOn ? [{ value: 'all' as const, label: 'Все', hint: 'Все PR зарегистрированных репозиториев' }] : []),
    { value: 'mine' as const, label: 'Мои', hint: 'Мои PR во всех репозиториях' },
    ...(filtersOn ? [{ value: 'review' as const, label: 'На ревью', hint: 'PR, где вы в ревьюерах' }] : []),
    { value: 'tracked' as const, label: 'По задачам', hint: 'PR веток задач и рабочих деревьев harness' },
  ]
  const whose = scope === 'mine' ? 'Ваши PR во всех репозиториях' : scope === 'review' ? 'PR, где вы в ревьюерах,' : scope === 'tracked' ? 'PR веток задач' : 'PR зарегистрированных репозиториев'

  return (
    <>
    <div className="prs-view" inert={!!sel}>
      <header className="view-head">
        <h1>Пулл-реквесты</h1>
        {list && <span className="count">{narrowed ? `${rows.length} из ${all.length}` : all.length}</span>}
        {(scope === 'mine' || scope === 'review') && list?.me && <span className="muted">как <span className="mono">{list.me}</span>{list.meSource === 'os' && <> (имя пользователя ОС, <button type="button" className="link" onClick={openPrSettings}>уточнить</button>)</>}</span>}
        <span className="grow" />
        {list && <span className="muted num">обновлено {ago(list.at, now)}</span>}
        {data !== 'off' && <Button size="sm" variant="ghost" icon={<RefreshCw className={refreshing ? 'spinner' : undefined} />} disabled={refreshing} onClick={refresh}>Обновить</Button>}
      </header>
      {data !== 'off' && (
        <div className="prs-toolbar">
          {filtersOn && <Segmented size="sm" label="Статус PR" value={state} onChange={setPrState} options={STATES} />}
          <Segmented size="sm" label="Какие PR" value={scope} onChange={setScope} options={scopes} />
          <button ref={filtersRef} type="button" className="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
            <ListFilter />Фильтры{nFilters > 0 && <span className="count">{nFilters}</span>}
          </button>
          <Menu anchor={filtersRef} open={filtersOpen} onClose={() => setFiltersOpen(false)} items={filterItems} label="Фильтр пулл-реквестов" />
          <div className="search prs-search">
            <Search aria-hidden />
            <input className="input" type="search" placeholder="Название, #номер, ветка, автор, задача" aria-label="Поиск PR" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
      )}
      {data === undefined || data === null ? (
        <div className="prs-list"><Skeleton rows={6} label="Загрузка PR…" /></div>
      ) : data === 'off' ? (
        <div className="empty">
          <GitPullRequest className="empty-icon" aria-hidden />
          <h2>PR-интеграция не настроена</h2>
          <p>Подключите MCP-сервер sourcecontrol, и здесь появятся ваши PR во всех репозиториях: статус, ревьюеры, конфликты.</p>
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
          {all.length === 0 && repoErrors.length > 0 && (
            <div className="empty">
              <TriangleAlert className="empty-icon" aria-hidden />
              <h2>Репозитории не ответили</h2>
              <p>Ни один репозиторий не отдал данные. Причина ниже.</p>
            </div>
          )}
          {all.length === 0 && repoErrors.length === 0 && (
            <div className="empty">
              <GitPullRequest className="empty-icon" aria-hidden />
              <h2>{NONE[state]}</h2>
              <p>{whose} появятся здесь.</p>
            </div>
          )}
          {all.length > 0 && rows.length === 0 && (
            <div className="empty">
              <Search className="empty-icon" aria-hidden />
              <h2>Ничего не найдено</h2>
              <p>Ни один из {all.length} PR не подходит под поиск и фильтры.</p>
              <Button onClick={() => { setQuery(''); setFilters(NO_PR_FILTERS) }}>Сбросить</Button>
            </div>
          )}
          {rows.length > 0 && (
            <div className="pr-table" role="table" aria-label="Пулл-реквесты">
              <div className="pr-tr pr-th" role="row">
                <span role="columnheader">ID</span>
                <span role="columnheader">Название / контекст</span>
                <span role="columnheader">Рецензенты</span>
                <span role="columnheader">Состояние</span>
                <span role="columnheader">Обновлено</span>
                <span role="columnheader" aria-label="Действие" />
              </div>
              {rows.map((it) => <PrRow key={it.url ?? `${it.repo}#${it.index}`} it={it} now={now} />)}
            </div>
          )}
          {repoErrors.length > 0 && (
            <Disclosure className="prs-errors" summary={<span className="muted">Не ответили {repoErrors.length} {plural(repoErrors.length, 'репозиторий', 'репозитория', 'репозиториев')}</span>}>
              <ul>{repoErrors.map((e) => <li key={e.repo}><strong>{e.repo}</strong> <span className="muted mono">{e.error}</span></li>)}</ul>
            </Disclosure>
          )}
        </div>
      )}
    </div>
    {sel && <ErrorBoundary area="страницу PR"><PrPage key={`${sel.repo}#${sel.index}`} pr={sel} /></ErrorBoundary>}
    </>
  )
}

function PrRow({ it, now }: { it: PrItem; now: number }) {
  const work = usePrWork(it)
  const actionsOn = useFeature('pr-actions') && !!it.workspaceId && it.state === 'open'
  const st = prStanding(it)
  const browse = () => window.open(it.url, '_blank', 'noopener,noreferrer')
  // newer servers: the row opens the PR here (its diff, comments); the menu opens it in the browser
  const detail = useFeature('pr-detail') && !!it.workspaceId
  const pick = () => (detail ? openPr(it) : browse())
  const menu: MenuItem[] = [
    ...(detail ? [{ label: 'Открыть PR здесь', icon: <PanelRight />, onSelect: () => openPr(it) }] : []),
    { label: 'Открыть в браузере', icon: <ExternalLink />, onSelect: browse },
    ...(it.taskId ? [{ label: `Задача ${it.taskKey ?? it.taskId}`, icon: <FolderGit2 />, onSelect: () => openTask(it.taskId!) }] : []),
    ...(actionsOn ? [
      {
        label: `Влить в ${it.base}`, icon: <GitMerge />, divider: true, disabled: it.mergeable === false, onSelect: () => prAction(it, 'merge'),
        tip: it.mergeable === false ? 'Конфликт с базовой веткой: сначала разрешите его' : st.k === 'approved' ? undefined : 'Ревью ещё не завершено: сервис может не дать влить',
      },
      { label: 'Закрыть без вливания…', icon: <XCircle />, danger: true, onSelect: () => prAction(it, 'decline') },
    ] : []),
  ]
  return (
    <div className="pr-tr pr-row-link" role="row" tabIndex={0} data-tip={detail ? 'Открыть PR: изменения и комментарии' : 'Открыть PR в новой вкладке'} onClick={pick}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick() } }}>
      <span role="cell" className="pr-td-id mono"><PrGlyph pr={{ index: it.index, state: it.state, url: it.url, updatedAt: it.updatedAt }} />#{it.index}</span>
      <span role="cell" className="pr-row-main">
        <span className="pr-row-title"><strong>{it.title}</strong></span>
        <span className="pr-row-meta">
          {it.author && <span>{it.author}</span>}
          <span>{it.repo}</span>
          <span className="mono">{it.head} → {it.base}</span>
          {it.taskId && <button type="button" className="chip chip-mono" onClick={(e) => { stop(e); openTask(it.taskId!) }} data-tip="Открыть задачу">{it.taskKey ?? it.taskId}</button>}
          {it.sessionId && <span className="chip pr-agent" data-tip="PR создал агент в harness"><Bot aria-hidden />агент</span>}
        </span>
      </span>
      <span role="cell" className="pr-reviewers">
        {it.reviewers.length ? it.reviewers.map((r) => {
          const k = reviewKind(r.status)
          const Icon = REVIEW_ICON[k]
          return <span key={r.name} className="chip pr-reviewer" data-k={k} data-tip={`${r.name}: ${REVIEW_TIP[k]} (${r.status})`}><Icon aria-hidden />{r.name}</span>
        }) : <span className="muted">нет</span>}
      </span>
      <span role="cell"><span className="pr-standing" data-k={st.k}>{st.label}</span></span>
      <span role="cell" className="muted" data-tip={new Date(it.updatedAt).toLocaleString('ru-RU')}>{ago(it.updatedAt, now)}</span>
      <span role="cell" className="pr-actions" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
        {/* only the way back to the work behind the PR: opening the PR itself is the row's own click */}
        {work && <Button size="sm" tip={work.tip} icon={work.kind === 'chat' ? <MessageSquare /> : <FolderGit2 />} onClick={work.run}>{work.kind === 'chat' ? 'К чату' : 'К дереву'}</Button>}
        <MenuButton label={`Действия с PR #${it.index}`} icon={<Ellipsis />} align="right" className="icon-btn-sm" items={menu} />
      </span>
    </div>
  )
}
