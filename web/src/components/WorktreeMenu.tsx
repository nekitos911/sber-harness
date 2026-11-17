import { useMemo, useState, type KeyboardEvent } from 'react'
import { ClipboardCopy, FolderOpen, Info, ListChecks, Moon, Pin, PinOff, SquareTerminal, Sun, Trash2, Mail, Code } from 'lucide-react'
import { api, ApiError, errorText, tryApi } from '../api'
import { closeDialog, getState, openDialog, setState, toast, upsert, useStore } from '../store'
import { basename, COLUMNS, normPath, relTime } from '../lib/format'
import { newTerminal } from '../lib/actions'
import { modKey, shortcut } from '../lib/keys'
import { loadWorktrees } from '../ws'
import type { Task, TaskStatus, Workspace, Worktree } from '../types'
import { Checkbox, Dialog, Input, Segmented, Textarea, type MenuItem } from './ui'

type BranchMode = 'no' | 'safe' | 'force'
const BRANCH_OPTIONS = [
  { value: 'no' as const, label: 'Не удалять ветку' },
  { value: 'safe' as const, label: 'Удалить, если слита', hint: 'git branch -d' },
  { value: 'force' as const, label: 'Удалить принудительно', hint: 'git branch -D' },
]

// ---------- UI-local unread marks (localStorage) ----------

const UNREAD_KEY = 'harness.wt.unread'
function readUnread(): string[] {
  try { return JSON.parse(localStorage.getItem(UNREAD_KEY) ?? '[]') as string[] } catch { return [] }
}
export function setUnread(path: string, on: boolean) {
  const next = new Set(readUnread())
  if (on) next.add(normPath(path)); else next.delete(normPath(path))
  try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...next])) } catch { /* storage blocked: mark lives until reload */ }
  window.dispatchEvent(new Event('harness:unread'))
}
export const isUnread = (path: string) => readUnread().includes(normPath(path))

// ---------- actions ----------

export function openFolder(cwd: string) {
  void tryApi('POST', '/open', { cwd, target: 'explorer' })
}

async function patchMeta(workspaceId: string, path: string, meta: Partial<NonNullable<Worktree['meta']>>) {
  const res = await tryApi('PATCH', '/worktrees/meta', { path, ...meta })
  if (res !== undefined) void loadWorktrees(workspaceId)
}

const copy = (text: string, what: string) => {
  void navigator.clipboard.writeText(text).then(() => toast(`Скопировано: ${what}`, 'ok'), () => toast('Буфер обмена недоступен', 'error'))
}

/** Items of the worktree context menu (right click or «…» on a worktree card). */
export function worktreeMenu(ws: Workspace, wt: Worktree, task: Task | undefined, ide: boolean): MenuItem[] {
  const meta = wt.meta ?? {}
  const name = wt.branch ?? basename(wt.path)
  const items: MenuItem[] = [
    { label: 'Открыть папку', icon: <FolderOpen />, onSelect: () => openFolder(wt.path) },
    meta.sleeping
      ? { label: 'Разбудить', icon: <Sun />, onSelect: () => void patchMeta(ws.id, wt.path, { sleeping: false }) }
      : { label: 'Перевести в сон', icon: <Moon />, onSelect: () => void patchMeta(ws.id, wt.path, { sleeping: true }) },
    { label: 'Отметить непрочитанным', icon: <Mail />, onSelect: () => setUnread(wt.path, true) },
  ]
  if (!wt.main) items.push({ label: 'Удалить', icon: <Trash2 />, danger: true, hint: shortcut('⌫', true), onSelect: () => openDialog({ kind: 'wt-delete', workspaceId: ws.id, path: wt.path }) })
  items.push(
    { label: 'Изменить сведения…', icon: <Info />, divider: true, onSelect: () => openDialog({ kind: 'wt-info', workspaceId: ws.id, path: wt.path }) },
    meta.pinned
      ? { label: 'Открепить', icon: <PinOff />, onSelect: () => void patchMeta(ws.id, wt.path, { pinned: false }) }
      : { label: 'Закрепить', icon: <Pin />, onSelect: () => void patchMeta(ws.id, wt.path, { pinned: true }) },
  )
  if (task) {
    items.push({
      label: 'Статус задачи', icon: <ListChecks />,
      children: COLUMNS.map((c) => ({ label: c.id === task.status ? `${c.label} ✓` : c.label, onSelect: () => void moveTask(task, c.id) })),
    })
  }
  items.push(
    {
      label: 'Открыть в', icon: <FolderOpen />, divider: true,
      children: [
        { label: 'Файловом менеджере', onSelect: () => openFolder(wt.path) },
        { label: 'Новом терминале', icon: <SquareTerminal />, onSelect: () => void newTerminal({ cwd: wt.path, workspaceId: ws.id }) },
        ...(ide ? [{ label: 'IDE', icon: <Code />, onSelect: () => void tryApi('POST', '/open', { cwd: wt.path, target: 'ide' }) }] : []),
      ],
    },
    {
      label: 'Копировать', icon: <ClipboardCopy />,
      children: [
        { label: 'Путь', onSelect: () => copy(wt.path, 'путь') },
        ...(wt.branch ? [{ label: 'Ветку', onSelect: () => copy(wt.branch!, 'ветка') }] : []),
        { label: 'Имя', onSelect: () => copy(meta.label || name, 'имя') },
      ],
    },
  )
  return items
}

