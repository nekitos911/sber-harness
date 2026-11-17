import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileText, RefreshCw } from 'lucide-react'
import { api, errorText, qs } from '../api'
import { openTab } from '../store'
import { parseDiff, type DiffFile } from '../lib/diff'
import { Loading } from '../components/bits'

const FILE_LINES = 1500 // render cap per file until the user asks for the rest
const OPEN_FILES = 25 // further files start collapsed

const STATUS: Record<DiffFile['status'], string> = { modified: 'изменён', added: 'новый', deleted: 'удалён', renamed: 'переименован', binary: 'двоичный' }

export function DiffView({ cwd, path }: { cwd: string; path: string | null }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    setError(null)
    api<{ diff: string }>('GET', `/git/diff${qs({ cwd, path })}`).then(
      (r) => { if (live) setDiff(r.diff) },
      (e) => { if (live) setError(errorText(e)) },
    )
    return () => { live = false }
  }, [cwd, path, tick])

  const files = useMemo(() => (diff === null ? [] : parseDiff(diff)), [diff])
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)

  return (
    <div className="diff-view">
      <div className="file-bar">
        <span className="mono ellipsis" title={cwd}>{path ?? 'Все изменения'}</span>
        {diff !== null && (
          <span className="diff-stat num">
            {files.length} файл. · <span className="add">+{added}</span> <span className="del">−{removed}</span>
          </span>
        )}
        <span className="grow" />
        {path && (
          <button type="button" className="btn btn-sm" onClick={() => openTab({ kind: 'file', cwd, path })}>
            <FileText />
            Открыть файл
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Обновить diff" title="Обновить" onClick={() => setTick(tick + 1)}>
          <RefreshCw />
        </button>
      </div>
      <div className="diff-scroll">
        {error ? (
          <div className="empty"><h2>Не удалось получить diff</h2><p className="mono">{error}</p></div>
        ) : diff === null ? (
          <Loading />
        ) : files.length === 0 ? (
          <div className="empty"><p>Изменений нет.</p></div>
        ) : (
          files.map((f, i) => <FileDiff key={`${f.path}:${i}`} f={f} open={i < OPEN_FILES} />)
        )}
      </div>
    </div>
  )
}

function FileDiff({ f, open }: { f: DiffFile; open: boolean }) {
  const [all, setAll] = useState(false)
  const lines = all ? f.lines : f.lines.slice(0, FILE_LINES)
  return (
    <details className="diff-file" open={open}>
      <summary className="diff-file-head">
        <ChevronRight className="chev" aria-hidden />
        <span className="mono ellipsis" title={f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path}>
          {f.status === 'renamed' && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        </span>
        {f.status !== 'modified' && <span className="chip">{STATUS[f.status]}</span>}
        <span className="grow" />
        <span className="diff-stat num"><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></span>
      </summary>
      {f.status === 'binary' ? (
        <p className="muted diff-note">Двоичный файл — содержимое не показывается.</p>
      ) : (
        <div className="diff-table" role="table" aria-label={`Изменения ${f.path}`}>
          {lines.map((l, i) => (
            <div key={i} className="dr" data-k={l.kind} role="row">
              <span className="dn" role="cell">{l.old ?? ''}</span>
              <span className="dn" role="cell">{l.new ?? ''}</span>
              <span className="dc" role="cell">
                <span className="dl-sign" aria-hidden>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                {l.text || ' '}
              </span>
            </div>
          ))}
          {!all && f.lines.length > FILE_LINES && (
            <button type="button" className="btn btn-ghost btn-sm diff-more" onClick={() => setAll(true)}>
              Показать остальные {f.lines.length - FILE_LINES} строк
            </button>
          )}
        </div>
      )}
    </details>
  )
}
