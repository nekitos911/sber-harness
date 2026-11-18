import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, FolderOpen, GitCompareArrows, MessageSquare, Wrench } from 'lucide-react'
import { api, errorText } from '../api'
import { openDialog, openSession, openWorktree, showPanel, toast, useFeature, useStore } from '../store'
import { adoptSession } from '../lib/actions'
import { endJob, startJob, useJobStep } from '../lib/jobs'
import { loadDraft, saveDraft } from '../lib/draft'
import { ago, basename, normPath } from '../lib/format'
import { dur, sessionVisualState, STATE_LABEL, type VisualState } from '../lib/sessionState'
import { useCurrentTool, useTurnStart } from '../lib/live'
import { FULL_ACCESS, modeShort, useSettings } from '../lib/agents'
import { useNow } from '../lib/useNow'
import { listedChat } from '../lib/pending'
import type { Session, Settings, Task } from '../types'
import { StatusIcon } from '../components/bits'
import { CliGlyph } from '../components/Sidebar'
import { Select } from '../components/ui'
import { ModelPicker } from '../components/pickers/ModelPicker'
import { FolderPicker } from '../components/FolderPicker'
import { ReworkPopover } from '../components/board/Rework'
import { TargetsLine } from '../components/ReleaseTargets'
import { SetupView, useSetupNeeded } from './SetupView'

const LINK = /https?:\/\/\S+|\b[A-Z][A-Z0-9_]+-\d+\b/
const REF = /https?:\/\/\S+|[A-Z][A-Z0-9_]+-\d+/
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k] : m))

/**
 * What the agent will get, as the server builds it: a task link/key → the agent's task template («/full-task {taskUrl}{notes}»),
 * anything else → its free-text template. With `handoff-dry-run` the server says it itself (POST /handoff dryRun).
 */
