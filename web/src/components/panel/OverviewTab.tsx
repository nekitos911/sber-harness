import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Bot, ChevronRight, CircleHelp, ExternalLink, FolderGit2, GitCommitHorizontal, MessageSquare, ShieldAlert, TriangleAlert, User, Workflow } from 'lucide-react'
import { openSession, openTask, openWorktree, useStore } from '../../store'
import { ensureMessages } from '../../ws'
import { basename, fullTime, normPath, plural, ROLE, statusLabel } from '../../lib/format'
import { openChatFileDiff } from '../../lib/git'
import { fileEdit } from '../../lib/toolcall'
import { dur, sessionVisualState } from '../../lib/sessionState'
import { useStateLine } from '../../lib/live'
import { useNow } from '../../lib/useNow'
import { splitAttachments } from '../../lib/attachments'
import { bucket, descendants, firstTask, gotoMessage, places, taskHead, taskText, timeline, type Bucket, type ChatEvent, type TreeNode } from '../../lib/overview'
import type { Message, Session, Task } from '../../types'
import { Branch, Skeleton, StatusIcon } from '../bits'
import { Markdown } from '../Markdown'
import { SERVICE_FILE } from '../chat/Turn'

/** The chat's original task: one line (a command with its task key and title) and its full text without the preamble. */
export function chatTask(m: Message, task?: Task | null) {
  const { text, paths } = splitAttachments(m.text)
  const head = taskHead(text, task ? { key: task.externalId ?? task.id, title: task.title } : null)
  return { head: head || (paths.length ? `Вложений: ${paths.length}` : ''), full: taskText(text) }
}

const WORDS: [Bucket, string, string, string][] = [
  ['run', 'работает', 'работают', 'работают'], ['wait', 'ждёт', 'ждут', 'ждут'], ['fail', 'ошибка', 'ошибки', 'ошибок'],
  ['stop', 'остановлен', 'остановлены', 'остановлены'], ['done', 'готов', 'готовы', 'готовы'],
]

/** «Обзор» of a chat: its task, the helpers it started (and theirs), where they worked, what changed, its key events. */
export function OverviewTab({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId))
  const sessions = useStore((s) => s.sessions)
  const list = useStore((s) => s.messages[sessionId])
  const task = useStore((s) => (session?.taskId ? s.tasks.find((t) => t.id === session.taskId) : undefined))
  useEffect(() => ensureMessages(sessionId), [sessionId])
  const nodes = useMemo(() => descendants(sessions, sessionId), [sessions, sessionId])
  if (!session) return null
  const first = list && firstTask(list)
  const t = first ? chatTask(first, task) : null
  const counts = new Map<Bucket, number>()
  for (const n of nodes) { const b = bucket(sessionVisualState(n.s), n.s.report); counts.set(b, (counts.get(b) ?? 0) + 1) }
  const home = normPath(session.worktreePath || session.cwd)

  return (
    <div className="ov">
      <section className="wpanel-section">
        <h3>Задача</h3>
        {!list ? <Skeleton rows={2} label="Загрузка чата…" />
          : t?.head ? <TaskFold head={t.head} full={t.full} onTop={() => first && gotoMessage(sessionId, first.id)} />
            : <p className="muted">Задачи ещё нет.</p>}
        {task && (
          <div className="ov-task">
            <button type="button" className="chip chip-mono" onClick={() => openTask(task.id)} data-tip="Открыть на доске">{task.externalId ?? task.id}</button>
            <span className="ellipsis grow" data-tip={task.title} data-tip-trunc>{task.title}</span>
            <span className="muted nowrap">{task.externalStatus ?? statusLabel(task.status)}</span>
            {task.externalUrl && <a className="icon-btn icon-btn-sm" href={task.externalUrl} target="_blank" rel="noreferrer noopener" aria-label="Открыть в трекере" data-tip="Открыть в трекере"><ExternalLink /></a>}
          </div>
        )}
      </section>

      <section className="wpanel-section">
        <h3>Субагенты и исполнители{nodes.length > 0 && <span className="muted num">{nodes.length}</span>}</h3>
        {nodes.length === 0 ? <p className="muted">Чат работал сам.</p> : (
          <>
            <p className="ov-counts">
              {WORDS.filter(([b]) => counts.get(b)).map(([b, one, few, many]) => {
                const c = counts.get(b)!
                return <span key={b} data-b={b}>{c} {plural(c, one, few, many)}</span>
              })}
            </p>
            <div className="ov-tree">{nodes.map((n) => <SubRow key={n.s.id} n={n} home={home} />)}</div>
          </>
        )}
      </section>

      <Places sessions={[session, ...nodes.map((n) => n.s)]} />
      {list && <Changes list={list} cwd={session.cwd} />}
      {list && <Timeline list={list} kids={nodes.filter((n) => n.depth === 0).map((n) => n.s)} sessionId={sessionId} sessions={sessions} />}
    </div>
  )
}

