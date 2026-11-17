import { useEffect, useMemo, useState } from 'react'
import { FolderPlus } from 'lucide-react'
import { api, errorText, qs, tryApi } from '../api'
import { closeDialog, openWorktree, setState, toast, upsert, useFeature, useStore, type DialogRequest } from '../store'
import { adoptSession, newChatInFolder } from '../lib/actions'
import { loadWorktrees } from '../ws'
import { basename, isAbsolutePath, normPath } from '../lib/format'
import { loadDraft, saveDraft } from '../lib/draft'
import type { GitSuggest, Session, Task, Workspace, Worktree } from '../types'
import { Modal } from './ui/Dialog'
import { CleanupDialog, DeleteWorktreeDialog, WorktreeInfoDialog } from './WorktreeMenu'
import { Button, Chip, Disclosure, Segmented, Select, SuggestInput } from './ui'
import { modeShort, useSettings } from '../lib/agents'
import { pendingDeps, taskKey } from '../lib/tasks'
import { loadPr } from '../lib/pr'
import { FolderPicker } from './FolderPicker'
import { RecoveryDialog } from './RecoveryDialog'
import { archiveSession, deleteSession, isLive } from '../lib/sessionActions'
import { endJob, startJob, useJobStep } from '../lib/jobs'
import { Markdown } from './Markdown'
import { useWhere as useStartWhere } from './board/Rework'

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
    case 'pr': return <PrDialog cwd={d.cwd} base={d.base} />
    case 'start': return <StartDialog taskId={d.taskId} />
    case 'wt-delete': return <DeleteWorktreeDialog workspaceId={d.workspaceId} path={d.path} />
    case 'wt-info': return <WorktreeInfoDialog workspaceId={d.workspaceId} path={d.path} />
    case 'wt-cleanup': return <CleanupDialog workspaceId={d.workspaceId} />
    case 'recovery': return <RecoveryDialog />
    case 'session-delete': return <SessionDeleteDialog id={d.id} />
    case 'session-archive': return <SessionArchiveDialog id={d.id} />
    case 'session-perms': return <SessionPermsDialog id={d.id} />
    case 'folder-chat': return <FolderPicker title="Новый чат в папке" submitLabel="Начать чат здесь" onClose={closeDialog} onPick={(p) => { closeDialog(); void newChatInFolder(p) }} />
  }
}

/** Submit state of a dialog; the job id goes with the request so the server's steps show on the button. */
function useBusy() {
  const [job, setJob] = useState<string | null>(null)
  const step = useJobStep(job)
  const run = async (fn: (jobId: string) => Promise<unknown>) => {
    const id = startJob('', true)
    setJob(id)
    try { await fn(id) } finally { endJob(id); setJob(null) }
  }
  return [job !== null, run, step] as const
}

// ---------- workspace ----------

