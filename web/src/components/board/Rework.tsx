import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Play, Wrench } from 'lucide-react'
import { api, qs } from '../../api'
import { runJob } from '../../lib/jobs'
import { getState, openDialog, setState, toast, upsert, useStore } from '../../store'
import { taskKey } from '../../lib/tasks'
import { plural } from '../../lib/format'
import { adoptSession } from '../../lib/actions'
import { loadDraft, saveDraft } from '../../lib/draft'
import { isMac } from '../../lib/keys'
import { useSettings } from '../../lib/agents'
import type { Session, Task } from '../../types'
import { Button, Popover, Select } from '../ui'

export const DEFAULT_REWORK = '{key} {title}: нужны правки: {notes}' // the server's own default (agents.<id>.reworkPromptTemplate unset)

/** First line of what the agent will receive: «/full-task <url> Задача готова, но нужны правки: …». */
function reworkPreview(template: string, task: Task, notes: string) {
  const url = task.externalUrl ?? task.externalId ?? task.id
  return template.replaceAll('{taskUrl}', url).replaceAll('{key}', task.externalId ?? task.id).replaceAll('{title}', task.title)
    .replaceAll('{notes}', notes.trim().split('\n')[0] || '…').split('\n')[0]
}

let previewOff = false // the server has no /rework-preview: the template is filled here
/** The server's own rendering of the rework message (GET /tasks/:id/rework-preview), the local one meanwhile. */
function ReworkPreview({ task, notes, template }: { task: Task; notes: string; template: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (previewOff) return
    const t = window.setTimeout(() => {
      api<string | { text?: string; prompt?: string; preview?: string }>('GET', `/tasks/${encodeURIComponent(task.id)}/rework-preview${qs({ notes: notes.trim() })}`)
        .then((r) => setText(typeof r === 'string' ? r : r?.text ?? r?.prompt ?? r?.preview ?? null))
        .catch(() => { previewOff = true; setText(null) })
    }, 250)
    return () => window.clearTimeout(t)
  }, [task.id, notes])
  return <>{text?.split('\n')[0] || reworkPreview(template, task, notes)}</>
}

const sendKey = isMac ? '⌘↵' : 'Ctrl+Enter'

/** A text field popover with a draft that survives a reload; Ctrl/⌘+Enter runs the primary action. */
function NotesPopover({ anchor, open, onClose, label, draftKey, placeholder, required, preview, primary, extra, before }: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  label: string
  draftKey: string
  placeholder: string
  required?: boolean
  preview?: (notes: string) => ReactNode
  primary: { label: string; icon?: ReactNode; run: (notes: string) => Promise<boolean> }
  extra?: ReactNode
  /** Fields above the text (e.g. «Где»). */
  before?: ReactNode
}) {
  const [notes, setNotes] = useState(() => loadDraft<string>(draftKey) ?? '')
  const [busy, setBusy] = useState(false)
  const edit = (v: string) => { setNotes(v); saveDraft(draftKey, v || null) }
  const go = async () => {
    if (busy || (required && !notes.trim())) return
    setBusy(true)
    const ok = await primary.run(notes.trim())
    setBusy(false)
    if (ok) { saveDraft(draftKey, null); setNotes(''); onClose() }
  }
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-start" label={label} className="notes-pop">
      {before}
      <label className="field">
        <span>{label}</span>
        <textarea className="textarea" rows={3} autoFocus={!before} placeholder={placeholder} value={notes} onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void go() } }} />
      </label>
      {preview && <p className="notes-preview mono" data-tip="Первая строка сообщения агенту">{preview(notes)}</p>}
      <div className="notes-actions">
        <Button variant="primary" size="sm" icon={primary.icon} busy={busy} disabled={required && !notes.trim()} onClick={() => void go()} tip={sendKey}>{primary.label}</Button>
        {extra}
      </div>
    </Popover>
  )
}

/** «Что поправить»: sends the task back to its agent (POST /tasks/:id/rework). `onMoveOnly` adds «Просто перенести». */
export function ReworkPopover({ task, anchor, open, onClose, onSent, onMoveOnly }: {
  task: Task; anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; onSent?: () => void; onMoveOnly?: () => void
}) {
  const settings = useSettings()
  const agent = getState().sessions.find((s) => s.taskId === task.id && s.role !== 'reviewer')?.agent ?? getState().defaultAgent ?? ''
  const template = settings?.agents[agent]?.reworkPromptTemplate || settings?.agents[agent]?.reworkPromptPresets?.[0] || settings?.reworkPromptPresets?.[0] || DEFAULT_REWORK
  return (
    <NotesPopover
      anchor={anchor} open={open} onClose={onClose}
      label="Что поправить?" draftKey={`rework:${task.id}`} required
      placeholder="Например: кнопка «Сохранить» не блокируется во время запроса; тест на пустой список падает"
      preview={(n) => <ReworkPreview task={task} notes={n} template={template} />}
      primary={{
        label: 'Отправить агенту', icon: <Wrench />,
        run: async (notes) => {
          const res = await runJob('Доработка', (jobId) => api<{ task?: Task; session?: Session }>('POST', `/tasks/${encodeURIComponent(task.id)}/rework`, { notes }, { jobId }))
          if (res === undefined) return false
          if (res?.task) setState((s) => ({ tasks: upsert(s.tasks, res.task!) }))
          toast(`${task.externalId ?? task.id}: правки отправлены агенту`, 'ok')
          onSent?.()
          return true
        },
      }}
      extra={onMoveOnly && <Button size="sm" variant="ghost" onClick={() => { onMoveOnly(); onClose() }}>Просто перенести</Button>}
    />
  )
}

