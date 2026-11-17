import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpToLine, ExternalLink, GitMerge, Lock, Play, Plus, Send, SquareArrowOutUpRight, Trash2, UserPlus, X } from 'lucide-react'
import { tryApi } from '../../api'
import { openSession, setState, toast, upsert, useStore, without } from '../../store'
import { COLUMNS, fullTime, PRIORITY, relTime } from '../../lib/format'
import { pendingDeps, startTask, taskKey } from '../../lib/tasks'
import { useNow } from '../../lib/useNow'
import type { Session, Task, TaskPort, TaskStatus } from '../../types'
import { Branch, StatusIcon, statusText } from '../bits'
import { Markdown } from '../Markdown'
import type { BoardCtx } from './TaskCard'

async function patchTask(id: string, fields: Partial<Task> & { comment?: string }) {
  const t = await tryApi<Task>('PATCH', `/tasks/${encodeURIComponent(id)}`, fields)
  if (t) setState((s) => ({ tasks: upsert(s.tasks, t) }))
  return t
}

/** Local edit buffer that follows the server value until the user starts typing. */
function useDraft(value: string) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return [draft, setDraft] as const
}

export function TaskDrawer({ task, ctx, onClose }: { task: Task; ctx: BoardCtx; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  const titleId = useId()
  const workspaces = useStore((s) => s.workspaces)
  const [panel, setPanel] = useState<'assign' | 'send' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const key = taskKey(task, ctx.byId)
  const parent = task.parentId ? ctx.byId.get(task.parentId) : undefined
  const session = task.assigneeSessionId ? ctx.sessions.get(task.assigneeSessionId) : undefined
  const blocked = pendingDeps(task, ctx.byId)
  const patch = (fields: Partial<Task>) => patchTask(task.id, fields)

  const remove = async () => {
    const ok = await tryApi<unknown>('DELETE', `/tasks/${encodeURIComponent(task.id)}`)
    if (ok === undefined) return
    setState((s) => ({ tasks: without(s.tasks, task.id) }))
    onClose()
  }

  return (
    <aside ref={ref} className="drawer" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}>
      <header className="drawer-head">
        <span className="mono card-id" title={task.id}>{task.parentId ? `${key} · ${task.id}` : key}</span>
        {task.externalUrl && (
          <a className="icon-btn icon-btn-sm" href={task.externalUrl} target="_blank" rel="noreferrer noopener" aria-label="Открыть в трекере" title="Открыть в трекере">
            <ExternalLink />
          </a>
        )}
        <span className="grow" />
        <span className="muted" title={fullTime(task.updatedAt)}>обновлено {relTime(task.updatedAt)}</span>
        <button type="button" className="icon-btn" aria-label="Закрыть" title="Закрыть (Esc)" onClick={onClose}><X /></button>
      </header>

      <div className="drawer-body">
        {parent && (
          <button type="button" className="drawer-parent" onClick={() => ctx.onOpen(parent.id)}>
            Подзадача <span className="mono">{parent.id}</span> <span className="ellipsis">{parent.title}</span>
          </button>
        )}
        <TitleField id={titleId} task={task} />

        <div className="drawer-actions">
          {(task.status === 'backlog' || task.status === 'todo' || !session) && (
            <button type="button" className="btn btn-primary" disabled={blocked.length > 0} title={blocked.length ? `Ждёт: ${blocked.join(', ')}` : undefined} onClick={() => void startTask(task)}>
              <Play />
              Взять в работу
            </button>
          )}
          {session && (
            <button type="button" className="btn" onClick={() => openSession(session.id)}>
              <StatusIcon session={session} />
              Открыть сессию
            </button>
          )}
          <button type="button" className="btn btn-ghost" aria-expanded={panel === 'assign'} onClick={() => setPanel(panel === 'assign' ? null : 'assign')}>
            <UserPlus />
            Назначить агенту…
          </button>
          <button type="button" className="btn btn-ghost" aria-expanded={panel === 'send'} onClick={() => setPanel(panel === 'send' ? null : 'send')}>
            <Send />
            В сессию…
          </button>
        </div>
        {panel === 'assign' && <AssignForm task={task} onDone={() => setPanel(null)} />}
        {panel === 'send' && <SendForm task={task} onDone={() => setPanel(null)} />}
        {session && (
          <p className="drawer-assignee">
            <StatusIcon session={session} /> {session.title} · <span className="mono">{ctx.agents.get(session.agent)?.label ?? session.agent}</span> · {statusText(session)}
          </p>
        )}

        <div className="props">
          <Prop label="Статус">
            <select className="select" value={task.status} onChange={(e) => void patch({ status: e.target.value as TaskStatus })}>
              {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </Prop>
          <Prop label="Приоритет">
            <select className="select" value={task.priority ?? ''} onChange={(e) => void patch({ priority: (e.target.value || null) as Task['priority'] })}>
              <option value="">Без приоритета</option>
              {(['high', 'medium', 'low'] as const).map((p) => <option key={p} value={p}>{PRIORITY[p]}</option>)}
            </select>
          </Prop>
          <Prop label="Репозиторий">
            <select className="select" value={task.workspaceId ?? ''} onChange={(e) => void patch({ workspaceId: e.target.value || null })}>
              <option value="">Не выбран</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Prop>
          <Prop label="Целевые ветки">
            <TargetsField task={task} onChange={(targets) => void patch({ targets })} />
          </Prop>
          <Prop label="Ветка">
            <BranchField task={task} />
          </Prop>
          <Prop label="Зависимости">
            <DepsField task={task} ctx={ctx} onChange={(deps) => void patch({ deps })} />
          </Prop>
          <Prop label="Метки">
            <LabelsField labels={task.labels} onChange={(labels) => void patch({ labels })} />
          </Prop>
        </div>

        <DescriptionField task={task} />
        {task.targets.length > 1 && <Ports task={task} />}
        <Subtasks task={task} ctx={ctx} />
        <Activity task={task} sessions={ctx.sessions} />

        <footer className="drawer-foot">
          {confirmDelete ? (
            <>
              <span>Удалить {task.id} без возможности восстановления?</span>
              <button type="button" className="btn btn-danger" onClick={() => void remove()}>Удалить</button>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>Отмена</button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost btn-danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
              Удалить задачу
            </button>
          )}
        </footer>
      </div>
    </aside>
  )
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="prop-label">{label}</span>
      <div className="prop-value">{children}</div>
    </>
  )
}

