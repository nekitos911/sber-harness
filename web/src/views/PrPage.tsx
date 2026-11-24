import { useEffect, useState } from 'react'
import { ArrowRight, Bot, Check, Clock, Copy, ExternalLink, FileDiff as FileDiffIcon, GitMerge, MessageSquare, RefreshCw, X, XCircle } from 'lucide-react'
import { api, errorText, qs, tryApi } from '../api'
import { parseDiff, type DiffFile } from '../lib/diff'
import { FileDiff } from './DiffView'
import { Markdown } from '../components/Markdown'
import { openDialog, openSession, openTask, openWorktree, toast, useFeature, useStore, type State } from '../store'
import { reloadPrsMine, type PrItem } from '../lib/prsMine'
import { ago, plural, reviewKind } from '../lib/format'
import { copy } from '../components/WorktreeMenu'
import { useNow } from '../lib/useNow'
import { Skeleton } from '../components/bits'
import { PrGlyph } from '../components/PrChip'
import { DetailBar } from '../components/DetailPage'
import { Button, Disclosure, IconButton } from '../components/ui'

export const REVIEW_ICON = { approved: Check, changes: X, pending: Clock }
export const REVIEW_TIP = { approved: 'одобрил', changes: 'просит изменения', pending: 'ещё не ответил' }
const STATE_WORD = { open: 'Открыт', merged: 'Влит', declined: 'Закрыт' }

/** Where the PR stands, in one word: what to do next is seen without reading every reviewer chip. */
export function prStanding(it: PrItem): { k: 'conflict' | 'changes' | 'approved' | 'review' | 'none' | 'merged' | 'declined'; label: string } {
  if (it.state === 'merged' || it.state === 'declined') return { k: it.state, label: it.state === 'merged' ? 'Влит' : 'Закрыт' }
  const kinds = it.reviewers.map((r) => reviewKind(r.status))
  const ok = kinds.filter((k) => k === 'approved').length
  if (it.mergeable === false) return { k: 'conflict', label: 'Конфликт' }
  if (kinds.includes('changes')) return { k: 'changes', label: 'Просят изменения' }
  if (!kinds.length) return { k: 'none', label: 'Без ревьюеров' }
  if (ok === kinds.length) return { k: 'approved', label: 'Одобрен' }
  return { k: 'review', label: ok ? `Одобрен ${ok} из ${kinds.length}` : `Ждёт ревью · 0 из ${kinds.length}` }
}

/** Merge / close (confirmed: on the code host it cannot be taken back here); the lists re-read after. */
export function prAction(it: PrItem, action: 'merge' | 'decline') {
  const merge = action === 'merge'
  openDialog({
    kind: 'confirm', danger: !merge,
    title: merge ? `Влить PR #${it.index}?` : `Закрыть PR #${it.index} без вливания?`,
    text: `${it.title}\n${it.head} → ${it.base} (${it.repo})${merge ? '' : '\nВетка останется, PR можно будет создать заново.'}`,
    ok: merge ? 'Влить' : 'Закрыть PR',
    onConfirm: () => void tryApi('POST', `/prs/${action}`, { workspaceId: it.workspaceId, index: it.index }).then((r) => {
      if (r === undefined) return
      toast(merge ? `PR #${it.index} влит` : `PR #${it.index} закрыт`, 'ok')
      reloadPrsMine()
    }),
  })
}

/** The work behind a PR in the harness: its agent's chat, else a worktree of its branch (none: null). */
export function usePrWork(it: PrItem) {
  const session = useStore((s) => (it.sessionId ? s.sessions.find((x) => x.id === it.sessionId && !x.archived) : undefined))
  const wt = useStore((s) => (it.workspaceId && it.head ? s.worktrees[it.workspaceId]?.find((w) => !w.main && w.branch === it.head) : undefined))
  return session ? { kind: 'chat' as const, tip: `${session.title}: открыть чат`, run: () => openSession(session.id) }
    : wt ? { kind: 'wt' as const, tip: `Открыть рабочее дерево ${wt.path}`, run: () => openWorktree(wt.path) }
      : null
}

/** The list's newest copy of this PR (merged / closed / reviewed since it was opened), else the one we were given. */
const livePr = (s: State, pr: PrItem): PrItem | undefined => {
  for (const l of Object.values(s.prsMine)) {
    if (!l || typeof l !== 'object' || !('items' in l)) continue
    const hit = l.items.find((i) => (pr.url ? i.url === pr.url : i.repo === pr.repo && i.index === pr.index))
    if (hit) return hit
  }
}