/** A suggestion strong enough to preselect (the server says high, or a score ≥ 0.8). */
export const confident = (c: unknown) => c === 'high' || (typeof c === 'number' && c >= 0.8)

/**
 * «Где» for taking a task into work: the projects folder («агент выберет репозиторий по SDD») or one repository.
 * A confident suggestion is preselected with its reason; a weak one only says «возможно» in the list.
 */
export function useWhere(task: Task) {
  const workspaces = useStore((s) => s.workspaces)
  const tasks = useStore((s) => s.tasks)
  const settings = useSettings()
  const rootWs = workspaces.find((w) => w.kind === 'root')
  const repos = workspaces.filter((w) => w.kind !== 'root' && w.kind !== 'folder' && w.isGit)
  const sug = task.suggestedWorkspace
  const sure = sug && confident(sug.confidence) && repos.some((w) => w.id === sug.id) ? sug.id : null
  const initial = task.workspaceId ?? sure ?? (rootWs ? 'root' : repos.length === 1 ? repos[0].id : '')
  const [where, setWhere] = useState(initial)
  const repo = repos.find((w) => w.id === where)
  const key = taskKey(task, new Map(tasks.map((t) => [t.id, t])))
  const base = task.targets[0] ?? settings?.git.defaultBase ?? 'develop'
  const branch = task.branch ?? (settings?.git.branchTemplate || 'feature/{key}').replaceAll('{key}', key)
  const summary = where === 'root'
    ? `Агент в ${rootWs ? rootWs.path.split(/[\\/]/).pop() : 'папке проектов'} · сам создаст рабочие деревья`
    : repo ? `ветка ${branch} от ${base} · ${repo.name}-worktrees/${key}` : 'выберите, где работать'
  const field = (
    <div className="field">
      <span>Где</span>
      <Select label="Где работать" value={where} onChange={setWhere} placeholder="Выберите…"
        options={[
          ...(rootWs ? [{ value: 'root', label: 'Все проекты — агент выберет репозиторий по SDD' }] : []),
          ...repos.map((w) => ({ value: w.id, label: `Репозиторий: ${w.name}`, hint: sug?.id === w.id && !sure ? 'возможно' : undefined })),
        ]} />
      {where === sure && sug?.reason && <span className="field-hint">{sug.reason}</span>}
      <span className="field-hint where-summary">{summary}</span>
    </div>
  )
  const body = where === 'root' ? { location: 'root' as const } : where ? { workspaceId: where } : null
  return { field, body }
}

/** «Взять в работу»: «Где» first, optional notes; «Настроить…» opens the full dialog (agent). */
export function StartPopover({ task, anchor, open, onClose }: { task: Task; anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void }) {
  const where = useWhere(task)
  // with subtasks a coordinator starts: it sends each subtask to its repository, so there is no «Где»
  const kids = useStore((s) => s.tasks.filter((t) => t.parentId === task.id).length)
  return (
    <NotesPopover
      anchor={anchor} open={open} onClose={onClose}
      label="Дополнительно" draftKey={`start:${task.id}`}
      placeholder="например: только бэкенд, фронт не трогать"
      before={kids ? <p className="field-hint">Координатор раздаст {kids} {plural(kids, 'подзадачу', 'подзадачи', 'подзадач')} — каждую в её репозиторий.</p> : where.field}
      primary={{
        label: kids ? 'Запустить координатора' : 'Взять в работу', icon: <Play />,
        run: async (notes) => {
          if (!kids && !where.body) { toast('Выберите, где работать', 'error'); return false }
          const st = getState()
          const s = await runJob('Взять в работу', (jobId) => api<Session & { jumped?: boolean }>('POST', `/tasks/${encodeURIComponent(task.id)}/start`, { agent: st.defaultAgent ?? undefined, notes: notes || undefined, ...(kids ? {} : where.body) }, { jobId }))
          if (!s) return false
          if (s.jumped) toast('Задача уже в работе — открыл текущую сессию')
          adoptSession(s)
          return true
        },
      }}
      extra={<Button size="sm" variant="ghost" onClick={() => { onClose(); openDialog({ kind: 'start', taskId: task.id }) }}>Настроить…</Button>}
    />
  )
}
