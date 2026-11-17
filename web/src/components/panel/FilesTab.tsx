import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronRight, File, Folder, FolderOpen, Search } from 'lucide-react'
import { api, errorText, qs } from '../../api'
import { openTab } from '../../store'
import { gsLetter } from '../../lib/git'
import type { FsEntry, GitStatus } from '../../types'

type Dir = FsEntry[] | 'loading' | { error: string }

const slash = (p: string) => p.replace(/\\/g, '/')

export function FilesTab({ cwd, status }: { cwd: string; status: GitStatus | null }) {
  const [dirs, setDirs] = useState<Record<string, Dir>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [filter, setFilter] = useState('')

  const load = (path: string) => {
    setDirs((d) => ({ ...d, [path]: 'loading' }))
    api<FsEntry[]>('GET', `/fs/list${qs({ cwd, path })}`).then(
      (list) => setDirs((d) => ({ ...d, [path]: list })),
      (e) => setDirs((d) => ({ ...d, [path]: { error: errorText(e) } })),
    )
  }

  // The component is keyed by cwd, so this runs once per folder.
  useEffect(() => { load('') }, [])

  const changes = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of status?.files ?? []) {
      const p = slash(f.path)
      map.set(p, f.status)
      // Mark every parent folder so collapsed dirs still show that something inside changed.
      for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) if (!map.has(p.slice(0, i))) map.set(p.slice(0, i), 'dir')
    }
    return map
  }, [status])

  const toggle = (e: FsEntry) => {
    const next = new Set(open)
    if (next.has(e.path)) next.delete(e.path)
    else {
      next.add(e.path)
      if (!Array.isArray(dirs[e.path])) load(e.path)
    }
    setOpen(next)
  }

  const needle = filter.trim().toLowerCase()
  const matches = needle
    ? Object.values(dirs).flatMap((d) => (Array.isArray(d) ? d : [])).filter((e) => !e.dir && e.name.toLowerCase().includes(needle))
    : []

  const row = (e: FsEntry, depth: number) => {
    const st = changes.get(slash(e.path))
    const style = { '--depth': depth } as CSSProperties
    if (e.dir) {
      const isOpen = open.has(e.path)
      return (
        <button type="button" key={e.path} className="file-row" style={style} aria-expanded={isOpen} onClick={() => toggle(e)} data-git={st ? 'dir' : undefined}>
          <ChevronRight className="chev" aria-hidden />
          {isOpen ? <FolderOpen aria-hidden /> : <Folder aria-hidden />}
          <span className="ellipsis grow">{e.name}</span>
          {st && <span className="gs-dot" aria-label="есть изменения" />}
        </button>
      )
    }
    return (
      <button type="button" key={e.path} className="file-row" style={style} data-git={st} data-tip={e.path} onClick={() => openTab({ kind: 'file', cwd, path: e.path })}>
        <span className="chev" aria-hidden />
        <File aria-hidden />
        <span className="ellipsis grow">{e.name}</span>
        {st && <span className="gs" data-s={st}>{gsLetter(st)}</span>}
      </button>
    )
  }

  const tree = (path: string, depth: number): ReactNode => {
    const d = dirs[path]
    if (d === undefined || d === 'loading') return <div className="tree-note" style={{ '--depth': depth } as CSSProperties}>Загрузка…</div>
    if (!Array.isArray(d)) return <div className="tree-note" style={{ '--depth': depth, color: 'var(--lamp-fail)' } as CSSProperties}>{d.error}</div>
    if (!d.length) return <div className="tree-note" style={{ '--depth': depth } as CSSProperties}>Пусто</div>
    return d.map((e) => (
      <div key={e.path}>
        {row(e, depth)}
        {e.dir && open.has(e.path) && tree(e.path, depth + 1)}
      </div>
    ))
  }

  return (
    <div className="files-tab">
      <div className="search files-search">
        <Search aria-hidden />
        <input className="input" type="search" placeholder="Найти файлы" aria-label="Найти среди открытых папок" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="files-list">
        {needle ? (
          <>
            {matches.map((e) => row(e, 0))}
            <div className="tree-note" style={{ '--depth': -1 } as CSSProperties}>
              {matches.length ? 'Поиск по уже раскрытым папкам' : 'Не найдено среди раскрытых папок'}
            </div>
          </>
        ) : tree('', 0)}
      </div>
    </div>
  )
}