function usePromptPreview(input: string, notes: string, agentId: string, targets: string[]) {
  const settings = useSettings()
  const dryRun = useFeature('handoff-dry-run')
  const [server, setServer] = useState<string | null>(null)
  const text = input.trim()
  useEffect(() => {
    setServer(null)
    if (!dryRun || !text) return
    let live = true
    const t = window.setTimeout(() => {
      api<{ prompt?: string }>('POST', '/handoff', { dryRun: true, input: text, notes: notes.trim() || undefined, agent: agentId || undefined, ...(targets.length ? { targets } : {}) })
        .then((r) => { if (live && r?.prompt) setServer(r.prompt) }, () => undefined)
    }, 300)
    return () => { live = false; window.clearTimeout(t) }
  }, [dryRun, text, notes, agentId, targets.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!text) return ''
  if (server) return server
  const conf = settings?.agents[agentId] as ({ taskPromptTemplate?: string | null; freePromptTemplate?: string | null } | undefined)
  const ref = text.match(REF)?.[0]
  const rest = [ref ? text.replace(ref, '').trim() : '', notes.trim()].filter(Boolean).join(' ')
  if (ref && conf?.taskPromptTemplate) return fill(conf.taskPromptTemplate, { taskUrl: ref, key: ref, title: '', notes: rest ? ` ${rest}` : '' }).trim()
  const free = conf?.freePromptTemplate ?? '{text}{notes}' // the server says the agent's default (settings)
  return fill(free, { text, notes: notes.trim() ? ` ${notes.trim()}` : '' }).trim()
}

/**
 * «Главная»: hand a task to the agent the way the CLI does it (/full-task <link> in the projects folder: the agent picks
 * the repository itself), and see what the agents are doing now.
 */
export function HomeView() {
  // a fresh install: the first-run setup stands in for «Главная» until it is done or skipped
  const setup = useSetupNeeded()
  if (setup) return <div className="home-view"><div className="home-col"><SetupView /></div></div>
  return (
    <div className="home-view">
      <div className="home-col">
        <Handoff />
        <Now />
      </div>
    </div>
  )
}

/** What else an agent can be asked, for people who do not write code (an analyst): a click starts the sentence. */
const EXAMPLES = [
  { label: 'спецификация по SDD', text: 'Подготовь спецификацию по SDD к задаче ' },
  { label: 'объяснить, как устроено', text: 'Объясни простыми словами, как устроено ' },
  { label: 'оценить задачу', text: 'Оцени задачу: что придётся поменять и какие есть риски — ' },
]

function Handoff() {
  const agents = useStore((s) => s.agents)
  const defaultAgent = useStore((s) => s.defaultAgent)
  const workspaces = useStore((s) => s.workspaces)
  const root = workspaces.find((w) => w.kind === 'root')
  const repos = workspaces.filter((w) => !w.kind)
  // where the agent starts: the projects folder; without one (not everyone keeps all projects in one), a project
  const [projectId, setProjectId] = useState<string | null>(null)
  const where = root ?? repos.find((w) => w.id === projectId) ?? (repos.length === 1 ? repos[0] : undefined)
  const settings = useSettings()
  const handoffOn = useFeature('handoff')
  const enabled = agents.filter((a) => a.enabled)
  // the explicit choice, else the default agent (the agents list may arrive after the first render)
  const [picked, setAgentId] = useState<string | null>(null)
  const agentId = picked ?? (enabled.find((a) => a.id === defaultAgent) ?? enabled[0])?.id ?? ''
  const agent = agents.find((a) => a.id === agentId)
  const [model, setModel] = useState<string | null>(null)
  const [mode, setMode] = useState<string | null>(null)
  const [input, setInput] = useState(() => loadDraft<string>('home:input') ?? '')
  const [notes, setNotes] = useState(() => loadDraft<string>('home:notes') ?? '')
  // opens on the first focus and stays (hiding it on blur would move «Запустить» under the pointer mid-click)
  const [notesOpen, setNotesOpen] = useState(false)
  const [job, setJob] = useState<string | null>(null)
  const step = useJobStep(job)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null) // the tracker did not answer: the agent got the text as is
  const [picking, setPicking] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const [targets, setTargets] = useState<string[]>([]) // «Куда»: empty until the text or the person sets it (then sent as is)
  const preview = usePromptPreview(input, notes, agentId, targets)
  const [previewOpen, setPreviewOpen] = useState(false)

  const edit = (v: string) => { setInput(v); saveDraft('home:input', v || null); setError(null) }
  const editNotes = (v: string) => { setNotes(v); saveDraft('home:notes', v || null) }
  const showNotes = notesOpen || !!notes || LINK.test(input)
  // what the line under the box promises: the projects folder and the first word of the task command («/full-task»)
  const command = settings?.agents[agentId]?.taskPromptTemplate?.match(/^\/[\w-]+/)?.[0]
  const effectiveMode = mode ?? agent?.approvalMode ?? null

  const go = async () => {
    const text = input.trim()
    if (!text || job || !where) return
    const id = startJob('Передать агенту', true)
    setJob(id)
    setError(null)
    setNotice(null)
    try {
      const opts = { agent: agentId || undefined, approvalMode: mode ?? undefined, model: model ?? undefined }
      const r = handoffOn
        ? await api<{ session: Session; task: Task | null; jumped?: boolean; trackerError?: string; releaseWarning?: string }>('POST', '/handoff',
          { input: text, notes: notes.trim() || undefined, ...opts, ...(targets.length ? { targets } : {}), ...(root ? {} : { workspaceId: where.id }) }, { jobId: id })
        // older servers: a chat at the projects folder with the text as its first message
        : { session: await api<Session>('POST', '/sessions', { kind: 'chat', cwd: where.path, workspaceId: where.id, prompt: [text, notes.trim()].filter(Boolean).join('\n\n'), ...opts }) }
      if ('trackerError' in r && r.trackerError) setNotice(r.trackerError)
      if ('jumped' in r && r.jumped) toast('Задача уже в работе: открыл текущую сессию')
      if ('releaseWarning' in r && r.releaseWarning) toast(r.releaseWarning, 'info')
      setTargets([])
      edit('')
      editNotes('')
      setNotesOpen(false)
      adoptSession(r.session)
    } catch (e) {
      setError(errorText(e))
    } finally {
      endJob(id)
      setJob(null)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void go() }
  }
  const setRoot = async (path: string) => {
    setPicking(false)
    try { await api<Settings>('PUT', '/settings', { workspaces: { root: path } }) } catch (e) { toast(`Не удалось сохранить папку: ${errorText(e)}`, 'error') }
  }

  return (
    <section className="handoff" aria-label="Передать задачу агенту">
      <h1>Передать задачу агенту</h1>
      <div className="handoff-box" data-busy={!!job || undefined}>
        <textarea ref={box} className="handoff-input" rows={2} autoFocus value={input} disabled={!!job}
          placeholder={`Ссылка или ключ задачи (PROJ-123) или что сделать${command ? `, ${command} добавится сам` : ''}`} aria-label="Задача для агента"
          onChange={(e) => edit(e.target.value)} onKeyDown={onKey} />
        {!input && !job && (
          <p className="handoff-examples"><span>Например:</span>
            {EXAMPLES.map((x) => <button key={x.label} type="button" className="link-btn" onClick={() => { edit(x.text); box.current?.focus() }}>{x.label}</button>)}
          </p>
        )}
        {/* one field on arrival: notes are optional — opened on purpose, or when a saved note exists */}
        {!showNotes && !job && <button type="button" className="link-btn handoff-add-note" onClick={() => setNotesOpen(true)}>＋ заметка для агента</button>}
        {showNotes && (
          <textarea className="handoff-notes" rows={2} value={notes} disabled={!!job} placeholder="Заметки для агента (необязательно)" aria-label="Заметки"
            onChange={(e) => editNotes(e.target.value)} onKeyDown={onKey} />
        )}
        {/* only when it says more than what was typed (a command, the task's text): a copy of the phrase is noise */}
        {preview && preview !== [input.trim(), notes.trim()].filter(Boolean).join(' ') && (
          <button type="button" className="handoff-preview" aria-expanded={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>
            <span className="handoff-preview-label">Будет отправлено:</span>
            <span className="mono handoff-preview-text" data-open={previewOpen || undefined}>{preview}</span>
          </button>
        )}
        <TargetsLine targets={targets} onChange={setTargets} detectText={`${input} ${notes}`} />
        <div className="handoff-bar">
          <Select size="sm" label="Агент" value={agentId} onChange={(v) => { setAgentId(v); setModel(null); setMode(null) }}
            options={enabled.map((a) => ({ value: a.id, label: a.label }))} />
          {agentId && <ModelPicker agentId={agentId} label="Модель" value={model} onChange={setModel} placement="bottom-start" />}
          {agent && agent.approvalModes.length > 0 && (
            <Select size="sm" label="Режим" className={FULL_ACCESS.has(effectiveMode ?? '') ? 'mode-select mode-access' : 'mode-select'} value={effectiveMode ?? ''} onChange={setMode} display={modeShort(effectiveMode ?? '')}
              options={agent.approvalModes.map((m) => ({ value: m, label: modeShort(m), hint: agent.approvalModeLabels?.[m] }))} />
          )}
          {!root && repos.length > 1 && (
            <Select size="sm" label="Проект" placeholder="Выберите проект" value={where?.id ?? ''} onChange={setProjectId}
              options={repos.map((w) => ({ value: w.id, label: w.name }))} />
          )}
          <span className="grow" />
          <button type="button" className="btn btn-primary handoff-go" disabled={!input.trim() || !!job || !where} onClick={() => void go()}>
            {job ? (step ? `${step}…` : 'Запускаю…') : <>Запустить<ArrowUp aria-hidden /></>}
          </button>
        </div>
      </div>
      {root ? (
        <p className="handoff-note">Агент запустится в {basename(root.path)}{command ? <> с <span className="mono">{command}</span></> : null}: сам выберет проект и заведёт для задачи свою ветку.</p>
      ) : where ? (
        <p className="handoff-note">Агент запустится в проекте {where.name}{command ? <> с <span className="mono">{command}</span></> : null} и заведёт для задачи свою ветку.</p>
      ) : repos.length ? (
        <p className="handoff-note">Выберите проект — или укажите папку, где лежат все проекты: тогда агент выберет сам.
          <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}><FolderOpen />Папка со всеми проектами…</button>
        </p>
      ) : (
        <p className="handoff-note handoff-warn">
          Где ваши проекты? Откройте проект, в котором работать, или папку, где лежат все проекты.
          <button type="button" className="btn btn-sm" onClick={() => openDialog({ kind: 'workspace' })}><FolderOpen />Открыть проект…</button>
          <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>Папка со всеми проектами…</button>
        </p>
      )}
      {notice && <p className="handoff-note handoff-warn" role="status">Трекер не ответил ({notice}): агент запущен по тексту.</p>}
      {error && <p className="handoff-error" role="alert">Не удалось запустить: {error}</p>}
      {picking && <FolderPicker title="Папка с проектами" onClose={() => setPicking(false)} onPick={(p) => void setRoot(p)} />}
    </section>
  )
}