interface PrDetail { diff: { text?: string; error?: string; local?: boolean; hostError?: string | null }; comments: { items?: { author: string | null; text: string; at: number | null; path: string | null; line: number | null }[]; error?: string } }

/** One PR as a page over «Пулл-реквесты»: where it stands, its comments, its changes file by file; merge, reviewers, task on the right. */
export function PrPage({ pr }: { pr: PrItem }) {
  const it = useStore((s) => livePr(s, pr)) ?? pr
  const now = useNow()
  const [d, setD] = useState<PrDetail | { error: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<'talk' | 'files'>('talk')
  const cwd = useStore((s) => s.workspaces.find((w) => w.id === it.workspaceId)?.path ?? '')
  const task = useStore((s) => (it.taskId ? s.tasks.find((t) => t.id === it.taskId) : undefined))
  const actionsOn = useFeature('pr-actions') && !!it.workspaceId && it.state === 'open'
  const work = usePrWork(it)
  useEffect(() => {
    let live = true
    setD(null)
    api<PrDetail>('GET', `/prs/detail${qs({ workspaceId: it.workspaceId ?? '', index: String(it.index), head: it.head, base: it.base })}`)
      .then((r) => { if (live) setD(r) }, (e) => { if (live) setD({ error: errorText(e) }) })
    return () => { live = false }
  }, [it.workspaceId, it.index, it.head, it.base, attempt])
  const refresh = () => { setAttempt((n) => n + 1); reloadPrsMine() }
  const st = prStanding(it)
  const ok = d && !('error' in d) ? d : null
  const files: DiffFile[] = ok?.diff.text ? parseDiff(ok.diff.text) : []
  const comments = ok?.comments.items ?? []
  const problem = d && ('error' in d ? d.error : tab === 'files' ? d.diff.error : d.comments.error)
  const browse = () => window.open(it.url, '_blank', 'noopener,noreferrer')

  return (
    <div className="detail-page" role="region" aria-label={`PR #${it.index}`} tabIndex={-1}>
      <DetailBar back="Пулл-реквесты" crumbs={<><span>{it.repo}</span><span aria-hidden>·</span><span className="mono">#{it.index}</span></>}>
        <IconButton label="Обновить" icon={<RefreshCw />} onClick={refresh} />
        <IconButton label="Копировать ссылку" icon={<Copy />} onClick={() => copy(it.url, 'ссылка на PR')} />
        <IconButton label="Открыть в браузере" icon={<ExternalLink />} onClick={browse} />
      </DetailBar>
      <div className="dp-scroll">
        <header className="dp-head">
          <h1 className="dp-title dp-title-text">{it.title} <span className="dp-key">#{it.index}</span></h1>
          {work && (
            <div className="dp-primary">
              <Button variant="primary" tip={work.tip} icon={work.kind === 'chat' ? <MessageSquare /> : undefined} onClick={work.run}>
                {work.kind === 'chat' ? 'Открыть чат' : 'Открыть рабочее дерево'}<ArrowRight />
              </Button>
            </div>
          )}
          <div className="dp-sub">
            <span className="dp-pr-state" data-state={it.state}><PrGlyph pr={{ index: it.index, state: it.state, url: it.url, updatedAt: it.updatedAt }} />{STATE_WORD[it.state]}</span>
            {it.author && <strong>{it.author}</strong>}
            <span className="dp-branches"><span className="chip chip-mono" data-tip="Ветка PR">{it.head}</span><ArrowRight aria-label="в" /><span className="chip chip-mono" data-tip="Целевая ветка">{it.base}</span></span>
            <span className="muted" data-tip={new Date(it.updatedAt).toLocaleString('ru-RU')}>обновлён {ago(it.updatedAt, now)}</span>
          </div>
        </header>

        <div className="dp-tabs" role="tablist" aria-label="Что показать">
          <button type="button" role="tab" className="dp-tab" aria-selected={tab === 'talk'} onClick={() => setTab('talk')}>
            <MessageSquare aria-hidden />Обсуждение{ok && !ok.comments.error && <span className="count">{comments.length}</span>}
          </button>
          <button type="button" role="tab" className="dp-tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
            <FileDiffIcon aria-hidden />Изменённые файлы{ok && !ok.diff.error && <span className="count">{files.length}</span>}
          </button>
        </div>

        <div className="dp-cols">
          <div className="dp-main" role="tabpanel">
            {d === null ? <Skeleton rows={6} label="Загрузка PR…" />
              : problem ? (
                <div className="pr-load-error" role="status">
                  <strong>{tab === 'files' ? 'Не удалось загрузить изменения' : 'Не удалось загрузить комментарии'}</strong>
                  <Button size="sm" icon={<RefreshCw />} onClick={() => setAttempt((n) => n + 1)}>Повторить</Button>
                  <Disclosure summary="Технические подробности"><p>{problem}</p></Disclosure>
                </div>
              ) : ok && (tab === 'files' ? (
                <>
                  {ok.diff.local && <p className="muted pr-drawer-note">Сервис кода не отдал дифф: показаны изменения по локальным веткам.</p>}
                  {files.length > 0 && (
                    <nav className="dp-files" aria-label="Изменённые файлы">
                      <span className="muted">{files.length} {plural(files.length, 'файл', 'файла', 'файлов')} <span className="diff-stat num"><span className="add">+{files.reduce((n, f) => n + f.added, 0)}</span> <span className="del">−{files.reduce((n, f) => n + f.removed, 0)}</span></span></span>
                      <ul>
                        {files.map((f, i) => (
                          <li key={`${f.path}:${i}`}>
                            <button type="button" className="dp-file" data-tip={f.path} data-tip-trunc onClick={() => document.getElementById(`prf-${i}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>
                              <span className="ellipsis mono">{f.path}</span>
                              <span className="diff-stat num"><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </nav>
                  )}
                  {files.map((f, i) => <div key={`${f.path}:${i}`} id={`prf-${i}`} className="dp-file-diff"><FileDiff cwd={cwd} f={f} open={i < 10} /></div>)}
                  {files.length === 0 && <p className="muted pr-drawer-note">Изменений нет.</p>}
                </>
              ) : (
                <>
                  {comments.length === 0 && <p className="dp-card muted">Комментариев пока нет.</p>}
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

          <aside className="dp-side">
            <section className="dp-card">
              <h3 className="dp-card-head"><GitMerge aria-hidden />Запрос на слияние <span className="pr-standing" data-k={st.k}>{st.label}</span></h3>
              {actionsOn ? (
                <div className="dp-side-actions">
                  <Button variant={st.k === 'approved' ? 'primary' : undefined} icon={<GitMerge />} disabled={it.mergeable === false}
                    tip={it.mergeable === false ? 'Конфликт с базовой веткой: сначала разрешите его' : st.k === 'approved' ? undefined : 'Ревью ещё не завершено — сервис может не дать'}
                    onClick={() => prAction(it, 'merge')}>Влить в {it.base}</Button>
                  <Button variant="ghost" icon={<XCircle />} onClick={() => prAction(it, 'decline')}>Закрыть PR</Button>
                </div>
              ) : (
                <p className="muted">{it.state === 'open' ? 'Влить и закрыть можно в браузере.' : it.state === 'merged' ? `Влит в ${it.base}.` : 'Закрыт без вливания.'}</p>
              )}
            </section>
            <section className="dp-side-block">
              <h3 className="dp-label">Ревьюеры</h3>
              {it.reviewers.length ? (
                <ul className="pr-drawer-reviewers dp-reviewers">
                  {it.reviewers.map((r) => { const k = reviewKind(r.status); const Icon = REVIEW_ICON[k]; return <li key={r.name} data-k={k} data-tip={r.status}><Icon aria-hidden /><span className="mono">{r.name}</span> <span className="muted">{REVIEW_TIP[k]}</span></li> })}
                </ul>
              ) : <p className="muted">Ревью не запрошено.</p>}
            </section>
            <section className="dp-side-block">
              <h3 className="dp-label">Связанная задача</h3>
              {it.taskId ? (
                <button type="button" className="dp-task" onClick={() => openTask(it.taskId!)} data-tip="Открыть задачу">
                  <span className="chip chip-mono">{it.taskKey ?? it.taskId}</span>
                  {task && <span className="ellipsis">{task.title}</span>}
                </button>
              ) : <p className="muted">Не связан с задачей.</p>}
              {it.sessionId && <button type="button" className="chip pr-agent" onClick={() => openSession(it.sessionId!)} data-tip="Открыть чат агента"><Bot aria-hidden />агент harness</button>}
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
