import { useEffect, useMemo, useState } from 'react'
import { FileText, RefreshCw } from 'lucide-react'
import { api, errorText, qs } from '../api'
import { openTab, useStore, wtKey } from '../store'
import { PR_STATE } from '../lib/pr'
import { parseDiff, type DiffFile } from '../lib/diff'
import { plural } from '../lib/format'
import { Skeleton } from '../components/bits'
import { DiffLines } from '../components/DiffLines'
import { Disclosure } from '../components/ui'
import { splitPath, useGit } from '../lib/git'

const FILE_LINES = 1500 // render cap per file until the user asks for the rest
const OPEN_FILES = 25 // further files start collapsed

const STATUS: Record<DiffFile['status'], string> = { modified: 'изменён', added: 'новый', deleted: 'удалён', renamed: 'переименован', binary: 'двоичный' }

/** The working tree's changes, or with `rev` one commit's (opened from the commits list). */
export function DiffView({ cwd, path, rev }: { cwd: string; path: string | null; rev?: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const pr = useStore((s) => s.prs[wtKey(cwd)])
  const git = useGit(cwd) // a fresh git read (a turn ended, a commit) re-reads this diff too

  useEffect(() => {
    let live = true
    setError(null)
    api<{ diff: string }>('GET', `/git/diff${qs({ cwd, path, rev })}`).then(
      (r) => { if (live) setDiff(r.diff) },
      (e) => { if (live) setError(errorText(e)) },
    )
    return () => { live = false }
  }, [cwd, path, rev, tick, rev ? null : git]) // a commit does not change with the working tree

  const files = useMemo(() => (diff === null ? [] : parseDiff(diff)), [diff])
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)

  return (
    <div className="diff-view">
      <div className="file-bar">
        <span className="mono ellipsis" data-tip={cwd}>{rev && <span className="muted">коммит {rev.slice(0, 7)} · </span>}{path ?? (rev ? 'все его изменения' : 'Все изменения')}</span>
        {diff !== null && (
          <span className="diff-stat num">
            {!path && `${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')} `}<span className="add">+{added}</span> <span className="del">−{removed}</span>
          </span>
        )}
        <span className="grow" />
        {path && (
          <button type="button" className="btn btn-sm" onClick={() => openTab({ kind: 'file', cwd, path })}>
            <FileText />
            Открыть файл
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Обновить diff" data-tip="Обновить" onClick={() => setTick(tick + 1)}>
          <RefreshCw />
        </button>
      </div>
      <div className="diff-scroll">
        {error ? (
          <div className="empty"><h2>Не удалось получить diff</h2><p className="mono">{error}</p></div>
        ) : diff === null ? (
          <Skeleton rows={8} label="Загрузка diff…" />
        ) : files.length === 0 ? (
          <div className="empty">
            <p>Изменений нет{git?.status?.ahead ? ': всё закоммичено' : ''}.</p>
            {/* after a PR the work is not gone — it is there */}
            {pr && typeof pr === 'object' && 'url' in pr && <p>Изменения отправлены в <a href={pr.url} target="_blank" rel="noreferrer noopener">PR #{pr.index}</a> · {PR_STATE[pr.state]}.</p>}
          </div>
        ) : (
          files.map((f, i) => <FileDiff key={`${f.path}:${i}`} cwd={cwd} f={f} open={i < OPEN_FILES} />)
        )}
      </div>
    </div>
  )
}

function FileDiff({ cwd, f, open }: { cwd: string; f: DiffFile; open: boolean }) {
  const { dir, name } = splitPath(f.path)
  return (
    <Disclosure
      className="diff-file"
      defaultOpen={open}
      summary={<>
        <span className="ellipsis" data-tip={f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path}>
          {f.status === 'renamed' && f.oldPath ? <span className="mono">{f.oldPath} → {f.path}</span> : <><strong>{name}</strong>{dir && <span className="muted"> {dir}</span>}</>}
        </span>
        {f.status !== 'modified' && <span className="chip">{STATUS[f.status]}</span>}
        <span className="grow" />
        <span className="diff-stat num"><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></span>
      </>}
    >
      {f.status === 'binary'
        ? <p className="muted diff-note">Двоичный файл, содержимое не показывается.</p>
        : <DiffLines lines={f.lines} limit={FILE_LINES} label={`Изменения ${f.path}`} comment={f.status === 'deleted' ? undefined : { cwd, path: f.path }} />}
    </Disclosure>
  )
}