function WorkspaceDialog() {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, run, step] = useBusy()
  const valid = isAbsolutePath(path)
  return (
    <Modal
      title="Добавить проект"
      submitLabel="Добавить"
      busy={busy}
      progress={step}
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

type Place = 'root' | 'project' | 'folder'

function ChatDialog(init: Partial<Where>) {
  const agents = useStore((s) => s.agents)
  const enabled = useMemo(() => agents.filter((a) => a.enabled), [agents])
  const rootWs = useStore((s) => s.workspaces.find((w) => w.kind === 'root'))
  const foldersOn = useFeature('folders')
  const dirsOn = useFeature('include-dirs')
  // «Где»: the projects folder unless the dialog was opened for a particular project/worktree.
  const [place, setPlace] = useState<Place>(rootWs && !init.cwd ? 'root' : 'project')
  const [folder, setFolder] = useState<string | null>(null)
  const [picking, setPicking] = useState<'folder' | 'dir' | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [where, setWhere] = useWhere(init)
  const target: { cwd: string; workspaceId?: string } | null =
    place === 'root' ? (rootWs ? { cwd: rootWs.path, workspaceId: rootWs.id } : null)
      : place === 'folder' ? (folder ? { cwd: folder } : null)
        : where.cwd ? { cwd: where.cwd, workspaceId: where.workspaceId || undefined } : null
  const defaultAgent = useStore((s) => s.defaultAgent)
  const [agentId, setAgentId] = useState((enabled.find((a) => a.id === defaultAgent) ?? enabled[0])?.id ?? '')
  const agent = enabled.find((a) => a.id === agentId)
  const [mode, setMode] = useState(agent?.approvalMode ?? '')
  const [role, setRole] = useState<'solo' | 'coordinator'>('solo')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, run, step] = useBusy()

  return (
    <Modal
      title="Новый чат с настройками"
      submitLabel={prompt.trim() ? 'Начать' : 'Создать'}
      busy={busy}
      progress={step}
      disabled={!agent || !target}
      wide
      onClose={closeDialog}
      onSubmit={() => run(async () => {
        let ws = target!.workspaceId
        if (place === 'folder') { // a folder outside the projects: registered first, like «Новый чат в папке…»
          const created = await tryApi<Workspace>('POST', '/workspaces', { path: target!.cwd, kind: 'folder' })
          if (!created) return
          ws = created.id
        }
        const s = await tryApi<Session>('POST', '/sessions', {
          kind: 'chat', agent: agentId, cwd: target!.cwd, workspaceId: ws,
          title: title.trim() || undefined, prompt: prompt.trim() || undefined, role, approvalMode: mode || undefined,
          includeDirs: dirsOn && dirs.length ? dirs : undefined,
        })
        if (!s) return
        closeDialog()
        adoptSession(s)
      })}
    >
      {(rootWs || foldersOn) && (
        <div className="field">
          <span>Где</span>
          <Segmented label="Где запустить чат" value={place} onChange={(v) => { setPlace(v); if (v === 'folder' && !folder) setPicking('folder') }}
            options={[
              ...(rootWs ? [{ value: 'root' as const, label: 'Все проекты', hint: rootWs.path }] : []),
              { value: 'project' as const, label: 'Проект' },
              ...(foldersOn ? [{ value: 'folder' as const, label: folder ? `Папка: ${basename(folder)}` : 'Папка…', hint: folder ?? 'Выбрать любую папку' }] : []),
            ]} />
          {place === 'root' && rootWs && <span className="field-hint">Агент видит все проекты в <span className="mono">{rootWs.path}</span>.</span>}
          {place === 'folder' && folder && <span className="field-hint mono">{folder} <button type="button" className="link" onClick={() => setPicking('folder')}>изменить</button></span>}
        </div>
      )}
      {place === 'project' && <WhereFields value={where} onChange={setWhere} />}
      {dirsOn && (
        <div className="field">
          <span>Доп. папки</span>
          <div className="chips-row">
            {dirs.map((d) => <Chip key={d} mono tip={d} onRemove={() => setDirs(dirs.filter((x) => x !== d))} removeLabel={`Убрать ${d}`}>{basename(d)}</Chip>)}
            <Button size="sm" variant="ghost" icon={<FolderPlus />} onClick={() => setPicking('dir')}>папка</Button>
          </div>
          <span className="field-hint">Агенту будут доступны и эти папки (как /dir add в CLI).</span>
        </div>
      )}
      {picking && (
        <FolderPicker
          title={picking === 'folder' ? 'Где запустить чат' : 'Дополнительная папка'}
          initial={picking === 'folder' ? folder : null}
          onClose={() => { setPicking(null); if (place === 'folder' && !folder) setPlace(rootWs ? 'root' : 'project') }}
          onPick={(p) => { if (picking === 'folder') setFolder(p); else if (!dirs.includes(p)) setDirs([...dirs, p]); setPicking(null) }}
        />
      )}
      <label className="field">
        <span>Первое сообщение</span>
        <textarea className="textarea" rows={5} autoFocus placeholder="Что нужно сделать? Можно оставить пустым." value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <Disclosure className="dialog-more" summary={<span>Ещё: {agent?.label ?? agentId} · {modeShort(mode)}{role === 'coordinator' ? ' · координатор' : ''}</span>}>
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
        <p className="field-hint">Координатор разбивает работу на задачи и запускает исполнителей, каждого в своём чате.</p>
      )}
      </Disclosure>
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
  const [busy, run, step] = useBusy()

  return (
    <Modal
      title="Новый терминал"
      submitLabel="Открыть"
      busy={busy}
      progress={step}
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
  const [busy, run, step] = useBusy()
  return (
    <Modal
      title="Новое рабочее дерево"
      submitLabel="Создать"
      busy={busy}
      progress={step}
      disabled={!name.trim() || !repo}
      onClose={closeDialog}
      onSubmit={() => run(async (jobId) => {
        const wt = await tryApi<Worktree>('POST', `/workspaces/${encodeURIComponent(repo)}/worktrees`, { name: name.trim(), base: base.trim() || undefined }, { jobId })
        if (!wt) return
        await loadWorktrees(repo)
        openWorktree(wt.path)
        toast(`Рабочее дерево ${wt.branch ?? name} создано`, 'ok')
        closeDialog()
      })}
    >
      {!git.length && <span className="field-error">Нет git-репозиториев. Сначала добавьте проект.</span>}
      <label className="field">
        <span>Ветка</span>
        <input className="input mono" autoFocus placeholder="feature/JIRA-1234" value={name} onChange={(e) => setName(e.target.value)} />
        <span className="field-hint">Имя новой ветки; папка рабочего дерева будет названа так же.</span>
      </label>
      <Disclosure className="dialog-more" summary={<span>Ещё: {git.find((w) => w.id === repo)?.name ?? 'репозиторий'} · от {base.trim() || 'HEAD'}</span>}>
        <div className="dialog-grid">
          <label className="field">
            <span>Репозиторий</span>
            <Select label="Репозиторий" size="lg" value={repo} onChange={setRepo} options={git.map((w) => ({ value: w.id, label: w.name, hint: w.path }))} />
          </label>
          <label className="field">
            <span>От ветки</span>
            <input className="input mono" placeholder="HEAD" value={base} onChange={(e) => setBase(e.target.value)} />
          </label>
        </div>
      </Disclosure>
    </Modal>
  )
}

