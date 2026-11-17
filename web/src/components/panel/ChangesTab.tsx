import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, GitPullRequest, RotateCcw, Upload } from 'lucide-react'
import { api, qs, tryApi } from '../../api'
import { openDialog, openTab, openTask, openWorktree, showPanel, toast, useFeature, useStore } from '../../store'
import { basename, normPath, plural, relTime, shortHash } from '../../lib/format'
import { loadDraft, saveDraft } from '../../lib/draft'
import { diffOf, gsLetter, refreshGit, splitPath, useGit } from '../../lib/git'
import { useNow } from '../../lib/useNow'
import type { GitCommit, GitFile, GitSuggest } from '../../types'
import type { DiffFile } from '../../lib/diff'
import { DiffLines } from '../DiffLines'
import { Button, Disclosure } from '../ui'
import { runJob } from '../../lib/jobs'
import { PrCard } from '../PrChip'
import { openPrSettings, usePr } from '../../lib/pr'
import { Skeleton } from '../bits'

const STATUS_LABEL: Record<GitFile['status'], string> = { M: 'изменён', A: 'добавлен', D: 'удалён', R: 'переименован', '?': 'новый, не в git', U: 'конфликт' }

export function ChangesTab({ cwd }: { cwd: string }) {
  const prEnabled = useStore((s) => s.integrations.pr)
  const git = useGit(cwd)
  const now = useNow()
  const [suggest, setSuggest] = useState<GitSuggest | null>(null)
  const [log, setLog] = useState<GitCommit[] | null>(null)
  const draftKey = `commit:${normPath(cwd)}`
  const [saved] = useState(() => loadDraft<{ title: string; body: string }>(draftKey)) // typed before a reload
  const [title, setTitle] = useState(saved?.title ?? '')
  const [body, setBody] = useState(saved?.body ?? '')
  const touched = useRef(!!saved) // once the user edits, prefill never overwrites their text
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  const status = git?.status ?? null
  const filesSig = status?.files.map((f) => f.status + f.path).join('|') ?? ''
  const branch = status?.branch
  const ready = !!status

  // Refetch the prefill and log when the change set or branch changes, not on every status object.
  useEffect(() => {
    if (!ready) return
    let live = true
    api<GitSuggest>('GET', `/git/suggest${qs({ cwd })}`).then((s) => {
      if (!live) return
      setSuggest(s)
      if (!touched.current) { setTitle(s.commit.title); setBody(s.commit.body) }
    }, () => undefined)
    api<GitCommit[]>('GET', `/git/log${qs({ cwd, n: 12 })}`).then((l) => { if (live) setLog(l) }, () => undefined)
    return () => { live = false }
  }, [cwd, filesSig, branch, ready])

  if (git?.error) return <LinkedWorktrees cwd={cwd} error={git.error} />
  if (!status) return <div className="wpanel-section"><Skeleton rows={4} /></div>

  const edit = (next: { title?: string; body?: string }) => {
    touched.current = true
    const d = { title, body, ...next }
    setTitle(d.title)
    setBody(d.body)
    saveDraft(draftKey, d)
  }
  const reapply = () => {
    if (!suggest) return
    touched.current = false
    saveDraft(draftKey, null)
    setTitle(suggest.commit.title)
    setBody(suggest.commit.body)
  }

  const commit = async () => {
    const message = body.trim() ? `${title.trim()}\n\n${body.trim()}` : title.trim()
    setBusy('commit')
    const res = await tryApi<{ hash: string }>('POST', '/git/commit', { cwd, message })
    setBusy(null)
    if (!res) return
    toast(`Закоммичено ${shortHash(res.hash)}`, 'ok')
    touched.current = false
    saveDraft(draftKey, null)
    refreshGit(cwd)
  }

  const push = async () => {
    setBusy('push')
    const res = await runJob('Push', (jobId) => api<{ output: string }>('POST', '/git/push', { cwd }, { jobId }))
    setBusy(null)
    if (!res) return
    toast(res.output?.trim().split('\n').pop() || 'Отправлено', 'ok')
    refreshGit(cwd)
  }

  const toggle = (path: string) => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setOpen(next)
  }

  const files = status.files.filter((f) => !f.service)
  const service = status.files.filter((f) => f.service)
  const taskKey = suggest?.taskId ? suggest.key ?? suggest.taskId : null
  const totals = git?.files?.reduce((t, f) => ({ add: t.add + f.added, del: t.del + f.removed }), { add: 0, del: 0 })

  return (
    <>
      <section className="wpanel-section changes">
        <h3>
          {files.length === 0 ? 'Нет изменений' : <>Изменено файлов: <span className="num">{files.length}</span></>}
          {totals && files.length > 0 && <span className="diff-stat num"><span className="add">+{totals.add}</span> <span className="del">−{totals.del}</span></span>}
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="muted num ahead" data-tip={status.upstream ?? ''}>
              {status.ahead > 0 && <><ArrowUp size={11} aria-label="впереди" />{status.ahead} </>}
              {status.behind > 0 && <><ArrowDown size={11} aria-label="позади" />{status.behind}</>}
            </span>
          )}
          {files.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => openTab({ kind: 'diff', cwd, path: null })}>
              Весь diff
            </button>
          )}
        </h3>
        {files.length === 0 ? (
          <p className="muted">Рабочая копия чистая: агенты здесь ничего не меняли или всё закоммичено.</p>
        ) : (
          <ul className="change-list">
            {files.map((f) => (
              <ChangeRow key={f.path} cwd={cwd} f={f} diff={diffOf(git?.files, f.path)} loaded={!!git?.files} open={open.has(f.path)} onToggle={() => toggle(f.path)} />
            ))}
          </ul>
        )}
        {service.length > 0 && (
          <Disclosure className="service-files" summary={<span className="muted">Служебные, не коммитятся (.superpowers) · {service.length}</span>}>
            <ul className="change-list">
              {service.map((f) => (
                <ChangeRow key={f.path} cwd={cwd} f={f} diff={diffOf(git?.files, f.path)} loaded={!!git?.files} open={open.has(f.path)} onToggle={() => toggle(f.path)} />
              ))}
            </ul>
          </Disclosure>
        )}
      </section>

      <section className="wpanel-section">
        <h3>
          Коммит
          {taskKey && suggest?.taskId && (
            <button type="button" className="chip chip-mono" data-tip="Открыть задачу" onClick={() => openTask(suggest.taskId!)}>{taskKey}</button>
          )}
          {suggest && (title !== suggest.commit.title || body !== suggest.commit.body) && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={reapply} data-tip="Подставить предложенные заголовок и описание">
              <RotateCcw />
              Предложенный текст
            </button>
          )}
        </h3>
        <div className="commit-box">
          <input className="input" aria-label="Заголовок коммита" placeholder="Заголовок коммита" value={title} onChange={(e) => edit({ title: e.target.value })} />
          <textarea className="textarea" aria-label="Описание коммита" placeholder="Описание (необязательно)" rows={4} value={body} onChange={(e) => edit({ body: e.target.value })} />
          <div className="actions">
            <Button variant="primary" busy={busy === 'commit'} disabled={!title.trim() || !files.length || !!busy} onClick={commit}>
              {busy === 'commit' ? 'Коммит…' : `Закоммитить ${files.length ? files.length : ''}`.trim()}
            </Button>
            <Button icon={<Upload />} busy={busy === 'push'} disabled={!!busy} onClick={push} tip={status.upstream ? `в ${status.upstream}` : 'Опубликовать ветку'}>
              {busy === 'push' ? 'Push…' : 'Push'}
            </Button>

          </div>
        </div>
      </section>

      <PrSection cwd={cwd} enabled={prEnabled} branch={status.branch} base={suggest?.pr.base ?? null} />

      <section className="wpanel-section">
        <h3>Последние коммиты</h3>
        {log === null ? <Skeleton rows={3} /> : log.length === 0 ? <p className="muted">Коммитов пока нет.</p> : (
          <div>
            {log.map((c) => (
              <div key={c.hash} className="commit-row" data-tip={c.subject}>
                <span className="mono">{shortHash(c.hash)}</span>
                <span className="subject">{c.subject}</span>
                <span className="by">{c.author} · {relTime(c.at, now)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

/** One changed file: status letter, name strong + dir muted, +N −M; row opens the diff tab, chevron expands it inline. */
function ChangeRow({ cwd, f, diff, loaded, open, onToggle }: { cwd: string; f: GitFile; diff: DiffFile | undefined; loaded: boolean; open: boolean; onToggle: () => void }) {
  const { dir, name } = splitPath(f.path)
  return (
    <li className="change" data-open={open}>
      <div className="change-row">
        <button type="button" className="change-chev" aria-expanded={open} aria-label={open ? `Свернуть diff ${name}` : `Показать diff ${name} здесь`} onClick={onToggle}>
          <ChevronRight aria-hidden />
        </button>
        <button type="button" className="change-open" data-tip={`${f.path}: ${STATUS_LABEL[f.status]}. Открыть diff во вкладке`} onClick={() => openTab({ kind: 'diff', cwd, path: f.path })}>
          <span className="gs" data-s={f.status} aria-label={STATUS_LABEL[f.status]}>{gsLetter(f.status)}</span>
          <span className="change-name">{name}</span>
          {dir && <span className="change-dir">{dir}</span>}
          <span className="diff-stat num">
            {diff ? <><span className="add">+{diff.added}</span> <span className="del">−{diff.removed}</span></> : loaded ? '' : '…'}
          </span>
        </button>
      </div>
      <div className="collapse" data-open={open}>
        <div>
          {open && (diff
            ? diff.status === 'binary' ? <p className="muted diff-note">Двоичный файл.</p> : <DiffLines lines={diff.lines} limit={300} label={`Изменения ${f.path}`} />
            : <p className="muted diff-note">{loaded ? 'Diff недоступен.' : 'Загрузка…'}</p>)}
        </div>
      </div>
    </li>
  )
}

/** Always visible: the branch's PR (open it), «Создать PR», or why PRs are unavailable and where to set them up. */
function PrSection({ cwd, enabled, branch, base }: { cwd: string; enabled: boolean; branch: string | null; base: string | null }) {
  const supported = useFeature('pr-status')
  const pr = usePr(enabled && supported ? cwd : null)
  const off = !enabled || pr === 'off'
  return (
    <section className="wpanel-section">
      <h3><GitPullRequest aria-hidden />Пулл-реквест</h3>
      {!supported ? (
        <p className="muted">Статус PR недоступен в этой версии сервера.</p>
      ) : off ? (
        <div className="pr-off">
          <span className="muted">PR-интеграция не настроена.</span>
          <button type="button" className="btn btn-sm" onClick={openPrSettings}>Настроить</button>
        </div>
      ) : pr === undefined ? (
        <Skeleton rows={1} label="Проверяем PR…" />
      ) : pr && typeof pr === 'object' && 'error' in pr ? (
        <p className="field-error">Не удалось узнать статус PR: {pr.error}</p>
      ) : pr ? (
        <PrCard pr={pr} />
      ) : branch && base && branch !== base ? (
        <div className="pr-off">
          <span className="muted">Для <span className="mono">{branch}</span> PR ещё нет.</span>
          <button type="button" className="btn btn-sm" onClick={() => openDialog({ kind: 'pr', cwd, base })}><GitPullRequest />Создать PR</button>
        </div>
      ) : (
        <p className="muted">Ветка <span className="mono">{branch ?? '—'}</span> совпадает с базовой: PR создаётся из ветки задачи.</p>
      )}
    </section>
  )
}

/**
 * A folder without git (the projects folder): the work happens in worktrees its chats made — the task's worktrees and
 * the ones created by its agents — each with its changes; a click shows that worktree's changes.
 */
function LinkedWorktrees({ cwd, error }: { cwd: string; error: string }) {
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const workspaces = useStore((s) => s.workspaces)
  const lists = useStore((s) => s.worktrees)
  const here = sessions.filter((x) => normPath(x.cwd) === normPath(cwd))
  const ids = new Set(here.map((x) => x.id))
  const rows = new Map<string, { path: string; branch: string | null; repo?: string; dirty?: number | null }>()
  for (const t of tasks.filter((t) => here.some((x) => x.taskId === t.id))) {
    for (const w of t.worktrees ?? []) rows.set(normPath(w.path), { path: w.path, branch: w.branch, repo: workspaces.find((x) => x.id === w.workspaceId)?.name, dirty: w.dirty })
  }
  for (const [wsId, list] of Object.entries(lists)) {
    for (const w of list) {
      if (w.meta?.createdBy !== 'agent' || !ids.has(w.meta.createdBySession ?? '')) continue
      rows.set(normPath(w.path), { path: w.path, branch: w.branch, repo: workspaces.find((x) => x.id === wsId)?.name, dirty: w.dirty })
    }
  }
  const list = [...rows.values()]
  if (!list.length) {
    return (
      <div className="empty">
        <p>Здесь нет git-репозитория: изменения появятся в рабочих деревьях, которые создадут агенты этого чата.</p>
        <p className="mono" style={{ fontSize: 11 }}>{error}</p>
      </div>
    )
  }
  return (
    <div className="wpanel-section">
      <h3>Рабочие деревья этой работы</h3>
      <ul className="linked-wts">
        {list.map((w) => (
          <li key={w.path}>
            <button type="button" className="linked-wt" data-tip={w.path} onClick={() => { openWorktree(w.path); showPanel('changes') }}>
              <span className="ellipsis"><strong>{w.repo ?? basename(w.path)}</strong>{w.branch && <span className="mono muted"> {w.branch}</span>}</span>
              {(w.dirty ?? 0) > 0
                ? <span className="num" data-tip={`${w.dirty} ${plural(w.dirty!, 'изменённый файл', 'изменённых файла', 'изменённых файлов')}`}>±{w.dirty}</span>
                : <span className="muted">без изменений</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
