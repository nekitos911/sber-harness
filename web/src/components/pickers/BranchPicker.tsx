import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Check, Copy, GitBranch, GitBranchPlus } from 'lucide-react'
import { api, ApiError, errorText, qs } from '../../api'
import { toast } from '../../store'
import { refreshGit } from '../../lib/git'
import { relTime } from '../../lib/format'
import { workspaceFor } from '../../lib/actions'
import { loadWorktrees } from '../../ws'
import type { GitBranches } from '../../types'
import { ComboList, Popover, type ComboItem, type Placement } from '../ui'
import { Skeleton } from '../bits'

type Load = GitBranches | 'loading' | { error: string }

/** Turn a checkout refusal into a sentence: what blocked it and what to do. */
function explain(e: unknown) {
  if (e instanceof ApiError && e.status === 404) return 'Этот сервер ещё не умеет переключать ветки.'
  const msg = errorText(e)
  if (e instanceof ApiError && e.status === 409) {
    if (/run/i.test(msg)) return 'В этом дереве сейчас работает агент. Дождитесь конца хода или остановите его.'
    if (/worktree/i.test(msg)) return 'Эта ветка открыта в другом рабочем дереве.'
  }
  if (e instanceof ApiError && e.status === 400) return `Git не дал переключиться: ${msg}`
  return msg
}

/**
 * Orca-style branch switcher: search; current branch first (✓, copy name); local, then remote-only
 * (origin); branches open in another worktree are disabled; «Создать ветку …» when the name is new.
 */
export function BranchPicker({ cwd, branch, placement = 'top-start', children, className = 'branch-btn', label = 'Сменить ветку' }: {
  cwd: string
  branch: string | null | undefined
  placement?: Placement
  children: ReactNode
  className?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Load>('loading')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setErr(null)
    setData('loading')
    api<GitBranches>('GET', `/git/branches${qs({ cwd })}`).then(
      (r) => { if (live) setData(r) },
      (e) => { if (live) setData({ error: explain(e) }) },
    )
    return () => { live = false }
  }, [open, cwd])

  const checkout = async (name: string, create = false) => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const from = typeof data === 'object' && 'branches' in data ? data.current ?? undefined : undefined
      await api('POST', '/git/checkout', create ? { cwd, branch: name, create: true, from } : { cwd, branch: name })
      setOpen(false)
      toast(create ? `Создана ветка ${name}` : `Ветка: ${name}`, 'ok')
      refreshGit(cwd)
      const ws = workspaceFor(cwd)
      if (ws) void loadWorktrees(ws)
    } catch (e) {
      setErr(explain(e))
    } finally {
      setBusy(false)
    }
  }

  const items = useMemo<ComboItem[]>(() => {
    if (typeof data !== 'object' || !('branches' in data)) return []
    const list = [...data.branches].sort((a, b) =>
      Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || b.lastCommitAt - a.lastCommitAt)
    return list.map((b) => {
      const elsewhere = !b.current && !!b.worktree
      const copy = (e: MouseEvent) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(b.name).then(() => toast('Имя ветки скопировано', 'ok'), () => undefined)
      }
      return {
        key: `${b.remote ? 'r' : 'l'}:${b.name}`,
        text: b.name,
        group: b.current ? 'Текущая' : b.remote ? 'Только на сервере' : 'Локальные',
        disabled: elsewhere,
        onSelect: () => (b.current ? setOpen(false) : void checkout(b.name)),
        node: (
          <>
            <GitBranch aria-hidden />
            <span className="option-main">
              <span className="option-label" data-mono>{b.name}</span>
              <span className="option-hint">
                {elsewhere ? 'открыта в другом дереве' : b.lastCommitAt ? relTime(b.lastCommitAt) : ''}
              </span>
            </span>
            {b.remote && <span className="tag-muted">origin</span>}
            {b.current && (
              <>
                <button type="button" className="icon-btn icon-btn-sm option-action" aria-label={`Скопировать имя ${b.name}`} data-tip="Скопировать имя" onClick={copy}><Copy /></button>
                <Check className="option-check" aria-hidden />
              </>
            )}
          </>
        ),
      }
    })
  }, [data])

  const extra = (q: string, matched: ComboItem[]): ComboItem[] => {
    const name = q.trim().replace(/\s+/g, '-')
    if (!name || matched.some((m) => m.text === name) || typeof data !== 'object' || !('branches' in data)) return []
    return [{
      key: `new:${name}`,
      text: name,
      onSelect: () => void checkout(name, true),
      node: (
        <>
          <GitBranchPlus aria-hidden />
          <span className="option-main">
            <span className="option-label">Создать ветку <span className="mono">{name}</span></span>
            <span className="option-hint">из {data.current ?? 'HEAD'}</span>
          </span>
        </>
      ),
    }]
  }

  return (
    <>
      <button ref={btn} type="button" className={className} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${branch ?? 'нет ветки'}`} data-tip={open ? undefined : label} onClick={() => setOpen(!open)}>
        {children}
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement={placement} className="picker" role="presentation">
        {data === 'loading' ? (
          <div className="picker-loading"><Skeleton rows={5} label="Загрузка веток…" /></div>
        ) : 'error' in data ? (
          <p className="combo-notice">{data.error}</p>
        ) : (
          <ComboList
            items={items}
            extra={extra}
            placeholder="Найти или создать ветку…"
            label="Ветки"
            notice={(err || busy) && <p className={err ? 'combo-notice' : 'combo-progress'} role={err ? 'alert' : 'status'}>{err ?? 'Переключаем…'}</p>}
          />
        )}
      </Popover>
    </>
  )
}
