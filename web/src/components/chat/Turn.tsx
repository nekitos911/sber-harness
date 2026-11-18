import { useMemo, useState, type MouseEvent } from 'react'
import { ChevronRight, CircleHelp, GitCompare, LoaderCircle, ShieldAlert, TriangleAlert, Wrench } from 'lucide-react'
import { tryApi } from '../../api'
import { openTab } from '../../store'
import { basename, normPath, plural } from '../../lib/format'
import { fileEdit, summarizeInput } from '../../lib/toolcall'
import { useElapsed } from '../../lib/live'
import { dur } from '../../lib/sessionState'
import type { DiffLine } from '../../lib/diff'
import type { Message, Session } from '../../types'
import { DiffLines } from '../DiffLines'
import { Disclosure, IconButton } from '../ui'
import { isSubagentTool } from './SubagentCard'
import { isAskTool } from './Attention'
import { longDur, RunImages, StepList } from './ToolSteps'
import { isMcpStatus, toolRunSummary } from '../../lib/toolRun'

/** What the transcript renders: messages, runs of tool calls folded into one line, turn headers and footers, «НОВОЕ». */
export type Item =
  | { kind: 'msg'; key: string; m: Message; until?: number | null; count?: number } // until: when a thought ended; count: a repeated ⚠
  | { kind: 'tools'; key: string; msgs: Message[] }
  | { kind: 'head'; key: string; start: number; end: number | null }
  | { kind: 'files'; key: string; msgs: Message[] }
  | { kind: 'new'; key: string }

const isGroupable = (m: Message) => m.kind === 'tool' && !!m.tool && !isSubagentTool(m.tool) && !isAskTool(m.tool.name)

/**
 * Turns a page of the transcript into items. `runningTurn` is the turn still in progress (or null);
 * `newSince` puts «НОВОЕ» before the first agent message newer than the last time the chat was read.
 */
export function buildItems(list: Message[], runningTurn: number | null, newSince: number | null, lastActivity = 0): Item[] {
  const out: Item[] = []
  let newDone = newSince === null
  const warnings = new Map<string, Extract<Item, { kind: 'msg' }>>() // the same ⚠ again: one line with ×N
  let asked = false // an ask card waits for its answer: the next message of the person is that answer
  let questions = false
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (m.kind === 'system' && isMcpStatus(m.text)) continue // the header chip «MCP 4/5» shows it
    if (m.kind === 'tool' && m.tool && isAskTool(m.tool.name)) asked = true
    if (m.kind === 'question') questions = true
    // The answer given in a question card is shown there («Вы ответили: …»), not again as a bubble.
    if (m.kind === 'user' && (!m.from || m.from === 'user')) {
      const answer = asked || (questions && m.text.startsWith('Ответ на вопрос «'))
      asked = false
      if (answer) continue
    }
    if (m.kind === 'system' && m.text.trim().startsWith('⚠')) {
      const seen = warnings.get(m.text.trim())
      if (seen) { seen.count = (seen.count ?? 1) + 1; continue }
    }
    const prev = list[i - 1]
    const next = list[i + 1]
    if (!newDone && m.at > newSince! && m.kind !== 'user') { out.push({ kind: 'new', key: `new-${m.id}` }); newDone = true }
    // Turn header right after the turn's user message(s), when the turn's start is on this page.
    if (m.kind !== 'user' && prev?.kind === 'user' && prev.turn === m.turn) out.push(...head(list, i - 1, runningTurn, lastActivity))
    if (isGroupable(m)) {
      // A run: tool calls of one turn in a row, with the thoughts between them (not a thought that ends it).
      const run = [m]
      let j = i + 1
      for (;;) {
        let k = j
        while (k < list.length && list[k].kind === 'thought' && list[k].turn === m.turn) k++
        if (k >= list.length || !isGroupable(list[k]) || list[k].turn !== m.turn) break
        run.push(...list.slice(j, k + 1))
        j = k + 1
      }
      i = j - 1
      out.push(run.length > 1 ? { kind: 'tools', key: `tools-${m.id}`, msgs: run } : { kind: 'msg', key: m.id, m })
    } else {
      const item: Extract<Item, { kind: 'msg' }> = { kind: 'msg', key: m.id, m, until: m.kind === 'thought' ? (next ? next.at : m.turn === runningTurn ? null : m.at) : undefined }
      if (m.kind === 'system' && m.text.trim().startsWith('⚠')) warnings.set(m.text.trim(), item)
      out.push(item)
    }
    const after = list[i + 1]
    const turnEnds = !after || after.turn !== list[i].turn
    if (turnEnds && list[i].turn !== runningTurn) {
      const turn = list.filter((x) => x.turn === list[i].turn)
      if (turn.some((x) => x.kind === 'tool' && x.tool?.status !== 'error' && fileEdit(x.tool?.input))) out.push({ kind: 'files', key: `files-${list[i].id}`, msgs: turn })
    }
  }
  // A running turn with only the user's message so far still shows its clock.
  const last = list[list.length - 1]
  if (last?.kind === 'user' && last.turn === runningTurn) out.push(...head(list, list.length - 1, runningTurn, lastActivity))
  return out
}

