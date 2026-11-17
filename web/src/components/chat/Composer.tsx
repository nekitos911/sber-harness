import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, AtSign, Plus, Slash, Square } from 'lucide-react'
import { tryApi } from '../../api'
import { setDraft, setState, toast, upsert, useStore } from '../../store'
import type { Session } from '../../types'
import { MenuButton } from '../Menu'

const FULL_ACCESS = new Set(['auto', 'yolo', 'bypassPermissions'])
const MODE_LABEL: Record<string, string> = {
  auto: 'Полный доступ', yolo: 'Полный доступ', bypassPermissions: 'Полный доступ',
  'auto-edit': 'Авто-правки', acceptEdits: 'Авто-правки',
  plan: 'Только план', default: 'С подтверждением',
}
const modeLabel = (m: string) => MODE_LABEL[m] ?? m

export function Composer({ session, active }: { session: Session; active: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agent))
  // Draft lives in the store: survives tab switches, remounts and reloads.
  const text = useStore((s) => s.drafts[session.id] ?? '')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const running = session.status === 'running'

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [text])

  useLayoutEffect(() => { if (active) ref.current?.focus() }, [active])

  const update = (v: string) => setDraft(session.id, v)

  /** The agent CLI understands @file mentions and /commands; the menu just types the trigger for you. */
  const insert = (ch: string) => {
    const el = ref.current
    const at = el ? el.selectionStart : text.length
    const before = text.slice(0, at)
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    update(`${before}${lead}${ch}${text.slice(at)}`)
    requestAnimationFrame(() => {
      el?.focus()
      const pos = at + lead.length + 1
      el?.setSelectionRange(pos, pos)
    })
  }

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    const res = await tryApi<{ queued: boolean }>('POST', `/sessions/${session.id}/messages`, { text: body })
    setSending(false)
    if (!res) return
    update('')
    if (res.queued) toast('Сообщение в очереди — агент получит его после текущего шага')
  }

  const stop = () => void tryApi('POST', `/sessions/${session.id}/stop`)

  const setMode = async (approvalMode: string) => {
    const s = await tryApi<Session>('PATCH', `/sessions/${session.id}`, { approvalMode })
    if (s) setState((st) => ({ sessions: upsert(st.sessions, s) }))
  }

  const mode = session.approvalMode ?? agent?.approvalMode ?? ''
  const modes = agent?.approvalModes ?? (mode ? [mode] : [])

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        className="composer-input"
        placeholder={running ? 'Сообщение встанет в очередь' : session.status === 'stopped' ? 'Остановлено. Следующее сообщение продолжит работу' : 'Задайте вопрос; @ — файлы, / — команды'}
        aria-label="Сообщение агенту"
        value={text}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() }
        }}
      />
      <div className="composer-bar">
        <MenuButton
          label="Вставить"
          icon={<Plus />}
          up
          items={[
            { label: 'Упомянуть файл', hint: '@', icon: <AtSign />, onSelect: () => insert('@') },
            { label: 'Команда агента', hint: '/', icon: <Slash />, onSelect: () => insert('/') },
          ]}
        />
        {modes.length > 0 && (
          <label className={FULL_ACCESS.has(mode) ? 'mode-chip chip-access' : 'mode-chip'} title="Режим подтверждений агента">
            <span aria-hidden>{modeLabel(mode)}</span>
            <select aria-label="Режим подтверждений" value={mode} onChange={(e) => void setMode(e.target.value)}>
              {modes.map((m) => <option key={m} value={m}>{modeLabel(m)} ({m})</option>)}
            </select>
          </label>
        )}
        {session.queued > 0 && <span className="chip chip-run">в очереди: {session.queued}</span>}
        <span className="grow" />
        <ModelField session={session} placeholder="модель" models={agent?.models ?? []} />
        {running && (
          <button type="button" className="icon-btn composer-stop" onClick={stop} aria-label="Остановить агента" title="Остановить">
            <Square />
          </button>
        )}
        <button type="button" className="composer-send" onClick={() => void send()} disabled={!text.trim() || sending} aria-label={running ? 'Поставить в очередь' : 'Отправить'} title={running ? 'В очередь (Enter)' : 'Отправить (Enter)'}>
          <ArrowUp />
        </button>
      </div>
    </div>
  )
}

/** Model override for this chat (the agent's models as suggestions, free text allowed); empty = the agent's default. */
function ModelField({ session, placeholder, models }: { session: Session; placeholder: string; models: string[] }) {
  const listId = useId()
  const [v, setV] = useState(session.model ?? '')
  useEffect(() => setV(session.model ?? ''), [session.model])
  const save = async () => {
    const model = v.trim() || null
    if (model === session.model) return
    const s = await tryApi<Session>('PATCH', `/sessions/${session.id}`, { model })
    if (s) setState((st) => ({ sessions: upsert(st.sessions, s) }))
    else setV(session.model ?? '')
  }
  return (
    <>
    <input
      className="composer-model"
      list={models.length ? listId : undefined}
      aria-label="Модель (пусто — по умолчанию агента)"
      title="Модель (пусто — по умолчанию агента)"
      placeholder={placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
    {models.length > 0 && <datalist id={listId}>{models.map((m) => <option key={m} value={m} />)}</datalist>}
    </>
  )
}