async function moveTask(task: Task, status: TaskStatus) {
  const t = await tryApi<Task>('POST', `/tasks/${encodeURIComponent(task.id)}/move`, { status, beforeId: null })
  if (t) setState((s) => ({ tasks: upsert(s.tasks, t) }))
}

/** Items of the project row menu. */
export function projectMenu(ws: Workspace): MenuItem[] {
  return [
    { label: 'Открыть папку', icon: <FolderOpen />, onSelect: () => openFolder(ws.path) },
    { label: 'Новое рабочее дерево…', icon: <ListChecks />, onSelect: () => openDialog({ kind: 'worktree', workspaceId: ws.id }) },
    { label: 'Очистить рабочие деревья…', icon: <Trash2 />, onSelect: () => openDialog({ kind: 'wt-cleanup', workspaceId: ws.id }) },
  ]
}

// ---------- dialogs ----------

function useWorktree(workspaceId: string, path: string) {
  return useStore((s) => s.worktrees[workspaceId]?.find((w) => normPath(w.path) === normPath(path)))
}

interface Refusal { dirty?: number; ahead?: number; running?: number }

/** What is at stake in a worktree, from the enriched list or a 409 answer. */
function Stakes({ wt, refusal }: { wt: Worktree | undefined; refusal: Refusal | null }) {
  const dirty = refusal?.dirty ?? wt?.dirty ?? 0
  const ahead = refusal?.ahead ?? wt?.ahead ?? 0
  const running = refusal?.running ?? wt?.running ?? 0
  const sessions = wt?.sessions ?? 0
  const lines = [
    dirty > 0 && `${dirty} незакоммиченных файлов будут потеряны`,
    ahead > 0 && `${ahead} коммитов ещё не в базовой ветке`,
    running > 0 && `${running} агентов работает прямо сейчас: их ход будет остановлен`,
    sessions > 0 && `${sessions} сессий уйдут в архив (история сохранится)`,
  ].filter(Boolean) as string[]
  if (!lines.length) return <p className="muted">Незакоммиченных изменений и работающих агентов нет.</p>
  return <ul className="stakes">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
}

export function DeleteWorktreeDialog({ workspaceId, path }: { workspaceId: string; path: string }) {
  const wt = useWorktree(workspaceId, path)
  const [branch, setBranch] = useState<BranchMode>('no')
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const risky = !!(refusal || (wt && ((wt.dirty ?? 0) > 0 || (wt.ahead ?? 0) > 0 || (wt.running ?? 0) > 0)))

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ branchDeleted?: boolean; archivedSessions?: number }>('DELETE', `/workspaces/${encodeURIComponent(workspaceId)}/worktrees`, { path, deleteBranch: branch, force: refusal ? sure : undefined })
      toast(`Рабочее дерево удалено${r?.branchDeleted ? ', ветка тоже' : ''}`, 'ok')
      void loadWorktrees(workspaceId)
      closeDialog()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const data = e.data && typeof e.data === 'object' ? (e.data as Refusal) : null
        setRefusal(data ?? { dirty: wt?.dirty, ahead: wt?.ahead, running: wt?.running })
        setError('Сервер отказал: в дереве есть несохранённая работа. Отметьте подтверждение, чтобы удалить всё равно.')
      } else setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={`Удалить рабочее дерево ${wt?.branch ?? basename(path)}?`} submitLabel={busy ? 'Удаляем…' : 'Удалить рабочее дерево'} danger
      busy={busy} disabled={!!refusal && !sure} onClose={closeDialog} onSubmit={() => void submit()}>
      <p className="mono muted wt-path">{path}</p>
      <Stakes wt={wt} refusal={refusal} />
      <div className="field">
        <span>Ветка {wt?.branch && <span className="mono">{wt.branch}</span>}</span>
        <Segmented label="Что сделать с веткой" value={branch} onChange={setBranch} options={BRANCH_OPTIONS} />
      </div>
      {refusal && <Checkbox checked={sure} onChange={setSure}>Я понимаю, изменения будут потеряны</Checkbox>}
      {risky && !refusal && <p className="field-hint">Если сервер найдёт несохранённую работу, он попросит подтверждение.</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </Dialog>
  )
}