/**
 * Messages keep their creation time while they stream, so a finished turn's end is its last message's time, or for the
 * latest turn the session's last activity. A finished turn under a second says nothing: no header then.
 */
function head(list: Message[], userIdx: number, runningTurn: number | null, lastActivity: number): Item[] {
  const u = list[userIdx]
  let first = userIdx
  while (first > 0 && list[first - 1].kind === 'user' && list[first - 1].turn === u.turn) first--
  let end = userIdx
  while (end + 1 < list.length && list[end + 1].turn === u.turn) end++
  const start = list[first].at
  if (u.imported) return [] // a recorded CLI chat: its timing is not this harness's
  if (u.turn === runningTurn) return [{ kind: 'head', key: `head-${u.id}`, start, end: null }]
  const stop = end === list.length - 1 ? Math.max(list[end].at, lastActivity) : list[end].at
  return stop - start >= 1000 ? [{ kind: 'head', key: `head-${u.id}`, start, end: stop }] : []
}

/** «Работает 14 с» while the turn runs, «Работал 1 мин 20 с» after. */
export function TurnHead({ start, end }: { start: number; end: number | null }) {
  const sec = useElapsed(start, end === null)
  return <div className="turn-head num">{end === null ? `Работает ${longDur(sec * 1000)}` : `Работал ${longDur(end - start)}`}</div>
}

// ---------- tool runs ----------

/** Consecutive tool calls (and the thoughts between them) as one line; expanding lists every step in order. */
export function ToolRun({ msgs, cwd, live }: { msgs: Message[]; cwd: string; live: boolean }) {
  const tools = msgs.filter((m) => m.tool)
  const running = tools.some((m) => m.tool!.status === 'running')
  const failed = tools.filter((m) => m.tool!.status === 'error').length
  const last = tools[tools.length - 1].tool!
  return (
    <div className="tool-run-wrap">
      <Disclosure
        className="msg tool tool-run"
        chevron="end"
        summary={<>
          <Wrench className="tool-st" data-s={running ? 'running' : undefined} aria-hidden />
          <span className="tool-run-text">{toolRunSummary(tools, running)}</span>
          {failed > 0 && <span className="tool-run-fail">{failed} с ошибкой</span>}
          <span className="tool-sum ellipsis">{last.name} {summarizeInput(last.input)}</span>
        </>}
      >
        <StepList msgs={msgs} live={live} />
      </Disclosure>
      <RunImages msgs={tools} cwd={cwd} />
    </div>
  )
}

// ---------- end of turn: changed files ----------

