import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Bot, Check, ChevronRight, Clock, ExternalLink, GitMerge, GitPullRequest, RefreshCw, TriangleAlert, X, XCircle } from 'lucide-react'
import { api, errorText, qs, tryApi } from '../api'
import { parseDiff, type DiffFile } from '../lib/diff'
import { FileDiff } from './DiffView'
import { Markdown } from '../components/Markdown'
import { openDialog, openSession, openTask, toast, useFeature, useStore } from '../store'
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
  const active = useStore((s) => s.settings?.integrations?.pr?.active)
  const cached = useStore((s) => s.prsMine[scope])
  const data = active === false ? 'off' : cached
  const now = useNow()
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => { if (active !== false) loadPrsMine(scope, cached === 'off') }, [scope, active])
  useEffect(() => { if (refreshing && data && typeof data === 'object' && !('error' in data)) setRefreshing(false) }, [data, refreshing])
  const refresh = () => { setRefreshing(true); loadPrsMine(scope, true) }
  const [sel, setSel] = useState<PrItem | null>(null) // the PR open in the drawer

  const list = data && typeof data === 'object' && 'items' in data ? data : null
  const repoErrors = (list?.errors ?? []).filter((e): e is { repo: string; error: string } => !!e.repo)
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
        {scope === 'mine' && list?.me && <span className="muted">как <span className="mono">{list.me}</span>{list.meSource === 'os' && <> — по имени пользователя ОС, <button type="button" className="link" onClick={openPrSettings}>уточнить</button></>}</span>}
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
          {repos.length === 0 && repoErrors.length > 0 && (
            <div className="empty">
              <TriangleAlert className="empty-icon" aria-hidden />
              <h2>Репозитории не ответили</h2>
              <p>{scope === 'mine' ? 'Список пуст, потому что ни один репозиторий не отдал данные — причина ниже.' : 'PR веток задач неизвестны: ни один репозиторий не отдал данные — причина ниже.'}</p>
            </div>
          )}
          {repos.length === 0 && repoErrors.length === 0 && (
            <div className="empty">
              <GitPullRequest className="empty-icon" aria-hidden />
              <h2>Открытых PR нет</h2>
              <p>{scope === 'mine' ? 'Ваши открытые PR во всех репозиториях появятся здесь.' : 'PR веток задач появятся здесь, когда их создадут.'}</p>
            </div>
          )}
          {repos.map(({ repo, items }) => <RepoGroup key={repo} repo={repo} items={items} now={now} onPick={setSel} />)}
          {repoErrors.length > 0 && (
            <Disclosure className="prs-errors" summary={<span className="muted">Не ответили {repoErrors.length} {plural(repoErrors.length, 'репозиторий', 'репозитория', 'репозиториев')}</span>}>
              <ul>{repoErrors.map((e) => <li key={e.repo}><strong>{e.repo}</strong> <span className="muted mono">{e.error}</span></li>)}</ul>
            </Disclosure>
          )}
        </div>
      )}
      {sel && <PrDrawer key={`${sel.repo}#${sel.index}`} it={sel} now={now} onClose={() => setSel(null)} />}
    </div>
  )
}

function RepoGroup({ repo, items, now, onPick }: { repo: string; items: PrItem[]; now: number; onPick: (it: PrItem) => void }) {
  const [open, setOpenState] = useState(() => loadDraft<boolean>(`prs:open:${repo}`) ?? true)
  const toggle = () => { setOpenState(!open); saveDraft(`prs:open:${repo}`, open ? false : null) }
  return (
    <section className="prs-repo">
      <button type="button" className="prs-group" aria-expanded={open} onClick={toggle}>
        <ChevronRight className="chev" aria-hidden />
        {repo} <span className="count">{items.length}</span>
      </button>
      {open && items.map((it) => <PrRow key={it.url} it={it} now={now} onPick={onPick} />)}
    </section>
  )
}

const REVIEW_ICON = { approved: Check, changes: X, pending: Clock }
const REVIEW_TIP = { approved: 'одобрил', changes: 'просит изменения', pending: 'ещё не ответил' }