/** One line of the task; unfolded: the whole text (scrolls past ~40vh) and «К началу». Shared with the chat's bar. */
export function TaskFold({ head, full, onTop, open: controlled, onToggle }: { head: string; full: string; onTop: () => void; open?: boolean; onToggle?: (open: boolean) => void }) {
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const toggle = () => { setOwn(!open); onToggle?.(!open) }
  return (
    <div className="task-fold" data-open={open || undefined}>
      <button type="button" className="task-fold-head" aria-expanded={open} onClick={toggle} data-tip={open ? 'Свернуть' : 'Показать задачу целиком'}>
        <ChevronRight className="chev" aria-hidden />
        <span className="ellipsis">{head}</span>
      </button>
      {open && (
        <div className="task-fold-body">
          <div className="task-fold-text"><Markdown text={full || head} /></div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onTop}>К началу</button>
        </div>
      )}
    </div>
  )
}

/** A helper: state, model, time, where it worked; its report (or last answer) folds out under it; the title opens it. */
export function SubRow({ n, home }: { n: TreeNode; home: string }) {
  const s = n.s
  const line = useStateLine(s)
  const now = useNow()
  const [open, setOpen] = useState(false)
  const summary = s.report?.summary?.trim()
  // its transcript is fetched only when the row is unfolded and it has no report
  const last = useStore((st) => {
    if (!open || summary) return undefined
    const l = st.messages[s.id]
    for (let i = (l?.length ?? 0) - 1; i >= 0; i--) if (l![i].kind === 'assistant' && l![i].text.trim()) return l![i].text
    return undefined
  })
  const fold = () => { if (!open && !summary) ensureMessages(s.id); setOpen(!open) }
  const place = s.worktreePath || s.cwd
  const end = s.status === 'running' ? now : s.finishedAt ?? s.report?.at ?? s.lastActivityAt
  const model = s.model ?? s.cliModel
  const result = summary || last || s.preview.trim()
  const role = s.virtual ? 'GigaCode' : s.ephemeral ? 'субагент' : s.role !== 'solo' ? ROLE[s.role] : null
  return (
    // archived (a settled one-off helper leaves the sidebar): still here, muted, its chat opens read-only
    <div className="ov-sub" data-archived={s.archived || undefined} style={{ '--depth': n.depth } as CSSProperties}>
      <div className="ov-sub-row">
        <button type="button" className="ov-fold" aria-expanded={open} aria-label={open ? 'Скрыть отчёт' : 'Показать отчёт'} onClick={fold}><ChevronRight className="chev" aria-hidden /></button>
        <StatusIcon session={s} />
        <button type="button" className="ov-sub-title ellipsis" onClick={() => openSession(s.id)} data-tip={`Открыть чат «${s.title}»`}>
          {role && <span className="role-tag">{role}</span>}{s.title}{s.archived && <span className="muted"> · в архиве</span>}
        </button>
        <span className="muted num nowrap">{line || dur(Math.max(0, end - s.createdAt))}</span>
      </div>
      {open && (
        <div className="ov-sub-body">
          <div className="ov-meta muted">
            {model && <span className="mono">{model}</span>}
            <span className="num">{dur(Math.max(0, end - s.createdAt))}</span>
            {normPath(place) !== home && <button type="button" className="link-file mono" onClick={() => openWorktree(place)} data-tip={place}>{basename(place)}</button>}
            {s.branch && <Branch name={s.branch} />}
            <span className="grow" />
            <button type="button" className="link-file" onClick={() => openSession(s.id)}>Открыть чат</button>
          </div>
          {result ? <div className="ov-report"><Markdown text={result} /></div> : <p className="muted">Отчёта пока нет.</p>}
        </div>
      )}
    </div>
  )
}

