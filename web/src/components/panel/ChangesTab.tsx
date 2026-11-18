import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, Ellipsis, ExternalLink, File, FileCode, FileJson, FileText, GitBranch, GitPullRequest, Minus, Plus, RotateCcw, Search, Sparkles } from 'lucide-react'
import { api, qs, tryApi } from '../../api'
import { getState, openDialog, openTab, openTask, openWorktree, setState, showPanel, toast, useFeature, useStore } from '../../store'
import { basename, normPath, plural, relTime, shortHash } from '../../lib/format'
import { loadDraft, saveDraft } from '../../lib/draft'
import { gsLetter, refreshGit, splitPath, useGit } from '../../lib/git'
import { useNow } from '../../lib/useNow'
import type { GitCommit, GitFile, GitSuggest, Settings } from '../../types'
import { Disclosure, Menu, type MenuItem } from '../ui'
import { openPrSettings, usePr } from '../../lib/pr'
import { Skeleton } from '../bits'
import { GenerateStatus, useGenerate, type Generated } from '../GenerateMessage'
import { AgentGitLine } from '../AgentGit'
import { currentVia, gitAction, type GitVia } from '../../lib/agentGit'
import { useSettings } from '../../lib/agents'
import { BranchPicker } from '../pickers/BranchPicker'
import { openFolder } from '../WorktreeMenu'
import { flowState } from '../../lib/flow'

// what the agent wrote per change set: a remount (tab switch, panel toggle) shows it again without a new run
const generatedCache = new Map<string, Generated>()

const STATUS_LABEL: Record<GitFile['status'], string> = { M: 'изменён', A: 'добавлен', D: 'удалён', R: 'переименован', '?': 'новый, не в git', U: 'конфликт' }
const TITLE_MAX = 72

/** The message box holds title and body as one text: the first line is the title. */
const split = (msg: string) => { const [t = '', ...rest] = msg.split('\n'); return { title: t.trim(), body: rest.join('\n').trim() } }
const join = (g: { title: string; body: string }) => (g.body ? `${g.title}\n\n${g.body}` : g.title)

/**
 * «Изменения» (like Orca's source control): PR button, file search and «⋯»; the branch with the change totals and its
 * upstream; one message box (✨ writes it); a split «Закоммитить» button; staged and unstaged files; commits folded below.
 */
