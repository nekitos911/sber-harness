import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, GitPullRequest, RotateCcw, Upload } from 'lucide-react'
import { api, qs, tryApi } from '../../api'
import { openDialog, openTab, openTask, toast, useStore } from '../../store'
import { relTime, shortHash } from '../../lib/format'
import { diffOf, gsLetter, refreshGit, splitPath, useGit } from '../../lib/git'
import { useNow } from '../../lib/useNow'
import type { GitCommit, GitFile, GitSuggest } from '../../types'
import type { DiffFile } from '../../lib/diff'
import { DiffLines } from '../DiffLines'
import { Skeleton } from '../bits'

const STATUS_LABEL: Record<GitFile['status'], string> = { M: 'изменён', A: 'добавлен', D: 'удалён', R: 'переименован', '?': 'новый, не в git', U: 'конфликт' }

export function ChangesTab({ cwd }: { cwd: string }) {
  const prEnabled = useStore((s) => s.integrations.pr)
  const git = useGit(cwd)
  const now = useNow()
  const [suggest, setSuggest] = useState<GitSuggest | null>(null)
  const [log, setLog] = useState<GitCommit[] | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const touched = useRef(false) // once the user edits, prefill never overwrites their text
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

  if (git?.error) {
    return <div className="empty"><p>Здесь нет git-репозитория или git недоступен.</p><p className="mono" style={{ fontSize: 11 }}>{git.error}</p></div>
  }
  if (!status) return <div className="wpanel-section"><Skeleton rows={4} /></div>

  const edit = (fn: (v: string) => void) => (v: string) => { touched.current = true; fn(v) }
  const reapply = () => {
    if (!suggest) return
    touched.current = false
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
    refreshGit(cwd)
  }

  const push = async () => {
    setBusy('push')
    const res = await tryApi<{ output: string }>('POST', '/git/push', { cwd })
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

  const files = status.files
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
          <input className="input" aria-label="Заголовок коммита" placeholder="Заголовок коммита" value={title} onChange={(e) => edit(setTitle)(e.target.value)} />
          <textarea className="textarea" aria-label="Описание коммита" placeholder="Описание (необязательно)" rows={4} value={body} onChange={(e) => edit(setBody)(e.target.value)} />
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={!title.trim() || !files.length || !!busy} onClick={commit}>
              {busy === 'commit' ? 'Коммит…' : `Закоммитить ${files.length ? files.length : ''}`.trim()}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={push} data-tip={status.upstream ? `в ${status.upstream}` : 'Опубликовать ветку'}>
              <Upload />
              {busy === 'push' ? 'Push…' : 'Push'}
            </button>
            {prEnabled && (
              <button type="button" className="btn" onClick={() => openDialog({ kind: 'pr', cwd })}>
                <GitPullRequest />
                Создать PR
              </button>
            )}
          </div>
        </div>
      </section>

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