/** Where the PR stands, in one word: what to do next is seen without reading every reviewer chip. */
function prStanding(it: PrItem): { k: 'conflict' | 'changes' | 'approved' | 'review' | 'none'; label: string } {
  const kinds = it.reviewers.map((r) => reviewKind(r.status))
  const ok = kinds.filter((k) => k === 'approved').length
  if (it.mergeable === false) return { k: 'conflict', label: 'Конфликт' }
  if (kinds.includes('changes')) return { k: 'changes', label: 'Просят изменения' }
  if (!kinds.length) return { k: 'none', label: 'Без ревьюеров' }
  if (ok === kinds.length) return { k: 'approved', label: 'Одобрен' }
  return { k: 'review', label: ok ? `Одобрен ${ok} из ${kinds.length}` : `Ждёт ревью · 0 из ${kinds.length}` }
}

/** Merge / close from the list (confirmed: on the code host it cannot be taken back here); the lists re-read after. */
function prAction(it: PrItem, action: 'merge' | 'decline') {
  const merge = action === 'merge'
  openDialog({
    kind: 'confirm', danger: !merge,
    title: merge ? `Влить PR #${it.index}?` : `Закрыть PR #${it.index} без вливания?`,
    text: `${it.title}\n${it.head} → ${it.base} (${it.repo})${merge ? '' : '\nВетка останется, PR можно будет создать заново.'}`,
    ok: merge ? 'Влить' : 'Закрыть PR',
    onConfirm: () => void tryApi('POST', `/prs/${action}`, { workspaceId: it.workspaceId, index: it.index }).then((r) => {
      if (r === undefined) return
      toast(merge ? `PR #${it.index} влит` : `PR #${it.index} закрыт`, 'ok')
      loadPrsMine('mine', true)
      loadPrsMine('tracked', true)
    }),
  })
}

function PrRow({ it, now, onPick }: { it: PrItem; now: number; onPick: (it: PrItem) => void }) {
  const session = useStore((s) => (it.sessionId ? s.sessions.find((x) => x.id === it.sessionId) : undefined))
  const actionsOn = useFeature('pr-actions') && !!it.workspaceId
  const st = prStanding(it)
  const open = () => window.open(it.url, '_blank', 'noopener,noreferrer')
  // newer servers: the row opens the PR here (its diff, comments); the icon opens it in the browser
  const detail = useFeature('pr-detail') && !!it.workspaceId
  const pick = () => (detail ? onPick(it) : open())
  return (
    <div className="pr-row pr-row-link" role="link" tabIndex={0} data-tip={detail ? 'Открыть PR: изменения и комментарии' : 'Открыть PR в новой вкладке'} onClick={pick}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick() } }}>
      <span className="pr-standing" data-k={st.k}>{st.label}</span>
      <span className="pr-row-main">
        <span className="pr-row-title"><span className="mono muted">#{it.index}</span> <strong>{it.title}</strong></span>
        <span className="pr-row-meta">
          <span className="mono">{it.head} → {it.base}</span>
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
      {actionsOn && (
        <span className="pr-actions" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
          <Button size="sm" variant={st.k === 'approved' ? 'primary' : undefined} icon={<GitMerge />} disabled={it.mergeable === false}
            tip={it.mergeable === false ? 'Конфликт с базовой веткой: сначала разрешите его' : st.k === 'approved' ? 'Влить в ' + it.base : 'Влить в ' + it.base + ' (ревью ещё не завершено — сервис может не дать)'}
            onClick={() => prAction(it, 'merge')}>Влить</Button>
          <Button size="sm" variant="ghost" icon={<XCircle />} tip="Закрыть без вливания" onClick={() => prAction(it, 'decline')}>Закрыть</Button>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Открыть PR в браузере" data-tip="Открыть PR в браузере" onClick={open}><ExternalLink /></button>
        </span>
      )}
    </div>
  )
}

interface PrDetail { diff: { text?: string; error?: string; local?: boolean; hostError?: string | null }; comments: { items?: { author: string | null; text: string; at: number | null; path: string | null; line: number | null }[]; error?: string } }