export function WorktreeInfoDialog({ workspaceId, path }: { workspaceId: string; path: string }) {
  const wt = useWorktree(workspaceId, path)
  const [label, setLabel] = useState(wt?.meta?.label ?? '')
  const [note, setNote] = useState(wt?.meta?.note ?? '')
  return (
    <Dialog title="Сведения о рабочем дереве" submitLabel="Сохранить" onClose={closeDialog}
      onSubmit={() => { void patchMeta(workspaceId, path, { label: label.trim(), note: note.trim() }); closeDialog() }}>
      <p className="mono muted wt-path">{path}</p>
      <label className="field"><span>Название</span><Input autoFocus value={label} placeholder={wt?.branch ?? basename(path)} onChange={(e) => setLabel(e.target.value)} /></label>
      <label className="field"><span>Заметка</span><Textarea rows={3} value={note} placeholder="Зачем это дерево, что в нём проверяется" onChange={(e) => setNote(e.target.value)} /></label>
    </Dialog>
  )
}

/** A worktree is safe to clean when its task is done or its PR merged, nothing is uncommitted and nothing runs. */
const cleanable = (w: Worktree) => (w.taskStatus === 'done' || w.pr?.state === 'merged') && (w.dirty ?? 0) === 0 && (w.running ?? 0) === 0

export function CleanupDialog({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const list = useStore((s) => s.worktrees[workspaceId])
  const tasks = useStore((s) => s.tasks)
  const rows = useMemo(() => (list ?? []).filter((w) => !w.main), [list])
  const [picked, setPicked] = useState<Set<string>>(() => new Set(rows.filter(cleanable).map((w) => w.path)))
  const [branch, setBranch] = useState<BranchMode>('safe')
  const [results, setResults] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const now = Date.now()

  const toggle = (p: string, on: boolean) => { const n = new Set(picked); if (on) n.add(p); else n.delete(p); setPicked(n) }
  const run = async () => {
    setBusy(true)
    const out: Record<string, string> = {}
    for (const p of picked) {
      try {
        await api('DELETE', `/workspaces/${encodeURIComponent(workspaceId)}/worktrees`, { path: p, deleteBranch: branch })
        out[p] = 'удалено'
      } catch (e) {
        out[p] = e instanceof ApiError && e.status === 409 ? 'пропущено: есть несохранённая работа' : errorText(e)
      }
      setResults({ ...out })
    }
    setBusy(false)
    setPicked(new Set())
    void loadWorktrees(workspaceId)
  }

  return (
    <Dialog title={`Очистить рабочие деревья ${ws?.name ?? ''}`} submitLabel={busy ? 'Удаляем…' : `Удалить выбранные (${picked.size})`} danger wide
      busy={busy} disabled={!picked.size} onClose={closeDialog} onSubmit={() => void run()}>
      <p className="field-hint">Отмечены деревья, чья задача готова или PR влит, без незакоммиченных изменений и работающих агентов.</p>
      {!rows.length ? <p className="muted">Кроме основной копии деревьев нет.</p> : (
        <div className="cleanup" role="table" aria-label="Рабочие деревья">
          {rows.map((w) => {
            const task = tasks.find((t) => t.id === w.taskId)
            const res = results[w.path]
            return (
              <div key={w.path} className="cleanup-row" role="row" data-done={res === 'удалено' || undefined}>
                <Checkbox checked={picked.has(w.path)} disabled={!!res} onChange={(v) => toggle(w.path, v)}>
                  <span className="mono">{w.meta?.label || w.branch || basename(w.path)}</span>
                </Checkbox>
                <span className="muted">{task ? `${task.externalId ?? task.id} · ${COLUMNS.find((c) => c.id === task.status)?.label ?? ''}` : '—'}</span>
                <span>{w.pr ? <span className="pr-state" data-state={w.pr.state}>PR {w.pr.state === 'merged' ? 'влит' : w.pr.state === 'open' ? 'открыт' : 'отклонён'}</span> : <span className="muted">нет PR</span>}</span>
                <span className="cleanup-badges">
                  {(w.dirty ?? 0) > 0 && <span className="chip chip-run">{w.dirty} изм.</span>}
                  {(w.ahead ?? 0) > 0 && <span className="chip">↑{w.ahead}</span>}
                  {(w.running ?? 0) > 0 && <span className="chip chip-run">работает</span>}
                </span>
                <span className="muted num">{w.lastActivityAt ? relTime(w.lastActivityAt, now) : ''}</span>
                {res && <span className={res === 'удалено' ? 'cleanup-ok' : 'field-error'}>{res}</span>}
              </div>
            )
          })}
        </div>
      )}
      <div className="field">
        <span>Ветки</span>
        <Segmented label="Что сделать с ветками" value={branch} onChange={setBranch} options={BRANCH_OPTIONS} />
      </div>
    </Dialog>
  )
}

/** Ctrl+Shift+Backspace (⇧⌘⌫ on macOS) on a focused worktree card asks to delete it. */
export function onWorktreeKey(e: KeyboardEvent, ws: Workspace, wt: Worktree) {
  if (modKey(e) && e.shiftKey && e.key === 'Backspace' && !wt.main && e.target === e.currentTarget) {
    e.preventDefault()
    openDialog({ kind: 'wt-delete', workspaceId: ws.id, path: wt.path })
  }
}

export const ideEnabled = () => !!(getState().settings as unknown as { ide?: unknown } | null)?.ide
