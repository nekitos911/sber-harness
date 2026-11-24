import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Archive, ArchiveRestore, Bot, ChevronRight, Ellipsis, LayoutList, MessageSquarePlus, PlugZap, RotateCcw, Search, Square } from 'lucide-react'
import { tryApi } from '../api'
import { openDialog, openSession, openTask, setState, showPanel, useFeature, useStore, useThrottledStore } from '../store'
import { ensureMessages } from '../ws'
import { CliGlyph } from '../components/Sidebar'
import { Branch, StatusIcon } from '../components/bits'
import { Markdown } from '../components/Markdown'
import { SubRow } from '../components/panel/OverviewTab'
import { Checkbox, Chip, MenuButton, Select } from '../components/ui'
import { WaitingItem } from './InboxView'
import { ago, basename, fullTime, normPath, plural } from '../lib/format'
import { useNow } from '../lib/useNow'
import { loadDraft, saveDraft } from '../lib/draft'
import { useCurrentTool, useStateLine } from '../lib/live'
import { waitsForMe } from '../lib/pending'
import { descendants } from '../lib/overview'
import { dur, sessionVisualState, STATE_LABEL } from '../lib/sessionState'
import { archiveMany, archiveSession, reconnectMcp, sessionMenu, stopSession } from '../lib/sessionActions'
import { agentRows, archivable, CAT_LABEL, countCats, groupRows, inFilter, rowMatches, type Cat, type Filter, type GroupBy, type Row } from '../lib/agentsBoard'
import type { Session } from '../types'

const GROUPS: Record<GroupBy, string> = { project: 'Проект', status: 'Статус', none: 'Нет' }
const FILTERS: Filter[] =['all', 'you', 'run', 'fail', 'done', 'archive']
const EMPTY: Record<Filter, string> = {
  all: 'Агентов пока нет', you: 'Никто не ждёт вас', run: 'Сейчас никто не работает', fail: 'Ошибок нет', done: 'Готовых пока нет', archive: 'Архив пуст',
}
const SUMMARY: [Cat, string, string, string][] = [
  ['run', 'работает', 'работают', 'работают'], ['you', 'ждёт вас', 'ждут вас', 'ждут вас'], ['fail', 'ошибка', 'ошибки', 'ошибок'], ['done', 'готов', 'готовы', 'готовы'],
]

