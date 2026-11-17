import { useEffect, useMemo, useState } from 'react'
import { api, errorText, qs, tryApi } from '../api'
import { closeDialog, openWorktree, setState, toast, useStore, type DialogRequest } from '../store'
import { adoptSession } from '../lib/actions'
import { loadWorktrees } from '../ws'
import { basename, isAbsolutePath } from '../lib/format'
import type { GitSuggest, Session, Workspace, Worktree } from '../types'
import { Modal } from './ui/Dialog'
import { Segmented, Select, SuggestInput } from './ui'
import { modeShort } from '../lib/agents'
import { Markdown } from './Markdown'

export function Dialogs() {
  const d = useStore((s) => s.dialog)
  if (!d) return null
  return <DialogSwitch key={JSON.stringify(d)} d={d} />
}

function DialogSwitch({ d }: { d: DialogRequest }) {
  switch (d.kind) {
    case 'workspace': return <WorkspaceDialog />
    case 'chat': return <ChatDialog workspaceId={d.workspaceId} cwd={d.cwd} />
    case 'terminal': return <TerminalDialog workspaceId={d.workspaceId} cwd={d.cwd} />
    case 'worktree': return <WorktreeDialog workspaceId={d.workspaceId} />
    case 'pr': return <PrDialog cwd={d.cwd} />
    case 'start': return <StartDialog taskId={d.taskId} />
  }
}

function useBusy() {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }
  return [busy, run] as const
}

// ---------- workspace ----------

function WorkspaceDialog() {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, run] = useBusy()
  const valid = isAbsolutePath(path)
  return (
    <Modal
      title="Добавить проект"
      submitLabel="Добавить"
      busy={busy}
      disabled={!valid}
      onClose={closeDialog}
      onSubmit={() => run(async () => {
        const ws = await tryApi<Workspace>('POST', '/workspaces', { path: path.trim(), name: name.trim() || undefined })
        if (!ws) return
        setState((s) => ({ workspaces: s.workspaces.some((w) => w.id === ws.id) ? s.workspaces : [...s.workspaces, ws] }))
        openWorktree(ws.path)
        toast(`Проект «${ws.name}» добавлен`, 'ok')
        closeDialog()
      })}
    >
      <label className="field">
        <span>Путь к папке</span>
        <input className="input mono" autoFocus placeholder="D:\projects\my-service" value={path} onChange={(e) => setPath(e.target.value)} />
        {path && !valid && <span className="field-error">Нужен абсолютный путь, например C:\code\app</span>}
      </label>
      <label className="field">
        <span>Название</span>
        <input className="input" placeholder={path ? basename(path) : 'по имени папки'} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
    </Modal>
  )
}

// ---------- where: project + worktree ----------

interface Where { workspaceId: string; cwd: string }

function useWhere(init: Partial<Where>): [Where, (w: Where) => void] {
  const workspaces = useStore((s) => s.workspaces)
  const first = workspaces.find((w) => w.id === init.workspaceId) ?? workspaces[0]
  return useState<Where>({ workspaceId: first?.id ?? '', cwd: init.cwd ?? first?.path ?? '' })
}

function WhereFields({ value, onChange }: { value: Where; onChange: (w: Where) => void }) {
  const workspaces = useStore((s) => s.workspaces)
  const worktrees = useStore((s) => s.worktrees[value.workspaceId])
  const ws = workspaces.find((w) => w.id === value.workspaceId)

  useEffect(() => {
    if (ws?.isGit && !worktrees) void loadWorktrees(ws.id)
  }, [ws, worktrees])

  if (!workspaces.length) return <p className="field-hint">Сначала добавьте проект (кнопка с папкой в боковой панели).</p>

  const options: Worktree[] = worktrees?.length ? [...worktrees] : ws ? [{ path: ws.path, branch: null, head: '', main: true }] : []
  if (value.cwd && !options.some((o) => o.path === value.cwd)) options.push({ path: value.cwd, branch: null, head: '', main: false })

  return (
    <div className="dialog-grid">
      <label className="field">
        <span>Проект</span>
        <Select
          label="Проект"
          size="lg"
          value={value.workspaceId}
          onChange={(id) => onChange({ workspaceId: id, cwd: workspaces.find((w) => w.id === id)?.path ?? '' })}
          options={workspaces.map((w) => ({ value: w.id, label: w.name, hint: w.path }))}
        />
      </label>
      <label className="field">
        <span>Рабочая копия</span>
        <Select
          label="Рабочая копия"
          size="lg"
          value={value.cwd}
          onChange={(cwd) => onChange({ ...value, cwd })}
          options={options.map((o) => ({ value: o.path, label: o.branch ?? basename(o.path), hint: o.main ? 'основная копия' : o.path }))}
        />
      </label>
    </div>
  )
}

