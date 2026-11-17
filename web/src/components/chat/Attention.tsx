import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CircleHelp, Eye, Pencil, Plug, ShieldAlert, SquareTerminal, Wrench } from 'lucide-react'
import { tryApi } from '../../api'
import { useStore } from '../../store'
import { loadDraft, saveDraft } from '../../lib/draft'
import { mcpParts, obj, pathOf, toolKind } from '../../lib/toolRun'
import { summarizeInput } from '../../lib/toolcall'
import type { Message, PermissionOption } from '../../types'
import { Markdown } from '../Markdown'
import { Button, Checkbox, Disclosure } from '../ui'

/** An answer remembered per card (the reply may go to another chat, so the transcript alone cannot tell). */
function useAnswer(key: string, server?: string | null) {
  const [local, setLocal] = useState<string | null>(() => loadDraft<string>(`answered:${key}`))
  const set = (v: string) => { setLocal(v); saveDraft(`answered:${key}`, v) }
  return [server ?? local, set] as const
}

/**
 * «Агент спрашивает»: the question, one-click options (with descriptions; several with checkboxes when multiSelect),
 * and a free-text answer. Once answered it folds to «Вы ответили: …».
 */
export function QuestionCard({ id, text, options, multiSelect, answered, send }: {
  id: string
  text: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
  answered?: string | null
  send: (answer: string) => Promise<boolean>
}) {
  const [answer, setAnswer] = useAnswer(id, answered)
  const [picked, setPicked] = useState<string[]>([])
  const [free, setFree] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const reply = async (v: string) => {
    if (!v.trim() || busy) return
    setBusy(v)
    const ok = await send(v.trim())
    setBusy(null)
    if (ok) setAnswer(v.trim())
  }
  if (answer) {
    return <div className="ask-card ask-done" role="note"><CircleHelp aria-hidden /><span className="ellipsis">Вы ответили: <strong>{answer}</strong></span></div>
  }
  return (
    <section className="ask-card" aria-label="Вопрос агента">
      <header className="ask-head"><CircleHelp aria-hidden />Агент спрашивает</header>
      <div className="ask-text"><Markdown text={text} /></div>
      {options.length > 0 && (multiSelect ? (
        <div className="ask-multi">
          {options.map((o) => (
            <Checkbox key={o.label} checked={picked.includes(o.label)} onChange={(v) => setPicked(v ? [...picked, o.label] : picked.filter((x) => x !== o.label))}>
              {o.label}{o.description && <span className="muted"> — {o.description}</span>}
            </Checkbox>
          ))}
          <Button size="sm" variant="primary" busy={busy !== null} disabled={!picked.length} onClick={() => void reply(picked.join(', '))}>Ответить</Button>
        </div>
      ) : (
        <div className="ask-options" role="group" aria-label="Варианты ответа">
          {options.map((o) => (
            <Button key={o.label} className="ask-option" busy={busy === o.label} disabled={busy !== null && busy !== o.label} onClick={() => void reply(o.label)}>
              <span>{o.label}</span>
              {o.description && <span className="ask-option-desc">{o.description}</span>}
            </Button>
          ))}
        </div>
      ))}
      <form className="ask-free" onSubmit={(e) => { e.preventDefault(); void reply(free) }}>
        <input className="input" aria-label="Свой ответ" placeholder={options.length ? 'Или свой ответ…' : 'Ваш ответ…'} value={free} onChange={(e) => setFree(e.target.value)} />
        <Button type="submit" size="sm" busy={busy === free && !!free} disabled={!free.trim() || busy !== null}>Ответить</Button>
      </form>
    </section>
  )
}

/** The harness `ask` MCP tool (harness.ask / mcp__harness__ask): its question waits in the asking chat. */
export const isAskTool = (name: string) => /^(mcp__)?harness(\.|__)ask$/.test(name)

/** That call as a question card; answered once a later message reached this chat (the reply is delivered there). */
export function AskToolCard({ m }: { m: Message }) {
  const input = obj(m.tool?.input)
  const later = useStore((s) => {
    const list = s.messages[m.sessionId] ?? []
    const i = list.findIndex((x) => x.id === m.id)
    return i < 0 ? null : list.slice(i + 1).find((x) => x.kind === 'user')?.text ?? null
  })
  const options = Array.isArray(input.options) ? input.options.map(String) : []
  return <QuestionCard id={m.id} text={String(input.question ?? summarizeInput(m.tool?.input))} options={options.map((label) => ({ label }))} answered={later}
    send={async (text) => (await tryApi('POST', `/sessions/${encodeURIComponent(m.sessionId)}/messages`, { text })) !== undefined} />
}

/** A question in the transcript: the CLI's own question tool (kind question) or a harness `ask` with options. */
export function MessageQuestion({ m }: { m: Message }) {
  const q = m.question
  const to = m.from && m.from !== 'user' ? m.from : m.sessionId // an `ask` from a worker is answered in that worker
  const post = async (text: string) => (await tryApi('POST', `/sessions/${encodeURIComponent(to)}/messages`, { text })) !== undefined
  if (q) {
    return <QuestionCard id={m.id} text={q.text} options={q.options} multiSelect={q.multiSelect} answered={q.answer}
      send={(a) => post(`Ответ на вопрос «${q.text.split('\n')[0].slice(0, 200)}»: ${a}`)} />
  }
  return <QuestionCard id={m.id} text={m.text} options={(m.options ?? []).map((label) => ({ label }))} send={post} />
}