export function ChangesTab({ cwd }: { cwd: string }) {
  const prEnabled = useStore((s) => s.integrations.pr)
  const prSupported = useFeature('pr-status')
  const stageOn = useFeature('git-stage')
  const git = useGit(cwd)
  const now = useNow()
  const pr = usePr(prEnabled && prSupported ? cwd : null)
  const [suggest, setSuggest] = useState<GitSuggest | null>(null)
  const [log, setLog] = useState<GitCommit[] | null>(null)
  const draftKey = `commit:${normPath(cwd)}`
  const [saved] = useState(() => loadDraft<{ title: string; body: string }>(draftKey)) // typed before a reload
  const [msg, setMsg] = useState(saved ? join(saved) : '')
  const touched = useRef(!!saved) // once the user edits, prefill never overwrites their text
  const generated = useRef(false) // the box holds the agent's text: the template prefill no longer replaces it
  const gen = useGenerate(cwd, 'commit')
  const settings = useSettings()
  const autoGen = gen.on && settings?.git.generateMessages !== false
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)
  const [query, setQuery] = useState<string | null>(null) // null = the search field is closed
  const [menu, setMenu] = useState<'more' | 'split' | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const splitRef = useRef<HTMLButtonElement>(null)
  const commitsKey = `commits:open:${normPath(cwd)}`
  const [commitsOpen, setCommitsOpenState] = useState(() => loadDraft<boolean>(commitsKey) ?? false)
  const setCommitsOpen = (v: boolean) => { setCommitsOpenState(v); saveDraft(commitsKey, v || null) }

  const status = git?.status ?? null
  const filesSig = status?.files.map((f) => f.status + f.path).join('|') ?? ''
  const branch = status?.branch
  const ready = !!status

  // Refetch the prefill and log when the change set or branch changes, not on every status object.
  useEffect(() => {
    if (!ready) return
    let live = true
    api<GitSuggest>('GET', `/git/suggest${qs({ cwd })}`).then((s) => {
      if (!live) return
      setSuggest(s)
      if (!touched.current && !generated.current) setMsg(join(s.commit))
    }, () => undefined)
    api<GitCommit[]>('GET', `/git/log${qs({ cwd, n: 12 })}`).then((l) => { if (live) setLog(l) }, () => undefined)
    return () => { live = false }
  }, [cwd, filesSig, branch, ready])

  // The change set: sorted paths with their status and the diff stat. A new one may get a new message.
  const statSig = git?.files?.map((f) => `${f.added}/${f.removed}`).join(',') ?? ''
  const changeSig = `${normPath(cwd)}|${[...(status?.files ?? [])].filter((f) => !f.service).map((f) => f.status + f.path).sort().join('|')}|${statSig}`
  const hasChanges = (status?.files ?? []).some((f) => !f.service)
  const generate = async (sig: string) => {
    const r = await gen.run()
    if (!r || touched.current) return // never over what the person typed meanwhile
    generatedCache.set(sig, r)
    generated.current = true
    setMsg(join(r))
  }
  // Auto: once per change set, 800 ms after it settles, while the box is untouched and the panel is on screen.
  const askedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!autoGen || !hasChanges || touched.current || askedFor.current === changeSig) return
    const cached = generatedCache.get(changeSig)
    if (cached) { askedFor.current = changeSig; generated.current = true; setMsg(join(cached)); return }
    const t = window.setTimeout(() => {
      if (document.visibilityState !== 'visible' || touched.current) return
      askedFor.current = changeSig
      void generate(changeSig)
    }, 800)
    return () => window.clearTimeout(t)
  }, [autoGen, hasChanges, changeSig]) // eslint-disable-line react-hooks/exhaustive-deps

  if (git?.error) return <LinkedWorktrees cwd={cwd} error={git.error} />
  if (!status) return <div className="wpanel-section"><Skeleton rows={4} /></div>

  const edit = (v: string) => {
    touched.current = true
    if (gen.running) gen.cancel() // typing wins over a message still being written
    setMsg(v)
    saveDraft(draftKey, split(v))
  }
  // the message is committed: the box starts over (a new change set may get a new generated message)
  const committed = () => {
    touched.current = false
    generated.current = false
    saveDraft(draftKey, null)
    setMsg('')
  }

  const files = status.files.filter((f) => !f.service)
  const service = status.files.filter((f) => f.service)
  // staging: only when the server reports it (GitFile.staged) and can change it (feature git-stage); else commit-all
  const staged = stageOn ? files.filter((f) => f.staged) : []
  const unstaged = stageOn ? files.filter((f) => !f.staged) : files
  const { title } = split(msg)
  const via = currentVia()

  // staged: only what is in the index; push: then push (one request, the agent too)
  const commit = async (andPush = false) => {
    setBusy('commit')
    // through the agent (git.via «agent»): its hooks and skills run; the line under the button follows it
    const res = await gitAction<{ hash: string; push?: { summary?: string; output?: string } }>(cwd, 'commit',
      { message: join(split(msg)), ...(staged.length ? { staged: true } : {}), ...(andPush ? { push: true } : {}) }, via, committed)
    setBusy(null)
    if (!res || res === 'agent') return
    toast(`Закоммичено ${shortHash(res.hash)}${res.push ? ` · ${res.push.summary || 'отправлено'}` : ''}`, 'ok')
    committed()
    refreshGit(cwd)
  }
  const push = async () => {
    setBusy('push')
    const res = await gitAction<{ summary?: string; output?: string }>(cwd, 'push', {}, via)
    setBusy(null)
    if (!res || res === 'agent') return
    // «Новая ветка feature/T-2 в origin»; git's own words in the toast's details only
    toast(res.summary || res.output?.trim().split('\n').pop() || 'Отправлено', 'ok')
    refreshGit(cwd)
  }
  // paths, or every change at once ({ all: true }: «Добавить всё в индекс» / «Убрать всё из индекса»)
  const stage = async (paths: string[] | 'all', on: boolean) => {
    if ((await tryApi('POST', `/git/${on ? 'stage' : 'unstage'}`, paths === 'all' ? { cwd, all: true } : { cwd, paths })) !== undefined) refreshGit(cwd)
  }
  const discard = (f: GitFile) => openDialog({
    kind: 'confirm', title: `Отменить изменения в ${splitPath(f.path).name}?`, danger: true, ok: 'Отменить изменения',
    text: f.status === '?' ? `Новый файл ${f.path} будет удалён.` : `Изменения в ${f.path} будут потеряны.`,
    // confirm: true only after this dialog — the server refuses a discard without it
    onConfirm: () => void tryApi('POST', '/git/discard', { cwd, paths: [f.path], confirm: true }).then((r) => { if (r !== undefined) refreshGit(cwd) }),
  })
  const createPr = () => openDialog({ kind: 'pr', cwd, base: suggest?.pr.base ?? undefined })

  // the primary action follows the state: commit the selection, everything, or push what is ahead
  // a branch never pushed (no upstream) is published by the main button too — not hidden under the arrow
  const unpublished = !status.upstream && !!branch && branch !== suggest?.pr.base
  const mode: 'selected' | 'all' | 'push' = staged.length ? 'selected' : files.length || (!status.ahead && !unpublished) ? 'all' : 'push'
  const primaryLabel = busy === 'commit' ? 'Коммит…' : busy === 'push' ? 'Push…'
    : mode === 'selected' ? `Закоммитить выбранные (${staged.length})` : mode === 'push' ? (unpublished ? 'Опубликовать ветку' : `Push ↑${status.ahead}`) : 'Закоммитить всё'
  const primaryDisabled = !!busy || gen.running || (mode === 'push' ? false : !files.length || !title)
  const primary = () => (mode === 'push' ? void push() : void commit())
  const splitItems: MenuItem[] = [
    { label: 'Закоммитить и отправить', disabled: !files.length || !title, onSelect: () => void commit(true) },
    { label: 'Только push', onSelect: () => void push() },
    { label: 'Создать PR', disabled: !prEnabled, onSelect: createPr },
    ...(stageOn ? [
      { label: 'Добавить всё в индекс', divider: true, disabled: !unstaged.length, onSelect: () => void stage('all', true) },
      { label: 'Убрать всё из индекса', disabled: !staged.length, onSelect: () => void stage('all', false) },
    ] : []),
  ]
  const moreItems: MenuItem[] = [
    { label: 'Обновить', onSelect: () => refreshGit(cwd) },
    { label: 'Просмотреть весь дифф', disabled: !files.length, onSelect: () => openTab({ kind: 'diff', cwd, path: null }) },
    { label: 'Открыть папку', onSelect: () => openFolder(cwd) },
    ...(via ? [
      { label: `${via === 'agent' ? '✓ ' : ''}Через агента`, divider: true, hint: 'работают хуки и навыки GigaCode', onSelect: () => void saveVia('agent') },
      { label: `${via === 'harness' ? '✓ ' : ''}Напрямую`, hint: 'git из harness', onSelect: () => void saveVia('harness') },
    ] : []),
  ]
  const q = query?.trim().toLowerCase() ?? ''
  const match = (f: GitFile) => !q || f.path.toLowerCase().includes(q)
  const prInfo = pr && typeof pr === 'object' && 'index' in pr ? pr : null
  const totals = status.totals ?? git?.files?.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 })
  const taskKey = suggest?.taskId ? suggest.key ?? suggest.taskId : null

  return (
    <div className="scm">
      <div className="scm-head">
        {/* «Создать PR» lives in the step strip below (when it is the next step) and the commit menu, never as a dead button */}
        {prInfo && <a className="btn btn-sm" href={prInfo.url} target="_blank" rel="noreferrer noopener" data-tip={prInfo.title}><GitPullRequest />Открыть PR #{prInfo.index}</a>}
        {taskKey && suggest?.taskId && <button type="button" className="chip chip-mono" data-tip="Открыть задачу" onClick={() => openTask(suggest.taskId!)}>{taskKey}</button>}
        <span className="grow" />
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Искать файл" aria-pressed={query !== null} data-tip="Искать в изменённых файлах" onClick={() => setQuery(query === null ? '' : null)}><Search /></button>
        <button ref={moreRef} type="button" className="icon-btn icon-btn-sm" aria-label="Ещё" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}><Ellipsis /></button>
        <Menu anchor={moreRef} open={menu === 'more'} onClose={() => setMenu(null)} items={moreItems} label="Изменения" placement="bottom-end" />
      </div>

      <FlowStrip cwd={cwd} changed={files.length} ahead={status.ahead} upstream={!!status.upstream} branch={branch} base={suggest?.pr.base ?? null}
        pr={prInfo} prEnabled={prEnabled} onCreatePr={createPr} />

      <div className="scm-branch">
        <BranchPicker cwd={cwd} branch={branch} placement="bottom-start" label="Сменить ветку">
          <GitBranch aria-hidden /><span className="mono ellipsis">{branch ?? 'нет ветки'}</span><ChevronDown aria-hidden />
        </BranchPicker>
        {totals && (totals.added > 0 || totals.removed > 0) && (
          <span className="diff-stat num"><span className="add">+{totals.added}</span> <span className="del">−{totals.removed}</span></span>
        )}
      </div>
      {status.upstream && (
        <div className="scm-upstream">
          <ArrowRight aria-hidden /><span className="mono ellipsis">{status.upstream}</span>
          <span className="num muted" data-tip="Впереди / позади upstream">↑{status.ahead} ↓{status.behind}</span>
          {status.webUrl && <a className="icon-btn icon-btn-sm" href={status.webUrl} target="_blank" rel="noreferrer noopener" aria-label="Открыть в репозитории" data-tip="Открыть ветку в репозитории"><ExternalLink /></a>}
        </div>
      )}

      <div className="scm-message" data-generating={gen.running || undefined}>
        <textarea className="textarea" aria-label="Сообщение коммита" placeholder="Сообщение" rows={3} value={msg} disabled={gen.running} onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !primaryDisabled) { e.preventDefault(); primary() } }} />
        {gen.on && (
          <button type="button" className="icon-btn icon-btn-sm scm-gen" aria-label="Сгенерировать сообщение" data-tip="Сгенерировать: GigaCode напишет по изменениям и задаче"
            disabled={gen.running} onClick={() => { touched.current = false; saveDraft(draftKey, null); void generate(changeSig) }}>
            <Sparkles className={gen.running ? 'spinner' : undefined} />
          </button>
        )}
      </div>
      {title.length > TITLE_MAX && <p className="scm-hint">Первая строка — заголовок: <span className="num">{title.length}/{TITLE_MAX}</span>, лучше короче.</p>}
      <GenerateStatus g={gen} onRetry={() => void generate(changeSig)} />

      <div className="split-btn">
        <button type="button" className="btn btn-primary" disabled={primaryDisabled} onClick={primary}>{primaryLabel}</button>
        <button ref={splitRef} type="button" className="btn btn-primary split-more" aria-label="Другие действия" aria-expanded={menu === 'split'} disabled={!!busy}
          onClick={() => setMenu(menu === 'split' ? null : 'split')}><ChevronDown /></button>
        <Menu anchor={splitRef} open={menu === 'split'} onClose={() => setMenu(null)} items={splitItems} label="Коммит и отправка" placement="bottom-end" />
      </div>
      <AgentGitLine cwd={cwd} />

      {query !== null && (
        <input className="input scm-search" autoFocus placeholder="Найти файл" aria-label="Найти в изменённых файлах" value={query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery(null)} />
      )}
      {files.length === 0 && <p className="muted scm-clean">Рабочая копия чистая: агенты здесь ничего не меняли или всё закоммичено.</p>}
      {staged.length > 0 && (
        <FileGroup label="Проиндексировано" files={staged.filter(match)} total={staged.length} cwd={cwd} git={git} staged stageOn={stageOn}
          onAll={() => void stage('all', false)} onStage={(f) => void stage([f.path], false)} onDiscard={discard} />
      )}
      {unstaged.length > 0 && (
        <FileGroup label="Изменения" files={unstaged.filter(match)} total={unstaged.length} cwd={cwd} git={git} stageOn={stageOn}
          onAll={() => void stage('all', true)} onStage={(f) => void stage([f.path], true)} onDiscard={discard} />
      )}
      {service.length > 0 && (
        <Disclosure className="service-files" summary={<span className="muted">Служебные, не коммитятся · {service.length}</span>}>
          <ul className="change-list">{service.map((f) => <ChangeRow key={f.path} cwd={cwd} f={f} git={git} />)}</ul>
        </Disclosure>
      )}

      <section className="scm-group">
        <button type="button" className="scm-group-head" aria-expanded={commitsOpen} onClick={() => setCommitsOpen(!commitsOpen)}>
          <ChevronRight className="chev" aria-hidden />Коммиты{log && <span className="num muted">{log.length}</span>}
        </button>
        {commitsOpen && (log === null ? <Skeleton rows={3} /> : log.length === 0 ? <p className="muted">Коммитов пока нет.</p> : (
          <div>
            {log.map((c) => (
              <div key={c.hash} className="commit-row" data-tip={c.subject}>
                <span className="mono">{shortHash(c.hash)}</span>
                <span className="subject">{c.subject}</span>
                <span className="by">{c.author} · {relTime(c.at, now)}</span>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  )
}

/** git.via, saved in the settings at once (the «⋯» menu). */
async function saveVia(v: GitVia) {
  const settings = getState().settings
  if (!settings) return
  try {
    // only the changed field: a full round-trip of the settings may not validate on every server
    await api<Settings>('PUT', '/settings', { git: { via: v } })
    setState({ settings: { ...settings, git: { ...settings.git, via: v } } })
  } catch (e) {
    toast(`Не удалось сохранить: ${(e as Error).message}`, 'error')
  }
}

type GitData = ReturnType<typeof useGit>

/** «ПРОИНДЕКСИРОВАНО n» / «ИЗМЕНЕНИЯ n»: collapsible, «＋/− всё» and «Просмотреть всё» in the header. */
function FileGroup({ label, files, total, cwd, git, staged = false, stageOn, onAll, onStage, onDiscard }: {
  label: string; files: GitFile[]; total: number; cwd: string; git: GitData; staged?: boolean; stageOn: boolean
  onAll: () => void; onStage: (f: GitFile) => void; onDiscard: (f: GitFile) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="scm-group">
      <div className="scm-group-head-row">
        <button type="button" className="scm-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight className="chev" aria-hidden />{label}<span className="num muted">{total}</span>
        </button>
        <span className="scm-group-actions">
          {stageOn && <button type="button" className="icon-btn icon-btn-sm" aria-label={staged ? 'Убрать всё из индекса' : 'Добавить всё в индекс'} data-tip={staged ? 'Убрать всё из индекса' : 'Добавить всё в индекс'} onClick={onAll}>{staged ? <Minus /> : <Plus />}</button>}
          <button type="button" className="link" onClick={() => openTab({ kind: 'diff', cwd, path: null })}>Просмотреть всё</button>
        </span>
      </div>
      {open && (
        <ul className="change-list">
          {files.map((f) => <ChangeRow key={f.path} cwd={cwd} f={f} git={git} staged={staged} stageOn={stageOn} onStage={() => onStage(f)} onDiscard={() => onDiscard(f)} />)}
        </ul>
      )}
    </section>
  )
}

const ICONS: [RegExp, typeof File][] = [[/\.(tsx?|jsx?|java|kt|py|go|rs|cs|sql|sh|ps1)$/i, FileCode], [/\.(json|ya?ml|toml|xml)$/i, FileJson], [/\.(md|txt|adoc)$/i, FileText]]
const iconOf = (path: string) => ICONS.find(([re]) => re.test(path))?.[1] ?? File
const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn() }

/** A changed file: type icon, name strong + dir muted, +N −M, the coloured status letter; a click opens its diff. */
function ChangeRow({ cwd, f, git, staged = false, stageOn = false, onStage, onDiscard }: {
  cwd: string; f: GitFile; git: GitData; staged?: boolean; stageOn?: boolean; onStage?: () => void; onDiscard?: () => void
}) {
  const { dir, name } = splitPath(f.path)
  const diff = git?.files?.find((d) => d.path === f.path)
  const Icon = iconOf(f.path)
  return (
    <li className="change">
      <div className="change-row" role="button" tabIndex={0} data-tip={`${f.path}: ${STATUS_LABEL[f.status]}`} data-tip-trunc
        onClick={() => openTab({ kind: 'diff', cwd, path: f.path })} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTab({ kind: 'diff', cwd, path: f.path }) } }}>
        <Icon className="change-icon" aria-hidden />
        <span className="change-name">{name}</span>
        {dir && <span className="change-dir"><bdi>{dir}</bdi></span>}
        <span className="change-actions">
          <button type="button" className="icon-btn icon-btn-sm" aria-label={`Открыть ${name}`} data-tip="Открыть файл" onClick={stop(() => openTab({ kind: 'file', cwd, path: f.path }))}><File /></button>
          {stageOn && onDiscard && <button type="button" className="icon-btn icon-btn-sm" aria-label={`Отменить изменения в ${name}`} data-tip="Отменить изменения" onClick={stop(onDiscard)}><RotateCcw /></button>}
          {stageOn && onStage && <button type="button" className="icon-btn icon-btn-sm" aria-label={staged ? `Убрать ${name} из индекса` : `Добавить ${name} в индекс`} data-tip={staged ? 'Убрать из индекса' : 'Добавить в индекс'} onClick={stop(onStage)}>{staged ? <Minus /> : <Plus />}</button>}
        </span>
        <span className="diff-stat num">{(f.added ?? diff?.added) !== undefined ? <><span className="add">+{f.added ?? diff!.added}</span> <span className="del">−{f.removed ?? diff!.removed}</span></> : ''}</span>
        <span className="gs" data-s={f.status} aria-label={STATUS_LABEL[f.status]}>{gsLetter(f.status)}</span>
      </div>
    </li>
  )
}