function TitleField({ id, task }: { id: string; task: Task }) {
  const [v, setV] = useDraft(task.title)
  const save = () => { if (v.trim() && v !== task.title) void patchTask(task.id, { title: v.trim() }) }
  return (
    <textarea
      id={id}
      className="drawer-title"
      aria-label="Название задачи"
      rows={1}
      value={v}
      onChange={(e) => setV(e.target.value.replace(/\n/g, ' '))}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
      ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }}
    />
  )
}

function BranchField({ task }: { task: Task }) {
  const [v, setV] = useDraft(task.branch ?? '')
  return (
    <input
      className="input mono"
      placeholder="создаётся при запуске"
      aria-label="Рабочая ветка задачи"
      title={task.branch ?? undefined}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v.trim() !== (task.branch ?? '')) void patchTask(task.id, { branch: v.trim() || null }) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

function DescriptionField({ task }: { task: Task }) {
  const [v, setV] = useDraft(task.description)
  const [edit, setEdit] = useState(!task.description)
  return (
    <section className="drawer-section">
      <h3>
        Описание
        <span className="seg" role="group" aria-label="Режим описания">
          <button type="button" aria-pressed={edit} onClick={() => setEdit(true)}>Текст</button>
          <button type="button" aria-pressed={!edit} onClick={() => setEdit(false)}>Просмотр</button>
        </span>
      </h3>
      {edit ? (
        <textarea
          className="textarea"
          rows={8}
          aria-label="Описание задачи (markdown)"
          placeholder="Что сделать, критерии готовности, ссылки. Поддерживается markdown."
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => { if (v !== task.description) void patchTask(task.id, { description: v }) }}
        />
      ) : (
        <div className="md-preview" onDoubleClick={() => setEdit(true)}>
          {v.trim() ? <Markdown text={v} /> : <p className="muted">Описания нет.</p>}
        </div>
      )}
    </section>
  )
}