// ---------- permissions ----------

/** «Выполнить команду: git push origin feature/T-1», «Изменить файл: src/sum.js», «Playwright / click». */
function actionLine(tool: string, input: unknown): { icon: ReactNode; text: string } {
  const i = obj(input)
  switch (toolKind(tool)) {
    case 'shell': return { icon: <SquareTerminal />, text: `Выполнить команду: ${String(i.command ?? i.cmd ?? summarizeInput(input))}` }
    case 'edit': return { icon: <Pencil />, text: `Изменить файл: ${pathOf(input) ?? summarizeInput(input)}` }
    case 'read': return { icon: <Eye />, text: `Прочитать файл: ${pathOf(input) ?? summarizeInput(input)}` }
    case 'mcp': { const [server, name] = mcpParts(tool); return { icon: <Plug />, text: `${server ? `${server} / ` : ''}${name}` } }
    default: return { icon: <Wrench />, text: `${tool}: ${summarizeInput(input)}` }
  }
}

const isReject = (o: PermissionOption) => /reject|deny/i.test(`${o.id} ${o.kind ?? ''}`)
const isOnce = (o: PermissionOption) => /allow_once|^allow$/i.test(o.kind ?? o.id)
const optionLabel = (o: PermissionOption) => o.label ?? o.name ?? o.id

/** How a resolved request reads afterwards. */
function resolvedText(o: PermissionOption | undefined, id: string) {
  if (!o) return id
  if (isReject(o)) return 'Запрещено'
  if (isOnce(o)) return 'Разрешено один раз'
  return /session|always/i.test(`${o.id} ${o.kind ?? ''}`) ? 'Разрешено в этой сессии' : optionLabel(o)
}

/**
 * «Агент запрашивает разрешение»: what it wants to do, why, the full input on demand, and the agent's options
 * (allow once = primary, allow for the session = secondary, reject = danger outline, with an optional note).
 * Enter allows once, Esc moves to «Запретить». Once chosen it folds to «Разрешено один раз» / «Запрещено».
 */
export function PermissionCard({ m }: { m: Message }) {
  const p = m.permission!
  const [choice, setChoice] = useAnswer(m.id, p.choice ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const rejectRef = useRef<HTMLButtonElement>(null)
  const { icon, text } = actionLine(p.tool, p.input)
  const options = p.options
  const primary = options.find(isOnce) ?? options.find((o) => !isReject(o))
  const choose = async (o: PermissionOption) => {
    if (busy) return
    setBusy(o.id)
    const res = await tryApi('POST', `/sessions/${encodeURIComponent(m.sessionId)}/permission`, { permissionId: p.id, optionId: o.id, note: isReject(o) && note.trim() ? note.trim() : undefined })
    setBusy(null)
    if (res !== undefined) setChoice(o.id)
  }
  if (choice) {
    const o = options.find((x) => x.id === choice)
    return (
      <div className="perm-card perm-done" data-rejected={(o && isReject(o)) || undefined} role="note">
        <ShieldAlert aria-hidden /><span className="ellipsis">{resolvedText(o, choice)}: {text}</span>
      </div>
    )
  }
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as Element).matches('textarea, input')) return
    if (e.key === 'Enter' && primary) { e.preventDefault(); void choose(primary) }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); rejectRef.current?.focus() }
  }
  return (
    <section className="perm-card" aria-label="Запрос разрешения" onKeyDown={onKey}>
      <header className="perm-head"><ShieldAlert aria-hidden />Агент запрашивает разрешение</header>
      <div className="perm-action"><span className="perm-icon" aria-hidden>{icon}</span><span className="mono">{text}</span></div>
      {p.reason && <p className="perm-reason muted">{p.reason}</p>}
      <Disclosure className="perm-more" summary={<span>Подробности</span>}>
        <pre>{typeof p.input === 'string' ? p.input : JSON.stringify(p.input, null, 2)}</pre>
      </Disclosure>
      <div className="perm-actions">
        {options.map((o) => (
          <Button
            key={o.id}
            ref={isReject(o) ? rejectRef : undefined}
            size="sm"
            variant={o === primary ? 'primary' : isReject(o) ? 'danger' : 'secondary'}
            className={isReject(o) ? 'btn-outline' : undefined}
            busy={busy === o.id}
            disabled={busy !== null && busy !== o.id}
            onClick={() => void choose(o)}
          >
            {optionLabel(o)}
          </Button>
        ))}
      </div>
      {options.some(isReject) && (
        <input className="input perm-note" aria-label="Комментарий к запрету" placeholder="Почему нет или что сделать вместо (необязательно)" value={note} onChange={(e) => setNote(e.target.value)} />
      )}
    </section>
  )
}
