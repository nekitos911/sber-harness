import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, GitPullRequest, RotateCcw, Upload } from 'lucide-react'
import { api, qs, tryApi } from '../../api'
import { openDialog, openTab, openTask, toast, useStore } from '../../store'
import { relTime, shortHash } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import type { GitCommit, GitSuggest } from '../../types'
import type { GitState } from '../WorkspacePanel'

export function ChangesTab({ cwd, git }: { cwd: string; git: GitState }) {
  const prEnabled = useStore((s) => s.integrations.pr)
  const now = useNow()
  const { status, error, refresh } = git
  const [suggest, setSuggest] = useState<GitSuggest | null>(null)
  const [log, setLog] = useState<GitCommit[] | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const touched = useRef(false) // once the user edits, prefill never overwrites their text
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)

  const filesSig = status?.files.map((f) => f.status + f.path).join('|') ?? ''
  const loaded = !!status
  const branch = status?.branch

  useEffect(() => {
    if (!loaded) return
    let live = true
    api<GitSuggest>('GET', `/git/suggest${qs({ cwd })}`).then((s) => {
      if (!live) return
      setSuggest(s)
      if (!touched.current) { setTitle(s.commit.title); setBody(s.commit.body) }
    }, () => undefined)
    api<GitCommit[]>('GET', `/git/log${qs({ cwd, n: 12 })}`).then((l) => { if (live) setLog(l) }, () => undefined)
    return () => { live = false }
  }, [cwd, filesSig, branch, loaded])

  if (error) {
    return <div className="empty"><p>Здесь нет git-репозитория или git недоступен.</p><p className="mono" style={{ fontSize: 11 }}>{error}</p></div>
  }
  if (!status) return <div className="tree-note" style={{ padding: 12 }}>Загрузка…</div>

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
    refresh()
  }

  const push = async () => {
    setBusy('push')
    const res = await tryApi<{ output: string }>('POST', '/git/push', { cwd })
    setBusy(null)
    if (!res) return
    toast(res.output?.trim().split('\n').pop() || 'Отправлено', 'ok')
    refresh()
  }

  const files = status.files
  const taskKey = suggest?.taskId ? suggest.key ?? suggest.taskId : null

  return (
    <>
      <section className="wpanel-section">
        <h3>
          Изменения <span className="count">{files.length}</span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="muted num" title={status.upstream ?? ''} style={{ fontWeight: 400 }}>
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
          <p className="muted">Рабочая копия чистая.</p>
        ) : (
          <div>
            {files.map((f) => {
              const slash = f.path.replace(/\\/g, '/')
              const cut = slash.lastIndexOf('/')
              return (
                <button key={f.path} type="button" className="file-row" data-git={f.status} title={f.path} onClick={() => openTab({ kind: 'diff', cwd, path: f.path })}>
                  <span className="ellipsis">{slash.slice(cut + 1)}</span>
                  <span className="dir">{cut > 0 ? slash.slice(0, cut) : ''}</span>
                  <span className="gs" data-s={f.status}>{f.status}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="wpanel-section">
        <h3>
          Коммит
          {taskKey && suggest?.taskId && (
            <button type="button" className="chip chip-mono" title="Открыть задачу" onClick={() => openTask(suggest.taskId!)}>{taskKey}</button>
          )}
          {suggest && (title !== suggest.commit.title || body !== suggest.commit.body) && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={reapply} title="Подставить предложенные заголовок и описание">
              <RotateCcw />
              подставить заново
            </button>
          )}
        </h3>
        <div className="commit-box">
          <input className="input" aria-label="Заголовок коммита" placeholder="Заголовок коммита" value={title} onChange={(e) => edit(setTitle)(e.target.value)} />
          <textarea className="textarea" aria-label="Описание коммита" placeholder="Описание (необязательно)" rows={4} value={body} onChange={(e) => edit(setBody)(e.target.value)} />
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={!title.trim() || !files.length || !!busy} onClick={commit}>
              {busy === 'commit' ? 'Коммит…' : 'Закоммитить всё'}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={push} title={status.upstream ? `в ${status.upstream}` : 'Опубликовать ветку'}>
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
        {log === null ? <p className="muted">Загрузка…</p> : log.length === 0 ? <p className="muted">Коммитов пока нет.</p> : (
          <div>
            {log.map((c) => (
              <div key={c.hash} className="commit-row" title={c.subject}>
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