// ---------- chat ----------

function ChatDialog(init: Partial<Where>) {
  const agents = useStore((s) => s.agents)
  const enabled = useMemo(() => agents.filter((a) => a.enabled), [agents])
  const [where, setWhere] = useWhere(init)
  const defaultAgent = useStore((s) => s.defaultAgent)
  const [agentId, setAgentId] = useState((enabled.find((a) => a.id === defaultAgent) ?? enabled[0])?.id ?? '')
  const agent = enabled.find((a) => a.id === agentId)
  const [mode, setMode] = useState(agent?.approvalMode ?? '')
  const [role, setRole] = useState<'solo' | 'coordinator'>('solo')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, run] = useBusy()

  return (
    <Modal
      title="Новый чат с настройками"
      submitLabel={prompt.trim() ? 'Начать' : 'Создать'}
      busy={busy}
      disabled={!agent || !where.cwd}
      wide
      onClose={closeDialog}
      onSubmit={() => run(async () => {
        const s = await tryApi<Session>('POST', '/sessions', {
          kind: 'chat', agent: agentId, cwd: where.cwd, workspaceId: where.workspaceId || undefined,
          title: title.trim() || undefined, prompt: prompt.trim() || undefined, role, approvalMode: mode || undefined,
        })
        if (!s) return
        closeDialog()
        adoptSession(s)
      })}
    >
      <WhereFields value={where} onChange={setWhere} />
      <div className="dialog-grid">
        <label className="field">
          <span>Агент</span>
          <Select
            label="Агент"
            size="lg"
            value={agentId}
            onChange={(id) => { setAgentId(id); setMode(enabled.find((a) => a.id === id)?.approvalMode ?? '') }}
            options={enabled.map((a) => ({ value: a.id, label: a.label, hint: a.id === defaultAgent ? 'по умолчанию' : undefined }))}
          />
          {!enabled.length && <span className="field-error">Нет включённых агентов в конфигурации</span>}
        </label>
        <label className="field">
          <span>Режим подтверждений</span>
          <Select
            label="Режим подтверждений"
            size="lg"
            value={mode}
            onChange={setMode}
            options={(agent?.approvalModes ?? []).map((m) => ({ value: m, label: modeShort(m), hint: agent?.approvalModeLabels?.[m] ?? m }))}
          />
        </label>
      </div>
      <div className="dialog-grid">
        <div className="field">
          <span id="role-label">Роль</span>
          <Segmented
            label="Роль"
            value={role}
            onChange={setRole}
            options={[{ value: 'solo', label: 'Один агент' }, { value: 'coordinator', label: 'Координатор', hint: 'Разбивает работу и запускает исполнителей' }]}
          />
        </div>
        <label className="field">
          <span>Название</span>
          <input className="input" placeholder="по первому сообщению" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      {role === 'coordinator' && (
        <p className="field-hint">Координатор разбивает работу на задачи и запускает исполнителей — каждый в своём чате.</p>
      )}
      <label className="field">
        <span>Первое сообщение</span>
        <textarea className="textarea" rows={5} placeholder="Что нужно сделать? Можно оставить пустым." value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
    </Modal>
  )
}

// ---------- terminal ----------