// ---------- take a task into work ----------

function StartDialog({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId))
  return task ? <StartForm task={task} /> : null
}

function StartForm({ task }: { task: Task }) {
  const agents = useStore((s) => s.agents)
  const defaultAgent = useStore((s) => s.defaultAgent)
  const enabled = useMemo(() => agents.filter((a) => a.enabled), [agents])
  const [agent, setAgent] = useState((enabled.find((a) => a.id === defaultAgent) ?? enabled[0])?.id ?? '')
  const [notes, setNotes] = useState('')
  const [busy, run, step] = useBusy()
  const tasks = useStore((s) => s.tasks)
  const workspaces = useStore((s) => s.workspaces)
  const settings = useSettings()
  const where = useStartWhere(task) // «Где»: the projects folder (the agent picks repositories) or one repository

  // What «Запустить» will do, said before the click.
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const key = taskKey(task, byId)
  const kids = tasks.filter((t) => t.parentId === task.id)
  const waiting = pendingDeps(task, byId)
  const needsRepo = !kids.length && !where.body
  const branch = (settings?.git.branchTemplate || 'feature/{key}').replaceAll('{key}', key)
  const agentLabel = enabled.find((a) => a.id === agent)?.label ?? agent
  const kidRepos = [...new Set(kids.map((k) => workspaces.find((w) => w.id === k.workspaceId)?.name).filter(Boolean))]

  return (
    <Modal
      title={`Взять в работу ${task.externalId ?? task.id}`}
      submitLabel={kids.length ? 'Запустить координатора' : 'Запустить'}
      busy={busy}
      progress={step}
      disabled={!agent || waiting.length > 0 || needsRepo}
      onClose={closeDialog}
      onSubmit={() => run(async (jobId) => {
        const s = await tryApi<Session & { jumped?: boolean }>('POST', `/tasks/${encodeURIComponent(task.id)}/start`, { agent, notes: notes.trim() || undefined, ...(kids.length ? {} : where.body) }, { jobId })
        if (!s) return
        closeDialog()
        if (s.jumped) toast('Задача уже в работе — открыл текущую сессию')
        adoptSession(s)
      })}
    >
      <p className="muted" style={{ marginTop: -6 }}>{task.title}</p>
      <div className="start-plan" data-blocked={waiting.length > 0 || needsRepo || undefined}>
        {waiting.length > 0 ? (
          <span>Ждёт: {waiting.join(', ')}. Сначала закончите зависимости.</span>
        ) : kids.length ? (
          <span>Координатор раздаст {kids.length} {kids.length === 1 ? 'подзадачу' : kids.length < 5 ? 'подзадачи' : 'подзадач'}{kidRepos.length ? <> по репозиториям: {kidRepos.join(', ')}</> : null}; каждая в своём рабочем дереве на ветке <span className="mono">{branch}</span>.</span>
        ) : needsRepo ? (
          <span>Выберите, где работать.</span>
        ) : (
          <span>Агент {agentLabel}</span>
        )}
      </div>
      {!kids.length && where.field}
      <label className="field">
        <span>Заметки</span>
        <textarea className="textarea" rows={3} autoFocus placeholder="Необязательно: уточнения к задаче, которые получит агент" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {enabled.length > 1 && (
        <Disclosure className="dialog-more" summary={<span>Ещё: другой агент</span>}>
          <label className="field">
            <span>Агент</span>
            <Select label="Агент" size="lg" value={agent} onChange={setAgent} options={enabled.map((a) => ({ value: a.id, label: a.label, hint: a.id === defaultAgent ? 'по умолчанию' : undefined }))} />
          </label>
        </Disclosure>
      )}
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

function PrDialog({ cwd, base: initBase }: { cwd: string; base?: string }) {
  const tasks = useStore((s) => s.tasks)
  const draftKey = `pr:${normPath(cwd)}|${initBase ?? ''}`
  const [saved] = useState(() => loadDraft<{ title: string; body: string; base: string }>(draftKey)) // typed before closing or a reload
  const [suggest, setSuggest] = useState<GitSuggest | null>(null)
  const [title, setTitle] = useState(saved?.title ?? '')
  const [body, setBody] = useState(saved?.body ?? '')
  const [base, setBase] = useState(saved?.base || initBase || '')
  // Only typed text is a draft; the prefill is fetched again next time.
  const edit = (next: { title?: string; body?: string; base?: string }) => {
    const d = { title, body, base, ...next }
    setTitle(d.title)
    setBody(d.body)
    setBase(d.base)
    saveDraft(draftKey, d)
  }
  const [preview, setPreview] = useState(false)
  const [busy, run, step] = useBusy()

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
      progress={step}
      disabled={!title.trim() || !base.trim() || over}
      wide
      onClose={closeDialog}
      onSubmit={() => run(async (jobId) => {
        const res = await tryApi<{ url: string; existing?: boolean }>('POST', '/git/pr', { cwd, title: title.trim(), body, base: base.trim() }, { jobId })
        if (!res) return
        toast(res.existing ? 'PR уже открыт' : 'Pull request создан', res.existing ? 'info' : 'ok', res.url)
        saveDraft(draftKey, null)
        loadPr(cwd, true)
        closeDialog()
      })}
    >
      <p className="muted" style={{ marginTop: -6 }}>
        {suggest?.branch ? <>Из <span className="mono">{suggest.branch}</span> · {basename(cwd)}</> : basename(cwd)}
      </p>
      <label className="field">
        <span className="row" style={{ justifyContent: 'space-between' }}>Заголовок <ByteCount value={title.trim()} limit={PR_TITLE_BYTES} /></span>
        <input className="input" aria-invalid={bytes(title.trim()) > PR_TITLE_BYTES} value={title} onChange={(e) => edit({ title: e.target.value })} placeholder={suggest ? '' : 'Загрузка…'} />
      </label>
      <div className="field">
        <span className="row" style={{ justifyContent: 'space-between' }}>
          <span id="pr-body-label">Описание <ByteCount value={body} limit={PR_BODY_BYTES} /></span>
          <Segmented size="sm" label="Режим описания" value={preview ? 'view' : 'edit'} onChange={(v) => setPreview(v === 'view')} options={[{ value: 'edit', label: 'Текст' }, { value: 'view', label: 'Просмотр' }]} />
        </span>
        {preview
          ? <div className="md-preview">{body.trim() ? <Markdown text={body} /> : <p className="muted">Пусто</p>}</div>
          : <textarea className="textarea" rows={10} aria-labelledby="pr-body-label" aria-invalid={bytes(body) > PR_BODY_BYTES} value={body} onChange={(e) => edit({ body: e.target.value })} />}
      </div>
      <Disclosure className="dialog-more" summary={<span>Ещё: в ветку <span className="mono">{base || '…'}</span></span>}>
        <label className="field">
          <span>В ветку</span>
          <SuggestInput mono label="Целевая ветка PR" value={base} onChange={(v) => edit({ base: v })} suggestions={[...new Set([suggest?.pr.base, ...targets].filter((t): t is string => !!t))]} />
        </label>
      </Disclosure>
    </Modal>
  )
}

/** «Удалить «…»?» — the chat's history goes with it; a running agent is stopped first. */
function SessionDeleteDialog({ id }: { id: string }) {
  const s = useStore((st) => st.sessions.find((x) => x.id === id))
  const [busy, run, step] = useBusy()
  if (!s) return null
  const running = isLive(s)
  return (
    <Modal title={`Удалить «${s.title || s.id}»?`} submitLabel={running ? 'Остановить и удалить' : 'Удалить'} danger busy={busy} progress={step}
      onClose={closeDialog} onSubmit={() => run(async () => { if (await deleteSession(s)) closeDialog() })}>
      <p>История чата будет удалена. {running ? 'Агент сейчас работает — он будет остановлен.' : 'Если она ещё понадобится, лучше убрать чат в архив.'}</p>
    </Modal>
  )
}

/** Archiving a chat that still works: it is stopped first (PATCH archived + stop: true). */
function SessionArchiveDialog({ id }: { id: string }) {
  const s = useStore((st) => st.sessions.find((x) => x.id === id))
  const [busy, run, step] = useBusy()
  if (!s) return null
  return (
    <Modal title={`Убрать «${s.title || s.id}» в архив?`} submitLabel="Остановить и убрать в архив" busy={busy} progress={step}
      onClose={closeDialog} onSubmit={() => run(async () => { if (await archiveSession(s, true, { stop: true })) closeDialog() })}>
      <p>{s.turnClosing ? 'Агент заканчивает ход' : 'Агент сейчас работает'} — он будет остановлен. История чата сохранится.</p>
    </Modal>
  )
}

/** «Разрешения этого чата»: tool patterns allowed for this chat only (granted from permission cards); × removes one. */
function SessionPermsDialog({ id }: { id: string }) {
  const s = useStore((st) => st.sessions.find((x) => x.id === id))
  if (!s) return null
  const list = s.allowedTools ?? []
  const remove = async (p: string) => {
    const saved = await tryApi<Session>('PATCH', `/sessions/${encodeURIComponent(id)}`, { allowedTools: list.filter((x) => x !== p) })
    if (saved) setState((st) => ({ sessions: upsert(st.sessions, saved) }))
  }
  return (
    <Modal title="Разрешения этого чата" submitLabel="Готово" onClose={closeDialog} onSubmit={closeDialog}>
      {list.length ? (
        <div className="chips-row">{list.map((p) => <Chip key={p} mono onRemove={() => void remove(p)} removeLabel={`Убрать ${p}`}>{p}</Chip>)}</div>
      ) : <p className="muted">Отдельных разрешений нет: действуют общие из настроек агента.</p>}
      <p className="field-hint">Появляются, когда в карточке разрешения выбрано «Разрешать всегда в этой сессии».</p>
    </Modal>
  )
}