const editLines = (lines: { kind: ' ' | '+' | '-'; text: string }[]): DiffLine[] =>
  lines.map((l) => ({ kind: l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx', text: l.text, old: null, new: null }))

/** «Изменено 2 файла +12 −3»: every file the turn's edit tools touched; each expands to its diff. */
export function TurnFiles({ msgs, cwd }: { msgs: Message[]; cwd: string }) {
  const files = useMemo(() => {
    const map = new Map<string, { added: number; removed: number; lines: DiffLine[] }>()
    for (const m of msgs) {
      const e = m.kind === 'tool' && m.tool?.status !== 'error' ? fileEdit(m.tool?.input) : null
      if (!e) continue
      const cur = map.get(e.file) ?? { added: 0, removed: 0, lines: [] }
      map.set(e.file, { added: cur.added + e.added, removed: cur.removed + e.removed, lines: [...cur.lines, ...editLines(e.lines)] })
    }
    return [...map.entries()]
  }, [msgs])
  if (!files.length) return null
  const rel = (f: string) => {
    const a = normPath(f)
    const root = normPath(cwd)
    return a.startsWith(`${root}/`) ? f.slice(cwd.replace(/[\\/]+$/, '').length + 1) : f
  }
  const added = files.reduce((a, [, c]) => a + c.added, 0)
  const removed = files.reduce((a, [, c]) => a + c.removed, 0)
  return (
    <section className="turn-files" aria-label="Изменённые файлы">
      <header className="turn-files-head">
        Изменено {files.length} {plural(files.length, 'файл', 'файла', 'файлов')}
        <span className="diff-stat num"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
      </header>
      {files.map(([f, c]) => {
        const path = rel(f)
        const dir = path.includes('/') || path.includes('\\') ? path.slice(0, path.length - basename(path).length) : ''
        return (
          <Disclosure
            key={f}
            className="turn-file"
            summary={<>
              <span className="turn-file-name ellipsis" data-tip={f}><span className="muted">{dir}</span>{basename(f)}</span>
              <span className="diff-stat num"><span className="add">+{c.added}</span> <span className="del">−{c.removed}</span></span>
            </>}
            actions={<IconButton size="sm" label="Открыть дифф" icon={<GitCompare />} onClick={(e: MouseEvent) => { e.preventDefault(); openTab({ kind: 'diff', cwd, path }) }} />}
          >
            <DiffLines lines={c.lines} numbers={false} limit={400} label={`Изменения ${basename(f)}`} />
          </Disclosure>
        )
      })}
    </section>
  )
}

// ---------- live activity of a running turn ----------

/** What the agent is doing right now, from the latest messages of the running turn. */
/**
 * What the agent is doing right now, from the latest messages of the running turn and the last event: a running tool;
 * text that arrived in the last 3 s («Пишет ответ»); a finished answer while the CLI lingers («Завершает ход…»).
 */
export function activityOf(list: Message[], lastEventKind?: string | null, quietMs = 0): { text: string; closing?: boolean } {
  const turn = list.length ? list[list.length - 1].turn : -1
  for (let i = list.length - 1; i >= 0 && list[i].turn === turn; i--) {
    const t = list[i].tool
    if (list[i].kind === 'tool' && t?.status === 'running') return { text: `Выполняет: ${t.name} ${summarizeInput(t.input)}`.slice(0, 140) }
  }
  const last = list[list.length - 1]
  // a thought, or a tool just done: the next step is being worked out
  if (lastEventKind === 'thought' || lastEventKind === 'tool_done') return { text: 'Думает' }
  if (!last || last.kind === 'user' || last.kind === 'thought' || last.kind === 'system') return { text: 'Думает' }
  if (last.kind === 'assistant') {
    // older servers do not say which event came last: a pause after text reads as the end of the turn
    const final = lastEventKind ? lastEventKind === 'assistant_final' || lastEventKind === 'result' : quietMs > 3000
    return final ? { text: 'Завершает ход…', closing: true } : { text: 'Пишет ответ' }
  }
  return { text: 'Работает…' }
}

/** The running turn's latest thought with text (null when the CLI sent none). */
function lastThought(list: Message[]): Message | null {
  const turn = list.length ? list[list.length - 1].turn : -1
  for (let i = list.length - 1; i >= 0 && list[i].turn === turn; i--) if (list[i].kind === 'thought' && list[i].text.trim()) return list[i]
  return null
}

/** Bottom line while the agent works: spinner, activity, and «последнее событие 40 с назад» once it goes quiet. */
export function ActivityLine({ session, list, starting }: { session: Session; list: Message[]; starting: string }) {
  const lastEvent = session.lastEventAt ?? (list.length ? Math.max(list[list.length - 1].at, session.lastActivityAt) : session.lastActivityAt)
  const quiet = useElapsed(lastEvent, true)
  const [open, setOpen] = useState(false) // «Думает» unfolded
  if (session.waitingFor === 'answer' || session.waitingFor === 'permission') {
    const Icon = session.waitingFor === 'answer' ? CircleHelp : ShieldAlert
    // the card may have scrolled far up while the agent kept writing: this line takes you to it
    const jump = (e: MouseEvent) => {
      const cards = e.currentTarget.closest('.chat')?.querySelectorAll<HTMLElement>('section.perm-card, section.ask-card')
      const card = cards?.[cards.length - 1]
      if (!card) return
      card.scrollIntoView({ block: 'center', behavior: 'smooth' })
      card.dataset.flash = ''
      window.setTimeout(() => { delete card.dataset.flash }, 1200)
      card.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true })
    }
    return (
      <div className="chat-working chat-waiting" role="status">
        <button type="button" className="working-toggle" onClick={jump}>
          <Icon aria-hidden />{session.waitingFor === 'answer' ? 'Ждёт вашего ответа — показать вопрос' : 'Ждёт вашего разрешения — показать запрос'}
        </button>
      </div>
    )
  }
  const act = starting ? { text: starting } : activityOf(list, session.lastEventKind, quiet * 1000)
  // A finished answer is not news for half a minute; after that silence is worth saying.
  const showQuiet = !starting && quiet > (act.closing ? 30 : 20)
  // «Думает» opens the turn's latest thought, live, when the CLI sends its reasoning at all
  const thinking = act.text === 'Думает'
  const thought = thinking ? lastThought(list) : null
  return (
    <>
      <div className="chat-working" data-closing={act.closing || undefined} role="status">
        <LoaderCircle className="spinner" aria-hidden />
        {thought
          ? <button type="button" className="working-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{act.text}<ChevronRight className="chev" aria-hidden /></button>
          : <span className="ellipsis">{act.text}</span>}
        {showQuiet && <span className="muted num nowrap">· последнее событие {dur(quiet * 1000)} назад</span>}
        {thinking && !thought && quiet > 10 && <span className="muted nowrap">· агент не присылает ход мыслей</span>}
      </div>
      {thought && open && <div className="thought-text working-thought">{thought.text}</div>}
    </>
  )
}

/** The server marked the run stalled: say so plainly, offer to wait or stop. */
export function StallBanner({ session }: { session: Session }) {
  const [dismissed, setDismissed] = useState<number | null>(null)
  const since = session.lastEventAt ?? session.lastActivityAt
  const sec = useElapsed(since, true)
  if (dismissed === since) return null
  return (
    <div className="chat-alert chat-stall" role="alert">
      <TriangleAlert aria-hidden />
      <span>Нет вывода {dur(sec * 1000)}. Процесс жив, но молчит.</span>
      <span className="grow" />
      <button type="button" className="btn btn-sm" onClick={() => setDismissed(since)}>Подождать</button>
      <button type="button" className="btn btn-sm btn-danger" onClick={() => void tryApi('POST', `/sessions/${session.id}/stop`)}>Остановить</button>
    </div>
  )
}