/**
 * A folder without git (the projects folder): the work happens in worktrees its chats made — the task's worktrees and
 * the ones created by its agents — each with its changes; a click shows that worktree's changes.
 */
function LinkedWorktrees({ cwd, error }: { cwd: string; error: string }) {
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const workspaces = useStore((s) => s.workspaces)
  const lists = useStore((s) => s.worktrees)
  const here = sessions.filter((x) => normPath(x.cwd) === normPath(cwd))
  const ids = new Set(here.map((x) => x.id))
  const rows = new Map<string, { path: string; branch: string | null; repo?: string; dirty?: number | null }>()
  for (const t of tasks.filter((t) => here.some((x) => x.taskId === t.id))) {
    for (const w of t.worktrees ?? []) rows.set(normPath(w.path), { path: w.path, branch: w.branch, repo: workspaces.find((x) => x.id === w.workspaceId)?.name, dirty: w.dirty })
  }
  for (const [wsId, list] of Object.entries(lists)) {
    for (const w of list) {
      if (w.meta?.createdBy !== 'agent' || !ids.has(w.meta.createdBySession ?? '')) continue
      rows.set(normPath(w.path), { path: w.path, branch: w.branch, repo: workspaces.find((x) => x.id === wsId)?.name, dirty: w.dirty })
    }
  }
  const list = [...rows.values()]
  if (!list.length) {
    return (
      <div className="empty">
        <p>Это папка с проектами, а не сам проект. Изменения появятся здесь, когда агент этого чата начнёт работу в одном из проектов.</p>
        <button type="button" className="btn btn-sm" onClick={() => openDialog({ kind: 'workspace', from: cwd })}>Открыть проект…</button>
        <Disclosure summary="Подробности"><p className="mono" style={{ fontSize: 11 }}>{error}</p></Disclosure>
      </div>
    )
  }
  return (
    <div className="wpanel-section">
      <h3>Рабочие деревья этой работы</h3>
      <ul className="linked-wts">
        {list.map((w) => (
          <li key={w.path}>
            <button type="button" className="linked-wt" data-tip={w.path} onClick={() => { openWorktree(w.path); showPanel('changes') }}>
              <span className="ellipsis"><strong>{w.repo ?? basename(w.path)}</strong>{w.branch && <span className="mono muted"> {w.branch}</span>}</span>
              {(w.dirty ?? 0) > 0
                ? <span className="num" data-tip={`${w.dirty} ${plural(w.dirty!, 'изменённый файл', 'изменённых файла', 'изменённых файлов')}`}>±{w.dirty}</span>
                : <span className="muted">без изменений</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Where this worktree is on the way to a merged PR: Коммит → Push → PR → Влит, the current step lit, and one line on what
 * comes next. Its button only where nothing nearby does it (create the PR, clean up once merged); commit and push are the
 * panel's own primary button right below.
 */
function FlowStrip({ cwd, changed, ahead, upstream, branch, base, pr, prEnabled, onCreatePr }: {
  cwd: string; changed: number; ahead: number; upstream: boolean; branch: string | null | undefined; base: string | null
  pr: { state: 'open' | 'merged' | 'declined'; reviewers?: unknown[] } | null; prEnabled: boolean; onCreatePr: () => void
}) {
  // a primitive per selector: a new object from a store selector re-renders forever (React #185)
  const wsId = useStore((s) => Object.entries(s.worktrees).find(([, list]) => list.some((w) => normPath(w.path) === normPath(cwd)))?.[0] ?? null)
  const isMain = useStore((s) => Object.values(s.worktrees).flat().some((w) => !!w.main && normPath(w.path) === normPath(cwd)))
  const place = wsId ? { ws: wsId, main: isMain } : null
  const st = flowState({ changed, ahead, upstream, onBase: !!branch && branch === base, pr, prEnabled })
  if (!branch || !st) return null // the base branch at rest: nothing to walk through
  const cleanup = place && !place.main ? { label: 'Убрать дерево…', run: () => openDialog({ kind: 'wt-delete', workspaceId: place.ws, path: cwd }) } : undefined
  const next: { text: string; action?: { label: string; run: () => void } } = {
    // review first: the diff is one click away, the commit button right below does the rest
    commit: { text: `проверить ${changed} ${plural(changed, 'файл', 'файла', 'файлов')} и закоммитить`, action: { label: 'Посмотреть изменения', run: () => { openTab({ kind: 'diff', cwd, path: null }); setState({ panelOverlay: false }) } } }, // a narrow window: the overlay must not cover the diff
    push: { text: ahead ? `отправить ${ahead} ${plural(ahead, 'коммит', 'коммита', 'коммитов')} в origin` : 'отправить ветку в origin' },
    pushed: { text: 'всё отправлено' },
    'create-pr': { text: 'открыть пулл-реквест', action: { label: 'Создать PR', run: onCreatePr } },
    'pr-off': { text: 'открыть PR — PR-интеграция не настроена', action: { label: 'Настроить', run: openPrSettings } },
    review: { text: (pr?.reviewers?.length ?? 0) > 0 ? 'дождаться ревью и вливания' : 'назначить ревьюеров и дождаться вливания' },
    merged: cleanup ? { text: 'PR влит — рабочее дерево больше не нужно', action: cleanup } : { text: 'PR влит' },
    declined: { text: 'PR отклонён — поправить и создать заново' },
  }[st.next]
  const steps = st.steps
  return (
    <div className="flow" aria-label="Путь до вливания">
      <ol className="flow-steps">
        {steps.map((s) => <li key={s.label} data-state={s.state}>{s.label}</li>)}
      </ol>
      <div className="flow-next">
        <span><span className="muted">Дальше:</span> {next.text}</span>
        {next.action && <button type="button" className="btn btn-sm" onClick={next.action.run}>{next.action.label}</button>}
      </div>
    </div>
  )
}