function TargetsField({ task, onChange }: { task: Task; onChange: (t: string[]) => void }) {
  const allTasks = useStore((s) => s.tasks)
  const [v, setV] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const known = useMemo(() => [...new Set(['develop', 'main', ...allTasks.flatMap((t) => t.targets)])], [allTasks])
  const targets = task.targets
  const add = () => {
    const t = v.trim()
    if (!t || targets.includes(t)) return
    onChange([...targets, t])
    setV('')
  }
  return (
    <div className="targets">
      <div className="chips">
        {targets.map((t, i) => (
          <span key={t} className={i === 0 ? 'chip chip-mono chip-primary' : 'chip chip-mono'} title={i === 0 ? 'Основная: здесь делается работа' : 'Портируется cherry-pick'}>
            {i > 0 && <GitMerge aria-hidden />}
            {t}
            {i > 0 && (
              <button type="button" className="chip-x" aria-label={`Сделать ${t} основной`} title="Сделать основной" onClick={() => onChange([t, ...targets.filter((x) => x !== t)])}>
                <ArrowUpToLine />
              </button>
            )}
            <button type="button" className="chip-x" aria-label={`Убрать ${t}`} onClick={() => onChange(targets.filter((x) => x !== t))}>
              <X />
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <input
          ref={input}
          className="input mono"
          list={listId}
          placeholder="ветка, Enter — добавить"
          aria-label="Добавить целевую ветку"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        />
        <datalist id={listId}>{known.filter((k) => !targets.includes(k)).map((k) => <option key={k} value={k} />)}</datalist>
        <button type="button" className="btn btn-sm" onClick={() => { setV('release-'); input.current?.focus() }} title="Добавить релизную ветку">
          release-x.y.z
        </button>
      </div>
      <p className="field-hint">Первая — где делается работа, остальные — куда портируется cherry-pick'ом.</p>
    </div>
  )
}

function DepsField({ task, ctx, onChange }: { task: Task; ctx: BoardCtx; onChange: (d: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = (id: string) => onChange(task.deps.includes(id) ? task.deps.filter((d) => d !== id) : [...task.deps, id])
  const needle = q.trim().toLowerCase()
  const options = [...ctx.byId.values()].filter((t) => t.id !== task.id && (!needle || `${t.id} ${t.title}`.toLowerCase().includes(needle)))

  return (
    <div className="deps" ref={box}>
      <div className="chips">
        {task.deps.map((d) => {
          const dep = ctx.byId.get(d)
          const waiting = dep && dep.status !== 'done'
          return (
            <span key={d} className={waiting ? 'chip chip-fail' : 'chip chip-done'} title={dep ? `${dep.title} — ${COLUMNS.find((c) => c.id === dep.status)?.label}` : 'задача удалена'}>
              {waiting && <Lock aria-hidden />}
              <button type="button" className="chip-link mono" onClick={() => dep && ctx.onOpen(d)}>{d}</button>
              <button type="button" className="chip-x" aria-label={`Убрать зависимость ${d}`} onClick={() => toggle(d)}><X /></button>
            </span>
          )
        })}
        <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Plus aria-hidden />
          добавить
        </button>
      </div>
      {open && (
        <div
          className="menu deps-menu"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false) } }}
        >
          <input className="input" autoFocus placeholder="Поиск задачи" aria-label="Поиск задачи" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="deps-list">
            {options.map((t) => (
              <label key={t.id} className="deps-option">
                <input type="checkbox" checked={task.deps.includes(t.id)} onChange={() => toggle(t.id)} />
                <span className="mono muted">{t.id}</span>
                <span className="ellipsis">{t.title}</span>
              </label>
            ))}
            {options.length === 0 && <p className="muted" style={{ padding: 8 }}>Нет задач</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function LabelsField({ labels, onChange }: { labels: string[]; onChange: (l: string[]) => void }) {
  const [v, setV] = useState('')
  const add = () => {
    const next = v.split(',').map((x) => x.trim()).filter((x) => x && !labels.includes(x))
    if (next.length) onChange([...labels, ...next])
    setV('')
  }
  return (
    <div className="chips">
      {labels.map((l) => (
        <span key={l} className="chip">
          {l}
          <button type="button" className="chip-x" aria-label={`Убрать метку ${l}`} onClick={() => onChange(labels.filter((x) => x !== l))}><X /></button>
        </span>
      ))}
      <input
        className="input input-inline"
        placeholder="метка"
        aria-label="Добавить метку"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        onBlur={add}
      />
    </div>
  )
}

const PORT_STATUS: Record<TaskPort['status'], { label: string; cls: string }> = {
  clean: { label: 'перенесено', cls: 'chip chip-done' },
  conflict: { label: 'конфликт', cls: 'chip chip-run' },
  done: { label: 'готово', cls: 'chip chip-done' },
  failed: { label: 'ошибка', cls: 'chip chip-fail' },
}

function Ports({ task }: { task: Task }) {
  const [busy, setBusy] = useState<string | null>(null)
  const port = async (target: string) => {
    setBusy(target)
    const res = await tryApi<TaskPort>('POST', `/tasks/${encodeURIComponent(task.id)}/port`, { target })
    setBusy(null)
    if (!res) return
    if (res.status === 'conflict') toast(`Конфликт при переносе в ${target} — агент разбирается`, 'info')
    else toast(`Перенесено в ${target}`, 'ok')
    if (res.sessionId) openSession(res.sessionId)
  }
  return (
    <section className="drawer-section">
      <h3>Портирование</h3>
      {!task.branch && <p className="field-hint">Сначала нужна рабочая ветка: возьмите задачу в работу.</p>}
      <div className="ports">
        {task.targets.slice(1).map((target) => {
          const p = task.ports.find((x) => x.target === target)
          return (
            <div key={target} className="port-row">
              <GitMerge aria-hidden />
              <span className="mono ellipsis" title={target}>{target}</span>
              {p ? <span className={PORT_STATUS[p.status].cls}>{PORT_STATUS[p.status].label}</span> : <span className="chip">не перенесено</span>}
              <span className="grow" />
              {p?.sessionId && (
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Открыть сессию портирования" title="Открыть сессию" onClick={() => openSession(p.sessionId!)}>
                  <SquareArrowOutUpRight />
                </button>
              )}
              {(!p || p.status === 'failed') && (
                <button type="button" className="btn btn-sm" disabled={!task.branch || busy !== null} onClick={() => void port(target)}>
                  {busy === target ? 'Переносим…' : `Портировать в ${target}`}
                </button>
              )}
              {p && <span className="port-branch"><Branch name={p.branch} /></span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Subtasks({ task, ctx }: { task: Task; ctx: BoardCtx }) {
  const workspaces = useStore((s) => s.workspaces)
  const kids = ctx.kids.get(task.id) ?? []
  const done = kids.filter((k) => k.status === 'done').length
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [repo, setRepo] = useState(task.workspaceId ?? '')

  const add = async () => {
    if (!title.trim()) return
    const t = await tryApi<Task>('POST', '/tasks', { title: title.trim(), parentId: task.id, workspaceId: repo || undefined })
    if (!t) return
    setState((s) => ({ tasks: upsert(s.tasks, t) }))
    setTitle('')
  }

  return (
    <section className="drawer-section">
      <h3>
        Подзадачи
        {kids.length > 0 && <span className="muted num" style={{ fontWeight: 400 }}>{done}/{kids.length}</span>}
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setAdding(!adding)} aria-expanded={adding}>
          <Plus />
          Добавить подзадачу
        </button>
      </h3>
      {kids.length > 0 && (
        <>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={kids.length} aria-valuenow={done} aria-label="Готово подзадач">
            <span style={{ transform: `scaleX(${done / kids.length})` }} />
          </div>
          <div>
            {kids.map((k) => (
              <button key={k.id} type="button" className="subtask" onClick={() => ctx.onOpen(k.id)}>
                <span className="col-mark" data-s={k.status} aria-label={COLUMNS.find((c) => c.id === k.status)?.label} />
                <span className="mono muted">{k.id}</span>
                <span className="ellipsis grow">{k.title}</span>
                {k.workspaceId && <span className="chip">{ctx.workspaces.get(k.workspaceId)?.name ?? k.workspaceId}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {kids.length === 0 && !adding && <p className="field-hint">Одна подзадача на репозиторий, если спецификация затрагивает несколько сервисов.</p>}
      {adding && (
        <form className="subtask-form" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <input className="input" autoFocus placeholder="Название подзадачи" aria-label="Название подзадачи" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select className="select" aria-label="Репозиторий подзадачи" value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">Репозиторий…</option>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button type="submit" className="btn btn-sm" disabled={!title.trim()}>Добавить</button>
        </form>
      )}
    </section>
  )
}

function Activity({ task, sessions }: { task: Task; sessions: Map<string, Session> }) {
  const now = useNow()
  if (!task.log.length) return null
  const who = (by: string) => (by === 'user' ? 'вы' : by === 'harness' ? 'harness' : sessions.get(by)?.title ?? by)
  return (
    <section className="drawer-section">
      <h3>Журнал</h3>
      <ol className="activity">
        {task.log.map((l, i) => (
          <li key={i}>
            <span className="muted" title={fullTime(l.at)}>{relTime(l.at, now)}</span>
            <span className="activity-by">{who(l.by)}</span>
            <span className="activity-text">{l.text}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function AssignForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const agents = useStore((s) => s.agents)
  const workspaces = useStore((s) => s.workspaces)
  const enabled = agents.filter((a) => a.enabled)
  const [agent, setAgent] = useState(enabled[0]?.id ?? '')
  const [worktree, setWorktree] = useState<'new' | 'current'>('new')
  const [repo, setRepo] = useState(task.workspaceId ?? workspaces[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    const s = await tryApi<Session>('POST', `/tasks/${encodeURIComponent(task.id)}/assign`, { agent, workspaceId: repo || undefined, worktree })
    setBusy(false)
    if (!s) return
    setState((st) => ({ sessions: upsert(st.sessions, s) }))
    onDone()
    openSession(s.id)
  }
  return (
    <div className="drawer-form">
      <label className="field">
        <span>Агент</span>
        <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {enabled.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Репозиторий</span>
        <select className="select" value={repo} onChange={(e) => setRepo(e.target.value)}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      <div className="field">
        <span>Рабочая копия</span>
        <div className="seg" role="group" aria-label="Рабочая копия">
          <button type="button" aria-pressed={worktree === 'new'} onClick={() => setWorktree('new')}>Новая ветка</button>
          <button type="button" aria-pressed={worktree === 'current'} onClick={() => setWorktree('current')}>Текущая</button>
        </div>
      </div>
      <button type="button" className="btn btn-primary" disabled={!agent || busy} onClick={() => void submit()}>
        {busy ? 'Запуск…' : 'Назначить'}
      </button>
    </div>
  )
}

function SendForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const sessions = useStore((s) => s.sessions)
  const chats = sessions.filter((s) => s.kind === 'chat')
  const [target, setTarget] = useState(chats[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  if (!chats.length) return <p className="field-hint drawer-form">Нет чатов. Создайте чат или назначьте задачу агенту.</p>
  const submit = async () => {
    setBusy(true)
    const s = await tryApi<Session>('POST', `/tasks/${encodeURIComponent(task.id)}/assign`, { sessionId: target })
    setBusy(false)
    if (!s) return
    onDone()
    openSession(s.id)
  }
  return (
    <div className="drawer-form">
      <label className="field" style={{ gridColumn: '1 / -1' }}>
        <span>Чат</span>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
          {chats.map((c) => <option key={c.id} value={c.id}>{c.title} — {statusText(c)}</option>)}
        </select>
      </label>
      <button type="button" className="btn btn-primary" disabled={!target || busy} onClick={() => void submit()}>
        {busy ? 'Отправка…' : 'Отправить задачу'}
      </button>
    </div>
  )
}