const WAIT = new Set<VisualState>(['waiting_answer', 'waiting_permission', 'auth', 'interrupted', 'stalled', 'error'])
const RUN = new Set<VisualState>(['running', 'starting'])
const DAY = 24 * 3600 * 1000

/** «Сейчас»: the handed-off work in three calm groups, one line each. */
function Now() {
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const now = useNow()
  const [moreDone, setMoreDone] = useState(false)
  const groups = useMemo(() => {
    const top = sessions.filter((s) => listedChat(s) && !s.parentId).sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    return {
      wait: top.filter((s) => WAIT.has(sessionVisualState(s))),
      run: top.filter((s) => RUN.has(sessionVisualState(s))),
      done: top.filter((s) => !WAIT.has(sessionVisualState(s)) && !RUN.has(sessionVisualState(s)) && now - s.lastActivityAt < DAY),
    }
  }, [sessions, now])
  const taskOf = (s: Session) => (s.taskId ? tasks.find((t) => t.id === s.taskId) : undefined)
  if (!groups.wait.length && !groups.run.length && !groups.done.length) {
    return <p className="now-empty">Здесь появятся задачи, которые вы передали агентам.</p>
  }
  const done = moreDone ? groups.done : groups.done.slice(0, 5)
  return (
    <div className="now" data-tip-quiet>
      {groups.wait.length > 0 && (
        <section className="now-group" data-g="wait" aria-label="Ждут вас">
          <h2>Ждут вас <span className="num">{groups.wait.length}</span></h2>
          {groups.wait.map((s) => <NowRow key={s.id} s={s} task={taskOf(s)} />)}
        </section>
      )}
      {groups.run.length > 0 && (
        <section className="now-group" aria-label="Работают">
          <h2>Работают <span className="num">{groups.run.length}</span></h2>
          {groups.run.map((s) => <NowRow key={s.id} s={s} task={taskOf(s)} />)}
        </section>
      )}
      {groups.done.length > 0 && (
        <section className="now-group" aria-label="Ответили за сутки">
          <h2>Ответили за сутки <span className="num">{groups.done.length}</span></h2>
          {done.map((s) => <NowRow key={s.id} s={s} task={taskOf(s)} />)}
          {groups.done.length > 5 && (
            <button type="button" className="link now-more" onClick={() => setMoreDone(!moreDone)}>{moreDone ? 'Свернуть' : `Ещё ${groups.done.length - 5}`}</button>
          )}
        </section>
      )}
    </div>
  )
}

