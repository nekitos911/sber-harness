import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Clock, CornerLeftUp, Folder, FolderOpen, HardDrive } from 'lucide-react'
import { api, errorText, qs } from '../api'
import { useFeature, useStore } from '../store'
import { basename, folderCrumbs } from '../lib/format'
import { Modal } from './ui/Dialog'

interface Dirs { path: string; parent: string | null; entries: { name: string; path: string }[]; roots: string[] }

/**
 * Pick a folder on the server's machine: roots (drives, / and ~), breadcrumbs, the folders here with a filter and
 * arrow keys, recent folders, and a path field for pasting. Needs the server's `folders` API.
 */
type PickerProps = { title?: string; initial?: string | null; submitLabel?: string; onPick: (path: string) => void; onClose: () => void }

/**
 * Choosing a folder: the system's own window (Windows Explorer's «Выбор папки», opened by the harness on this machine);
 * where there is none (an older server, no such window) — the harness's own folder browser below.
 */
export function FolderPicker(props: PickerProps) {
  const native = useFeature('pick-folder')
  const [own, setOwn] = useState(!native)
  const done = useRef(false) // «Отмена» / «Выбрать здесь» while the window is open: its late answer is ignored
  const request = useRef<Promise<{ path: string | null }> | null>(null)
  useEffect(() => {
    if (own) return
    let mounted = true
    request.current ??= api<{ path: string | null }>('POST', '/fs/pick-folder', { title: props.title ?? 'Выбор папки', initial: props.initial || undefined })
    request.current.then((r) => {
      if (!mounted || done.current) return
      done.current = true
      if (r?.path) props.onPick(r.path)
      else props.onClose()
    }).catch(() => { if (mounted && !done.current) setOwn(true) })
    return () => { mounted = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (own) return <FolderBrowser {...props} />
  return (
    <div className="pick-wait" role="status">
      <FolderOpen aria-hidden />
      <span>Выберите папку в открывшемся окне</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { done.current = true; setOwn(true) }}>Выбрать здесь</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { done.current = true; props.onClose() }}>Отмена</button>
    </div>
  )
}

function FolderBrowser({ title = 'Выбор папки', initial, submitLabel = 'Выбрать эту папку', onPick, onClose }: PickerProps) {
  const recent = useStore((s) => s.recentFolders)
  const [at, setAt] = useState(initial ?? '')
  const [dirs, setDirs] = useState<Dirs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState(initial ?? '')
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    api<Dirs>('GET', `/fs/dirs${qs({ path: at || undefined })}`).then((d) => {
      if (!live) return
      setDirs(d)
      setTyped(d.path)
      setFilter('')
      setActive(0)
      setError(null)
    }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [at])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (dirs?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q))
  }, [dirs, filter])

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      list.current?.querySelectorAll<HTMLButtonElement>('.fp-item')[next]?.focus()
    } else if (e.key === 'Backspace' && dirs?.parent) {
      e.preventDefault()
      setAt(dirs.parent)
    }
  }

  // A portal: the picker is often opened from another dialog and must not nest its <form> inside that one.
  return createPortal(
    <Modal title={title} submitLabel={submitLabel} wide disabled={!dirs} onClose={onClose} onSubmit={() => dirs && onPick(dirs.path)}>
      <div className="fp-path">
        <input className="input mono" aria-label="Путь к папке" placeholder="Вставьте путь и нажмите Enter" value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (typed.trim()) setAt(typed.trim()) } }} />
      </div>
      {dirs && (
        <div className="fp-roots" role="group" aria-label="Диски и корни">
          {dirs.roots.map((r) => <button key={r} type="button" className="chip" aria-pressed={dirs.path.toLowerCase().startsWith(r.toLowerCase())} onClick={() => setAt(r)}><HardDrive aria-hidden />{r}</button>)}
        </div>
      )}
      {dirs && (
        <nav className="fp-crumbs" aria-label="Путь">
          {folderCrumbs(dirs.path).map((c, i, all) => (
            <span key={c.path} className="fp-crumb">
              <button type="button" className="link" aria-current={i === all.length - 1 ? 'location' : undefined} onClick={() => setAt(c.path)}>{c.name}</button>
              {i < all.length - 1 && <ChevronRight aria-hidden />}
            </span>
          ))}
        </nav>
      )}
      {error && <p className="field-error">{error}</p>}
      <div className="fp-body">
        <div className="fp-main">
          <input className="input" type="search" aria-label="Фильтр папок" placeholder="Фильтр" value={filter}
            onChange={(e) => { setFilter(e.target.value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>('.fp-item')?.focus() }
              if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (shown[0]) setAt(shown[0].path) }
            }} />
          <div className="fp-list" ref={list} role="listbox" aria-label="Папки" onKeyDown={onListKey}>
            {dirs?.parent && (
              <button type="button" className="fp-item fp-up" onClick={() => setAt(dirs.parent!)}><CornerLeftUp aria-hidden />..</button>
            )}
            {shown.map((e, i) => (
              <button key={e.path} type="button" role="option" aria-selected={i === active} className="fp-item" tabIndex={i === active ? 0 : -1}
                onFocus={() => setActive(i)}
                onClick={() => setAt(e.path)}
                onKeyDown={(k) => { if (k.key === 'Enter') { k.preventDefault(); k.stopPropagation(); setAt(e.path) } }}>
                <Folder aria-hidden />
                <span className="ellipsis">{e.name}</span>
              </button>
            ))}
            {dirs && !shown.length && <p className="muted fp-empty">{filter ? 'Нет папок по фильтру' : 'Вложенных папок нет'}</p>}
          </div>
        </div>
        {recent.length > 0 && (
          <div className="fp-recent">
            <h3><Clock aria-hidden />Недавние</h3>
            {recent.map((r) => (
              <button key={r} type="button" className="fp-item" data-tip={r} onClick={() => setAt(r)}>
                <Folder aria-hidden />
                <span className="ellipsis">{basename(r)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>,
    document.body,
  )
}