/** One PR in detail beside the list: where it stands, its reviewers, its changes file by file and its comments. */
function PrDrawer({ it, now, onClose }: { it: PrItem; now: number; onClose: () => void }) {
  const [d, setD] = useState<PrDetail | { error: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<'files' | 'comments'>('files')
  const cwd = useStore((s) => s.workspaces.find((w) => w.id === it.workspaceId)?.path ?? '')
  const actionsOn = useFeature('pr-actions') && !!it.workspaceId
  useEffect(() => {
    let live = true
    setD(null)
    api<PrDetail>('GET', `/prs/detail${qs({ workspaceId: it.workspaceId ?? '', index: String(it.index), head: it.head, base: it.base })}`)
      .then((r) => { if (live) setD(r) }, (e) => { if (live) setD({ error: errorText(e) }) })
    return () => { live = false }
  }, [it, attempt])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const st = prStanding(it)
  const files: DiffFile[] = d && !('error' in d) && d.diff.text ? parseDiff(d.diff.text) : []
  const comments = d && !('error' in d) ? d.comments.items ?? [] : []
  const problem = d && ('error' in d ? d.error : tab === 'files' ? d.diff.error : d.comments.error)
  return (
    <aside className="pr-drawer" aria-label={`PR #${it.index}`}>
      <header className="pr-drawer-head">
        <div><span className="muted">{it.repo} · PR #{it.index}</span><h2>{it.title}</h2></div>
        <button type="button" className="icon-btn" aria-label="Закрыть панель PR" data-tip="Закрыть панель (Esc)" onClick={onClose}><X /></button>
      </header>
      <div className="pr-drawer-meta">
        <span className="mono">{it.head} → {it.base}</span>
        <span className="pr-standing" data-k={st.k}>{st.label}</span>
        <span className="muted">обновлён {ago(it.updatedAt, now)}</span>
        {it.taskId && <button type="button" className="chip chip-mono" onClick={() => openTask(it.taskId!)}>{it.taskKey ?? it.taskId}</button>}
        {it.sessionId && <button type="button" className="chip pr-agent" onClick={() => openSession(it.sessionId!)}><Bot aria-hidden />агент</button>}
      </div>
      {it.reviewers.length > 0 && (
        <ul className="pr-drawer-reviewers">
          {it.reviewers.map((r) => { const k = reviewKind(r.status); const Icon = REVIEW_ICON[k]; return <li key={r.name} data-k={k}><Icon aria-hidden /><span className="mono">{r.name}</span> <span className="muted">{REVIEW_TIP[k]}</span></li> })}
        </ul>
      )}
      <div className="pr-drawer-actions">
        {actionsOn && <Button size="sm" variant={st.k === 'approved' ? 'primary' : undefined} icon={<GitMerge />} disabled={it.mergeable === false} onClick={() => prAction(it, 'merge')}>Влить</Button>}
        {actionsOn && <Button size="sm" variant="ghost" icon={<XCircle />} onClick={() => prAction(it, 'decline')}>Закрыть</Button>}
        <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => window.open(it.url, '_blank', 'noopener,noreferrer')}>Открыть в браузере</Button>
      </div>
      <Segmented size="sm" label="Что показать" value={tab} onChange={setTab}
        options={[{ value: 'files', label: d && !('error' in d) && !d.diff.error ? `Изменения · ${files.length}` : 'Изменения' }, { value: 'comments', label: d && !('error' in d) && !d.comments.error ? `Комментарии · ${comments.length}` : 'Комментарии' }]} />
      <div className="pr-drawer-body">
        {d === null ? <Skeleton rows={6} label="Загрузка PR…" />
          : problem ? <div className="pr-load-error" role="status">
            <strong>{tab === 'files' ? 'Не удалось загрузить изменения' : 'Не удалось загрузить комментарии'}</strong>
            <Button size="sm" icon={<RefreshCw />} onClick={() => setAttempt((n) => n + 1)}>Повторить</Button>
            <Disclosure summary="Технические подробности"><p>{problem}</p></Disclosure>
          </div>
          : !('error' in d) && (tab === 'files' ? (
            <>
              {d.diff.local && <p className="muted pr-drawer-note">Показаны изменения по локальным веткам.</p>}
              {files.map((f, i) => <FileDiff key={`${f.path}:${i}`} cwd={cwd} f={f} open={i < 10} />)}
              {files.length === 0 && <p className="muted pr-drawer-note">Изменений нет.</p>}
            </>
          ) : (
            <>
              {!d.comments.error && comments.length === 0 && <p className="muted pr-drawer-note">Комментариев нет.</p>}
              <ul className="pr-comments">
                {comments.map((c, i) => (
                  <li key={i}>
                    <div className="pr-comment-head"><strong>{c.author ?? 'кто-то'}</strong>{c.at && <span className="muted"> · {ago(c.at, now)}</span>}{c.path && <span className="mono muted"> · {c.path}{c.line ? `:${c.line}` : ''}</span>}</div>
                    <div className="md-preview"><Markdown text={c.text} /></div>
                  </li>
                ))}
              </ul>
            </>
          ))}
      </div>
    </aside>
  )
}
