import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { api, qs } from '../../api'
import { useFeature } from '../../store'
import type { GitBranches } from '../../types'
import { ComboList, Popover, type ComboItem } from '../ui'

/** Select a ref without checking it out. Worktrees can start at HEAD, a remote ref, a tag or a commit. */
export function BranchRefPicker({ cwd, label, value, onChange, worktree = false, suggested = [] }: {
  cwd?: string; label: string; value: string; onChange: (ref: string) => void; worktree?: boolean; suggested?: string[]
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<GitBranches | null>(null)
  const [failed, setFailed] = useState(false)
  const supported = useFeature('branches')
  useEffect(() => {
    if (!open || !cwd || !supported) return
    let live = true
    setFailed(false)
    api<GitBranches>('GET', `/git/branches${qs({ cwd, allRemotes: worktree ? '1' : undefined })}`).then(
      (result) => { if (live) setData(result) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [open, cwd, supported, worktree])

  const pick = (ref: string) => {
    onChange(ref)
    setOpen(false)
    button.current?.focus()
  }
  const items: ComboItem[] = []
  if (open) {
    const seen = new Set<string>()
    const add = (ref: string, group: string, title = ref) => {
      if (seen.has(ref)) return
      seen.add(ref)
      items.push({ key: ref, text: title, group, node: <span className="option-label" data-mono>{title}</span>, onSelect: () => pick(ref) })
    }
    if (worktree) add('HEAD', '', data?.current ? `HEAD · ${data.current}` : 'HEAD · текущая версия')
    for (const ref of suggested) add(ref, 'Предложенные')
    for (const b of data?.branches ?? []) add(b.name, b.remote ? 'Удалённые' : 'Локальные')
  }
  return <>
    <button ref={button} type="button" className="select-trigger select-lg" disabled={!cwd} aria-label={label} aria-haspopup="listbox"
      aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="select-value">{worktree && (!value || value === 'HEAD') ? 'Текущая версия (HEAD)' : value || 'Выбрать ветку'}</span><ChevronDown className="select-chev" aria-hidden />
    </button>
    <Popover anchor={button} open={open} onClose={() => setOpen(false)} matchWidth role="presentation">
      <ComboList label={label} placeholder={worktree ? 'Найти ветку, ввести тег или SHA…' : 'Найти ветку…'} items={items}
        notice={failed ? <div className="option-empty" role="status">Не удалось загрузить ветки. Можно ввести имя.</div> : undefined}
        empty={!data && supported && !failed ? 'Загружаем ветки…' : 'Нет подходящих веток'}
        extra={(q) => q && !items.some((i) => i.key === q)
          ? [{ key: `use:${q}`, text: q, node: <span className="option-label">Использовать «{q}»</span>, onSelect: () => pick(q) }] : []} />
    </Popover>
  </>
}