function TerminalDialog(init: Partial<Where>) {
  const agents = useStore((s) => s.agents)
  const shell = useStore((s) => s.shell)
  const [where, setWhere] = useWhere(init)
  const [program, setProgram] = useState('shell')
  const [command, setCommand] = useState('')
  const [title, setTitle] = useState('')
  const [busy, run] = useBusy()

  return (
    <Modal
      title="Новый терминал"
      submitLabel="Открыть"
      busy={busy}
      disabled={!where.cwd}
      onClose={closeDialog}
      onSubmit={() => run(async () => {
        const s = await tryApi<Session>('POST', '/sessions', {
          kind: 'terminal', agent: program, cwd: where.cwd, workspaceId: where.workspaceId || undefined,
          title: title.trim() || undefined, command: command.trim() || undefined,
        })
        if (!s) return
        closeDialog()
        adoptSession(s)
      })}
    >
      <WhereFields value={where} onChange={setWhere} />
      <label className="field">
        <span>Программа</span>
        <Select
          label="Программа"
          size="lg"
          value={program}
          onChange={setProgram}
          options={[
            { value: 'shell', label: 'Оболочка', hint: shell || undefined },
            ...agents.filter((a) => a.enabled).map((a) => ({ value: a.id, label: a.label, hint: 'интерактивный режим CLI' })),
          ]}
        />
      </label>
      <label className="field">
        <span>Команда при запуске</span>
        <input className="input mono" placeholder={program === 'shell' ? 'например, npm run dev' : 'по умолчанию — CLI агента'} value={command} onChange={(e) => setCommand(e.target.value)} />
      </label>
      <label className="field">
        <span>Название</span>
        <input className="input" placeholder="Терминал" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
    </Modal>
  )
}

// ---------- worktree ----------

function WorktreeDialog({ workspaceId }: { workspaceId?: string }) {
  const workspaces = useStore((s) => s.workspaces)
  const git = useMemo(() => workspaces.filter((w) => w.isGit), [workspaces])
  const [repo, setRepo] = useState(workspaceId ?? git[0]?.id ?? '')
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [busy, run] = useBusy()
  return (
    <Modal
      title="Новое рабочее дерево"
      submitLabel="Создать"
      busy={busy}
      disabled={!name.trim() || !repo}
      onClose={closeDialog}
      onSubmit={() => run(async () => {
        const wt = await tryApi<Worktree>('POST', `/workspaces/${encodeURIComponent(repo)}/worktrees`, { name: name.trim(), base: base.trim() || undefined })
        if (!wt) return
        await loadWorktrees(repo)
        openWorktree(wt.path)
        toast(`Рабочее дерево ${wt.branch ?? name} создано`, 'ok')
        closeDialog()
      })}
    >
      <label className="field">
        <span>Репозиторий</span>
        <Select label="Репозиторий" size="lg" value={repo} onChange={setRepo} options={git.map((w) => ({ value: w.id, label: w.name, hint: w.path }))} />
        {!git.length && <span className="field-error">Нет git-репозиториев. Сначала добавьте проект.</span>}
      </label>
      <label className="field">
        <span>Ветка</span>
        <input className="input mono" autoFocus placeholder="feature/JIRA-1234" value={name} onChange={(e) => setName(e.target.value)} />
        <span className="field-hint">Имя новой ветки; папка рабочего дерева будет названа так же.</span>
      </label>
      <label className="field">
        <span>От ветки</span>
        <input className="input mono" placeholder="HEAD" value={base} onChange={(e) => setBase(e.target.value)} />
      </label>
    </Modal>
  )
}

// ---------- take a task into work ----------

function StartDialog({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId))
  const agents = useStore((s) => s.agents)
  const defaultAgent = useStore((s) => s.defaultAgent)
  const enabled = useMemo(() => agents.filter((a) => a.enabled), [agents])
  const [agent, setAgent] = useState((enabled.find((a) => a.id === defaultAgent) ?? enabled[0])?.id ?? '')
  const [notes, setNotes] = useState('')
  const [busy, run] = useBusy()
  if (!task) return null
  return (
    <Modal
      title={`Взять в работу ${task.externalId ?? task.id}`}
      submitLabel="Запустить"
      busy={busy}
      disabled={!agent}
      onClose={closeDialog}
      onSubmit={() => run(async () => {
        const s = await tryApi<Session & { jumped?: boolean }>('POST', `/tasks/${encodeURIComponent(task.id)}/start`, { agent, notes: notes.trim() || undefined })
        if (!s) return
        closeDialog()
        if (s.jumped) toast('Задача уже в работе — открыл текущую сессию')
        adoptSession(s)
      })}
    >
      <p className="muted" style={{ marginTop: -6 }}>{task.title}</p>
      <label className="field">
        <span>Агент</span>
        <Select label="Агент" size="lg" value={agent} onChange={setAgent} options={enabled.map((a) => ({ value: a.id, label: a.label, hint: a.id === defaultAgent ? 'по умолчанию' : undefined }))} />
      </label>
      <label className="field">
        <span>Заметки</span>
        <textarea className="textarea" rows={3} autoFocus placeholder="Необязательно: уточнения к задаче, которые получит агент" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <span className="field-hint">Агент стартует в новом рабочем дереве задачи{task.targets[0] ? ` от ${task.targets[0]}` : ''}.</span>
      </label>
    </Modal>
  )
}