function Places({ sessions }: { sessions: Session[] }) {
  const list = places(sessions)
  return (
    <section className="wpanel-section">
      <h3>Где работали</h3>
      <div className="ov-list">
        {list.map((p) => (
          <button key={p.path} type="button" className="ov-row" onClick={() => openWorktree(p.path)} data-tip={`${p.path}\nОткрыть рабочее дерево`}>
            <FolderGit2 aria-hidden />
            <span className="mono ellipsis">{basename(p.path)}</span>
            {p.branch && <Branch name={p.branch} />}
            <span className="grow" />
            <span className="muted num nowrap">{p.sessions} {plural(p.sessions, 'чат', 'чата', 'чатов')}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** Files the chat's edit tools changed (as in «Изменено N файлов»), each once with its +/−; click opens the diff. */
export function Changes({ list, cwd }: { list: Message[]; cwd: string }) {
  const files = useMemo(() => {
    const map = new Map<string, { file: string; added: number; removed: number }>()
    for (const m of list) {
      const e = m.kind === 'tool' && m.tool?.status !== 'error' ? fileEdit(m.tool?.input) : null
      if (!e || SERVICE_FILE.test(e.file)) continue
      const k = normPath(e.file)
      const cur = map.get(k) ?? { file: e.file, added: 0, removed: 0 }
      map.set(k, { ...cur, added: cur.added + e.added, removed: cur.removed + e.removed })
    }
    return [...map.values()]
  }, [list])
  const root = normPath(cwd)
  const rel = (f: string) => (normPath(f).startsWith(`${root}/`) ? f.slice(cwd.replace(/[\\/]+$/, '').length + 1) : f)
  return (
    <section className="wpanel-section">
      <h3>Изменения{files.length > 0 && <span className="muted num">{files.length}</span>}</h3>
      {files.length === 0 ? <p className="muted">Файлы не менялись.</p> : (
        <div className="ov-list">
          {files.map((f) => (
            <button key={f.file} type="button" className="ov-row" onClick={() => void openChatFileDiff(cwd, f.file)} data-tip={`Открыть дифф ${f.file}`}>
              <span className="ellipsis grow"><span className="muted">{rel(f.file).slice(0, -basename(f.file).length)}</span>{basename(f.file)}</span>
              <span className="diff-stat num"><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

const EVENT_ICON: Record<ChatEvent['kind'], typeof User> = {
  user: User, harness: Workflow, agent: MessageSquare, error: TriangleAlert, question: CircleHelp, permission: ShieldAlert,
  git: GitCommitHorizontal, 'sub-start': Bot, 'sub-end': Bot,
}
const HHMM = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }) // one formatter, not one per event
const hhmm = (at: number) => HHMM.format(at)

function Timeline({ list, kids, sessionId, sessions }: { list: Message[]; kids: Session[]; sessionId: string; sessions: Session[] }) {
  const events = useMemo(() => timeline(list, kids), [list, kids])
  const who = (e: ChatEvent) => {
    switch (e.kind) {
      case 'user': return 'Вы'
      case 'harness': return 'Harness'
      case 'agent': return sessions.find((x) => x.id === e.from)?.title ?? 'Агент'
      case 'error': return 'Ошибка'
      case 'question': return 'Вопрос'
      case 'permission': return 'Разрешение'
      case 'git': return 'Git'
      case 'sub-start': return 'Запущен'
      case 'sub-end': {
        const s = kids.find((x) => x.id === e.sessionId)
        return s && bucket(sessionVisualState(s), s.report) === 'fail' ? 'Ошибка' : 'Закончил'
      }
    }
  }
  return (
    <section className="wpanel-section">
      <h3>Хронология</h3>
      {events.length === 0 ? <p className="muted">Пока пусто.</p> : (
        <ol className="ov-events">
          {events.map((e) => <TimelineRow key={e.key} e={e} who={who(e)} sessionId={sessionId} />)}
        </ol>
      )}
    </section>
  )
}

// the panel redraws on every event of every agent; an event already listed has nothing new to draw
const TimelineRow = memo(function TimelineRow({ e, who, sessionId }: { e: ChatEvent; who: string; sessionId: string }) {
  const Icon = EVENT_ICON[e.kind]
  const go = () => (e.messageId ? gotoMessage(sessionId, e.messageId) : e.sessionId && openSession(e.sessionId))
  return (
    <li>
      <button type="button" className="ov-event" data-k={e.kind} onClick={go} data-tip={fullTime(e.at)}>
        <span className="muted num">{hhmm(e.at)}</span>
        <Icon aria-hidden />
        <span className="ellipsis"><strong>{who}</strong>{e.text && <span className="muted"> · {e.text}</span>}</span>
      </button>
    </li>
  )
}, (p, n) => p.who === n.who && p.sessionId === n.sessionId && p.e.key === n.e.key && p.e.kind === n.e.kind && p.e.at === n.e.at &&
  p.e.text === n.e.text && p.e.messageId === n.e.messageId && p.e.sessionId === n.e.sessionId) // events are rebuilt on each change: compare what is drawn
