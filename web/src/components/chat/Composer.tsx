import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { tryApi } from '../../api'
import { setState, toast, upsert, useStore } from '../../store'
import type { Session } from '../../types'

const drafts = new Map<string, string>() // survives tab switches and remounts

const FULL_ACCESS = new Set(['yolo', 'bypassPermissions'])
const MODE_LABEL: Record<string, string> = {
  yolo: 'Полный доступ', bypassPermissions: 'Полный доступ',
  'auto-edit': 'Авто-правки', acceptEdits: 'Авто-правки',
  plan: 'Только план', default: 'С подтверждением',
}
const modeLabel = (m: string) => MODE_LABEL[m] ?? m

export function Composer({ session, active }: { session: Session; active: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agent))
  const [text, setText] = useState(() => drafts.get(session.id) ?? '')
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

  const update = (v: string) => {
    setText(v)
    drafts.set(session.id, v)
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
        placeholder={running ? 'Сообщение встанет в очередь' : 'Задайте вопрос или опишите задачу'}
        aria-label="Сообщение агенту"
        value={text}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() }
        }}
      />
      <div className="composer-bar">
        {modes.length > 0 && (
          <label className={FULL_ACCESS.has(mode) ? 'mode-chip chip-access' : 'mode-chip'} title="Режим подтверждений агента">
            <span className="sr-only">Режим подтверждений</span>
            <select value={mode} onChange={(e) => void setMode(e.target.value)}>
              {modes.map((m) => <option key={m} value={m}>{modeLabel(m)} ({m})</option>)}
            </select>
          </label>
        )}
        {session.queued > 0 && <span className="chip chip-run">в очереди: {session.queued}</span>}
        <span className="grow" />
        <span className="mono muted composer-model" title="Агент / модель">{session.model ?? agent?.label ?? session.agent}</span>
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