// ---------- pull request ----------

// sourcecontrol limits are bytes of UTF-8, not characters: a Cyrillic letter takes two.
const PR_TITLE_BYTES = 100
const PR_BODY_BYTES = 512
const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length

function ByteCount({ value, limit }: { value: string; limit: number }) {
  const n = bytes(value)
  return <span className="byte-count num" data-over={n > limit || undefined} aria-live="polite">{n}/{limit} байт</span>
}

function PrDialog({ cwd }: { cwd: string }) {
  const tasks = useStore((s) => s.tasks)
  const [suggest, setSuggest] = useState<GitSuggest | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, run] = useBusy()

  useEffect(() => {
    api<GitSuggest>('GET', `/git/suggest${qs({ cwd })}`).then((s) => {
      setSuggest(s)
      // Prefill only what the user hasn't typed yet.
      setTitle((v) => v || s.pr.title)
      setBody((v) => v || s.pr.body)
      setBase((v) => v || s.pr.base)
    }, (e) => toast(`Не удалось подготовить PR: ${errorText(e)}`, 'error'))
  }, [cwd])

  const targets = tasks.find((t) => t.id === suggest?.taskId)?.targets ?? []
  const over = bytes(title.trim()) > PR_TITLE_BYTES || bytes(body) > PR_BODY_BYTES

  return (
    <Modal
      title="Создать pull request"
      submitLabel="Создать PR"
      busy={busy}
      disabled={!title.trim() || !base.trim() || over}
      wide
      onClose={closeDialog}
      onSubmit={() => run(async () => {
        const res = await tryApi<{ url: string; existing?: boolean }>('POST', '/git/pr', { cwd, title: title.trim(), body, base: base.trim() })
        if (!res) return
        toast(res.existing ? 'PR уже открыт' : 'Pull request создан', res.existing ? 'info' : 'ok', res.url)
        closeDialog()
      })}
    >
      <p className="muted" style={{ marginTop: -6 }}>
        {suggest?.branch ? <>Из <span className="mono">{suggest.branch}</span> · {basename(cwd)}</> : basename(cwd)}
      </p>
      <label className="field">
        <span className="row" style={{ justifyContent: 'space-between' }}>Заголовок <ByteCount value={title.trim()} limit={PR_TITLE_BYTES} /></span>
        <input className="input" aria-invalid={bytes(title.trim()) > PR_TITLE_BYTES} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={suggest ? '' : 'Загрузка…'} />
      </label>
      <div className="field">
        <span className="row" style={{ justifyContent: 'space-between' }}>
          <span id="pr-body-label">Описание <ByteCount value={body} limit={PR_BODY_BYTES} /></span>
          <Segmented size="sm" label="Режим описания" value={preview ? 'view' : 'edit'} onChange={(v) => setPreview(v === 'view')} options={[{ value: 'edit', label: 'Текст' }, { value: 'view', label: 'Просмотр' }]} />
        </span>
        {preview
          ? <div className="md-preview">{body.trim() ? <Markdown text={body} /> : <p className="muted">Пусто</p>}</div>
          : <textarea className="textarea" rows={10} aria-labelledby="pr-body-label" aria-invalid={bytes(body) > PR_BODY_BYTES} value={body} onChange={(e) => setBody(e.target.value)} />}
      </div>
      <label className="field">
        <span>В ветку</span>
        <SuggestInput mono label="Целевая ветка PR" value={base} onChange={setBase} suggestions={[...new Set([suggest?.pr.base, ...targets].filter((t): t is string => !!t))]} />
      </label>
    </Modal>
  )
}