function NowRow({ s, task }: { s: Session; task?: Task }) {
  const v = sessionVisualState(s)
  const tool = useCurrentTool(s)
  const start = useTurnStart(s)
  const now = useNow()
  const reworkOn = useFeature('rework')
  const [reworking, setReworking] = useState(false)
  const reworkRef = useRef<HTMLButtonElement>(null)
  // its worktrees: the task's (a start at the projects folder makes them), else the chat's own when it is one
  const lists = useStore((st) => st.worktrees)
  const own = s.worktreePath ? Object.values(lists).flat().find((w) => normPath(w.path) === normPath(s.worktreePath!)) : undefined
  const trees = task?.worktrees?.length ? task.worktrees : own ? [{ path: own.path, dirty: own.dirty ?? 0 }] : []
  const changes = trees.reduce((n, w) => n + (w.dirty ?? 0), 0)
  const since = s.lastEventAt ?? s.lastActivityAt
  const activity = v === 'running' ? (tool ? `Выполняет: ${tool}` : 'думает')
    : v === 'waiting_permission' || v === 'waiting_answer' || v === 'stalled' ? `${STATE_LABEL[v]} ${dur(now - since)}`
      : WAIT.has(v) ? STATE_LABEL[v]
        : task?.status === 'done' || task?.agentState === 'done' || v === 'done' ? 'задача выполнена' : 'ответил'
  const elapsed = RUN.has(v) && start ? dur(now - start) : ago(s.lastActivityAt, now)
  const key = task?.externalId ?? task?.id
  return (
    <div className="now-row" data-s={v} role="button" tabIndex={0} onClick={() => openSession(s.id)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSession(s.id) } }}>
      <StatusIcon session={s} />
      <span className="now-title">
        {key && <span className="mono now-key">{key}</span>}
        {s.origin === 'cli' && <CliGlyph />}
        <span className="ellipsis">{task?.title ?? s.title}</span>
      </span>
      <span className="now-activity ellipsis">{activity}</span>
      <span className="now-meta num">
        {changes > 0 && <span className="now-changes" aria-label={`незакоммиченных изменений: ${changes}`}>±{changes}</span>}
        <span>{elapsed}</span>
      </span>
      <span className="now-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Открыть чат" data-tip="Открыть" onClick={() => openSession(s.id)}><MessageSquare /></button>
        {task && reworkOn && (
          <>
            <button ref={reworkRef} type="button" className="icon-btn icon-btn-sm" aria-label="Доработать" data-tip="Доработать" aria-expanded={reworking} onClick={() => setReworking(true)}><Wrench /></button>
            {reworking && <ReworkPopover task={task} anchor={reworkRef} open onClose={() => setReworking(false)} />}
          </>
        )}
        {trees.length > 0 && (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Изменения" data-tip="Изменения" onClick={() => { openWorktree(trees[0].path); showPanel('changes') }}><GitCompareArrows /></button>
        )}
      </span>
    </div>
  )
}