/** «Агенты»: every chat as one dense row, its helpers folded under it; what needs the person comes first. */
export function AgentsView() {
  const sessions = useThrottledStore((s) => s.sessions, 500) // a list: twice a second is enough
  const workspaces = useStore((s) => s.workspaces)
  const tasks = useStore((s) => s.tasks)
  const filter = useStore((s) => s.agentsMode)
  const archive = filter === 'archive'
  const [query, setQuery] = useState('')
  const [group, setGroupState] = useState<GroupBy>(() => loadDraft<GroupBy>('agents:group') ?? 'project')
  const setGroup = (g: GroupBy) => { setGroupState(g); saveDraft('agents:group', g) }
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const project = (s: Session) => {
    const ws = workspaces.find((w) => w.id === s.workspaceId)
    return ws ? (ws.kind === 'root' ? basename(ws.path) : ws.name) : 'Вне проектов'
  }
  const taskOf = (s: Session) => (s.taskId ? tasks.find((t) => t.id === s.taskId) : undefined)
  const fields = (s: Session) => {
    const t = taskOf(s)
    return [s.title, project(s), s.branch, basename(s.worktreePath ?? s.cwd), t?.externalId ?? t?.id, t?.title, s.model, s.cliModel, s.agent]
  }

  const rows = useMemo(() => agentRows(sessions, sessionVisualState, (id) => descendants(sessions, id).map((n) => n.s), archive), [sessions, archive])
  const active = useMemo(() => (archive ? agentRows(sessions, sessionVisualState, () => [], false) : rows), [sessions, archive, rows])
  const counts = countCats(active)
  const archivedCount = useMemo(() => sessions.filter((s) => s.kind === 'chat' && !s.virtual && !s.system && s.archived).length, [sessions])
  const shown = rows.filter((r) => inFilter(r, filter) && rowMatches(r, query, fields))
  const groups = groupRows(shown, group, project)
  const flat = groups.flatMap((g) => g.rows)
  const chosen = flat.filter((r) => picked.has(r.s.id))
  const settled = archive ? [] : rows.filter((r) => archivable(r, sessionVisualState))
  const running = chosen.filter((r) => r.s.status === 'running')

  const toggle = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n }
  const pickAll = (on: boolean) => setPicked(on ? new Set(flat.map((r) => r.s.id)) : new Set())
  const bulkArchive = async (list: Row[]) => { await archiveMany(list.map((r) => r.s)); setPicked(new Set()) }
  const bulkRestore = async () => { for (const r of chosen) await archiveSession(r.s, false); setPicked(new Set()) }

  return (
    <div className="agents-view">
      <header className="view-head">
        <h1>Агенты</h1>
        <p className="ag-summary" aria-label="Сводка">
          {SUMMARY.map(([c, one, few, many]) => (
            <span key={c} data-c={c} data-zero={!counts[c] || undefined}><span className="num">{counts[c]}</span> {plural(counts[c], one, few, many)}</span>
          ))}
        </p>
        <span className="grow" />
        <div className="search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder="Название, проект, ветка, задача, модель" aria-label="Поиск агентов" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select size="sm" label="Группировать" value={group} onChange={setGroup} display={`Группы: ${GROUPS[group]}`}
          options={(Object.keys(GROUPS) as GroupBy[]).map((g) => ({ value: g, label: GROUPS[g] }))} />
        <button type="button" className="btn" onClick={() => openDialog({ kind: 'chat' })}>
          <MessageSquarePlus />
          Новый чат…
        </button>
      </header>

      <div className="ag-toolbar">
        <div className="ag-chips" role="group" aria-label="Какие агенты">
          {FILTERS.map((f) => {
            const n = f === 'all' ? active.length : f === 'archive' ? archivedCount : counts[f]
            return <Chip key={f} pressed={filter === f} onClick={() => { setState({ agentsMode: f }); setPicked(new Set()) }}>
              {f === 'all' ? 'Все' : f === 'archive' ? 'Архив' : CAT_LABEL[f]}{n > 0 && <span className="ag-chip-n num">{n}</span>}
            </Chip>
          })}
        </div>
        <span className="grow" />
        {chosen.length > 0 ? (
          <div className="ag-bulk" role="group" aria-label="Действия с выбранными">
            <span className="muted">Выбрано {chosen.length}</span>
            {!archive && <button type="button" className="btn btn-sm" disabled={!running.length} onClick={() => running.forEach((r) => stopSession(r.s))}><Square />Остановить{running.length > 0 && ` ${running.length}`}</button>}
            {archive
              ? <button type="button" className="btn btn-sm" onClick={() => void bulkRestore()}><ArchiveRestore />Вернуть</button>
              : <button type="button" className="btn btn-sm" onClick={() => void bulkArchive(chosen)} data-tip="Работающие пропускаются: сначала остановите"><Archive />В архив</button>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked(new Set())}>Снять выбор</button>
          </div>
        ) : settled.length > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void bulkArchive(settled)} data-tip="Только закончившие: без вопросов, очереди и работающих субагентов">
            <Archive />Архивировать завершённые · {settled.length}
          </button>
        )}
      </div>

      {flat.length === 0 ? (
        <div className="empty">
          <Bot className="empty-icon" aria-hidden />
          <h2>{query.trim() ? 'Ничего не найдено' : EMPTY[filter]}</h2>
          {filter === 'all' && !query.trim() && <>
            <p>Здесь видно, кто работает, кто ждёт вас и что каждый сделал.</p>
            <button type="button" className="btn" onClick={() => openDialog({ kind: 'chat' })}><MessageSquarePlus />Новый чат…</button>
          </>}
        </div>
      ) : (
        <div className="ag-list">
          <div className="ag-row ag-head">
            <Checkbox checked={chosen.length === flat.length} onChange={pickAll}><span className="sr-only">Выбрать все</span></Checkbox>
            <span />
            <span>Агент</span>
            <span className="ag-c-where">Где</span>
            <span className="ag-c-task">Задача</span>
            <span className="ag-c-subs">Субагенты</span>
            <span className="ag-c-model">Модель</span>
            <span className="ag-c-time">Активность</span>
            <span />
          </div>
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label || 'Агенты'}>
              {g.label && <h2 className="ag-group">{g.label} <span className="num muted">{g.rows.length}</span></h2>}
              <div role="list">
                {g.rows.map((r) => (
                  <AgentRow key={r.s.id} r={r} project={project(r.s)} open={open.has(r.s.id)} picked={picked.has(r.s.id)}
                    onOpen={() => setOpen((o) => toggle(o, r.s.id))} onPick={() => setPicked((p) => toggle(p, r.s.id))} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/** ↑/↓ between rows, Enter opens the chat, Space selects, →/← unfold / fold. */
function rowKeys(e: KeyboardEvent<HTMLDivElement>, s: Session, open: boolean, onOpen: () => void, onPick: () => void) {
  if (e.target !== e.currentTarget) return
  const move = (dir: 1 | -1) => {
    const all = [...(e.currentTarget.closest('.ag-list')?.querySelectorAll<HTMLElement>('.ag-row[data-id]') ?? [])]
    all[all.indexOf(e.currentTarget) + dir]?.focus()
  }
  const keys: Record<string, () => void> = {
    ArrowDown: () => move(1), ArrowUp: () => move(-1), Enter: () => openSession(s.id), ' ': onPick,
    ArrowRight: () => { if (!open) onOpen() }, ArrowLeft: () => { if (open) onOpen() },
  }
  const act = keys[e.key]
  if (!act) return
  e.preventDefault()
  act()
}

function AgentRow({ r, project, open, picked, onOpen, onPick }: { r: Row; project: string; open: boolean; picked: boolean; onOpen: () => void; onPick: () => void }) {
  const s = r.s
  const v = sessionVisualState(s)
  const line = useStateLine(s)
  const tool = useCurrentTool(s)
  const now = useNow()
  const task = useStore((st) => (s.taskId ? st.tasks.find((t) => t.id === s.taskId) : undefined))
  const reviveOn = useFeature('revive')
  const reconnectOn = useFeature('agent-reconnect')
  const recoveryOn = useFeature('recovery')
  // what it (or its helper) asks: the question / the command, from its notification
  const who = r.who
  const ask = useStore((st) => {
    const kind = who.waitingFor === 'answer' ? 'question' : who.waitingFor === 'permission' ? 'permission' : null
    let text = '', at = 0
    if (kind) for (const n of st.notifications) if (n.sessionId === who.id && n.kind === kind && n.at > at) { text = n.text; at = n.at }
    return text
  })
  const whoState = STATE_LABEL[sessionVisualState(who)]
  const lastLine = (s.report?.summary || s.preview).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  const doing = who !== s ? `субагент «${who.title}» ${whoState}${ask ? `: ${ask}` : ''}`
    : r.cat === 'you' ? (ask || (v === 'interrupted' && s.interrupted?.lastActivity ? `прервана на: ${s.interrupted.lastActivity}` : whoState))
      : r.cat === 'run' ? [line, tool && `выполняет ${tool}`].filter(Boolean).join(' · ')
        : r.cat === 'fail' ? [whoState, lastLine].filter(Boolean).join(' · ')
          : lastLine
  const place = basename(s.worktreePath ?? s.cwd)
  const model = s.model ?? s.cliModel
  const kidsRunning = r.kids.filter((k) => !k.archived && k.status === 'running').length
  const end = s.status === 'running' ? now : s.finishedAt ?? s.lastActivityAt
  const stop = (e: MouseEvent) => e.stopPropagation()

  return (
    <div role="listitem" className="ag-item" data-open={open || undefined}>
      <div className="ag-row" role="group" data-id={s.id} data-s={v} data-cat={r.cat} data-picked={picked || undefined} tabIndex={0}
        aria-label={`${s.title || s.id}: ${whoState}. Enter — открыть, пробел — выбрать, → — подробности`}
        onClick={onOpen} onKeyDown={(e) => rowKeys(e, s, open, onOpen, onPick)}>
        <span onClick={stop}><Checkbox checked={picked} onChange={onPick}><span className="sr-only">Выбрать «{s.title || s.id}»</span></Checkbox></span>
        <button type="button" className="ag-fold" tabIndex={-1} aria-expanded={open} aria-label={open ? 'Скрыть подробности' : 'Показать подробности'} onClick={(e) => { stop(e); onOpen() }}>
          <ChevronRight className="chev ag-chev" aria-hidden />
        </button>
        <span className="ag-main">
          <span className="ag-title">
            <StatusIcon session={who !== s ? who : s} />
            {s.origin === 'cli' && <CliGlyph />}
            <button type="button" className="ag-name ellipsis" onClick={(e) => { stop(e); openSession(s.id) }} data-tip="Открыть чат">{s.title || s.id}</button>
            {s.queued > 0 && <span className="chip chip-run">в очереди {s.queued}</span>}
          </span>
          {doing && <span className="ag-doing ellipsis" data-s={sessionVisualState(who)} data-tip={doing} data-tip-trunc>{doing}</span>}
        </span>
        <span className="ag-c-where ag-where" data-tip={s.cwd}>
          <span className="ellipsis">{project}{place && place !== project && <span className="muted"> · {place}</span>}</span>
          {s.branch && <Branch name={s.branch} />}
        </span>
        <span className="ag-c-task">
          {task && <button type="button" className="chip chip-mono" onClick={(e) => { stop(e); openTask(task.id) }} data-tip={task.title}>{task.externalId ?? task.id}</button>}
        </span>
        <span className="ag-c-subs num">
          {r.kids.length > 0 && <span data-tip={kidsRunning ? `Работают: ${kidsRunning}` : 'Готово / всего'}>{r.finished}/{r.kids.length} готово{kidsRunning > 0 && <span className="ag-run-dot" aria-label={`работают: ${kidsRunning}`} />}</span>}
        </span>
        <span className="ag-c-model mono ellipsis" data-tip={model ?? undefined}>{model ?? ''}</span>
        <span className="ag-c-time muted num" data-tip={`${fullTime(s.lastActivityAt)} · длительность ${dur(Math.max(0, end - s.createdAt))}`}>{ago(s.lastActivityAt, now)}</span>
        <span className="ag-actions" onClick={stop}>
          {r.cat === 'you' && waitsForMe(who) && !open && <button type="button" className="btn btn-xs" onClick={onOpen}>Ответить</button>}
          {v === 'interrupted' && recoveryOn && <button type="button" className="btn btn-xs" onClick={() => void tryApi('POST', '/recovery/resume', { sessionIds: [s.id] })}><RotateCcw />Продолжить</button>}
          {s.status === 'error' && reviveOn && <button type="button" className="btn btn-xs" onClick={() => void tryApi('POST', `/sessions/${s.id}/revive`)} data-tip="Продолжить с того места, где оборвался"><RotateCcw />Повторить</button>}
          {s.status === 'error' && reconnectOn && <button type="button" className="icon-btn icon-btn-sm" aria-label="Переподключить MCP" data-tip="Переподключить MCP: новый процесс агента, контекст чата сохранится" onClick={() => void reconnectMcp(s)}><PlugZap /></button>}
          {s.status === 'running' && <button type="button" className="icon-btn icon-btn-sm" aria-label="Остановить" data-tip="Остановить" onClick={() => stopSession(s)}><Square /></button>}
          {!s.archived && r.cat === 'done' && <button type="button" className="icon-btn icon-btn-sm ag-quiet" aria-label="В архив" data-tip="В архив" onClick={() => void archiveSession(s)}><Archive /></button>}
          <MenuButton label="Ещё действия" icon={<Ellipsis />} align="right" className="icon-btn-sm" items={[
            { label: 'Открыть Обзор', icon: <LayoutList />, onSelect: () => openOverview(s.id) },
            ...sessionMenu(s),
          ]} />
        </span>
      </div>
      {open && <AgentDetail r={r} />}
    </div>
  )
}

const openOverview = (id: string) => { openSession(id); showPanel('overview') }

/** Under an unfolded row: what waits for the person, the last report, the helpers' tree. */
function AgentDetail({ r }: { r: Row }) {
  const s = r.s
  const sessions = useStore((st) => st.sessions)
  const nodes = useMemo(() => descendants(sessions, s.id), [sessions, s.id])
  const summary = s.report?.summary?.trim()
  useEffect(() => { if (!summary) ensureMessages(s.id) }, [summary, s.id])
  const last = useStore((st) => {
    if (summary) return undefined
    const l = st.messages[s.id]
    for (let i = (l?.length ?? 0) - 1; i >= 0; i--) if (l![i].kind === 'assistant' && l![i].text.trim()) return l![i].text
    return undefined
  })
  const result = summary || last || s.preview.trim()
  const asking = [s, ...nodes.map((n) => n.s)].filter((x) => !x.archived && waitsForMe(x))
  const home = normPath(s.worktreePath || s.cwd)
  return (
    <div className="ag-detail">
      {asking.map((x) => <WaitingItem key={x.id} s={x} />)}
      <section>
        <h3>{summary ? 'Отчёт' : 'Последний ответ'}</h3>
        {result ? <div className="ag-report"><Markdown text={result} /></div> : <p className="muted">Ответа пока нет.</p>}
      </section>
      {nodes.length > 0 && (
        <section>
          <h3>Субагенты и исполнители <span className="muted num">{nodes.length}</span></h3>
          <div className="ov-tree">{nodes.map((n) => <SubRow key={n.s.id} n={n} home={home} />)}</div>
        </section>
      )}
      <div className="ag-detail-foot">
        <button type="button" className="btn btn-sm" onClick={() => openSession(s.id)}>Открыть чат</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => openOverview(s.id)}><LayoutList />Открыть Обзор</button>
      </div>
    </div>
  )
}
