import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, AtSign, Plus, Slash, Square } from 'lucide-react'
import { tryApi } from '../../api'
import { setDraft, setState, toast, upsert, useStore } from '../../store'
import type { Session } from '../../types'
import { MenuButton, Select } from '../ui'
import { ModelPicker } from '../pickers/ModelPicker'
import { FULL_ACCESS, modeShort } from '../../lib/agents'

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

  const patch = async (fields: Partial<Pick<Session, 'model' | 'approvalMode'>>) => {
    const s = await tryApi<Session>('PATCH', `/sessions/${session.id}`, fields)
    if (s) setState((st) => ({ sessions: upsert(st.sessions, s) }))
  }
  const setMode = (approvalMode: string) => patch({ approvalMode })

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
          <Select
            size="sm"
            label="Режим подтверждений"
            className={FULL_ACCESS.has(mode) ? 'mode-select mode-access' : 'mode-select'}
            placement="top-start"
            value={mode}
            onChange={(m) => void setMode(m)}
            display={modeShort(mode)}
            options={modes.map((m) => ({ value: m, label: modeShort(m), text: modeShort(m), hint: agent?.approvalModeLabels?.[m] ?? m }))}
          />
        )}
        {session.queued > 0 && <span className="chip chip-run">в очереди: {session.queued}</span>}
        <span className="grow" />
        <ModelPicker
          agentId={session.agent}
          openKey={session.id}
          label="Модель"
          value={session.model}
          onChange={(model) => void patch({ model })}
          mode={mode || null}
          onMode={(m) => void setMode(m)}
        />
        {running && (
          <button type="button" className="icon-btn composer-stop" onClick={stop} aria-label="Остановить агента" data-tip="Остановить">
            <Square />
          </button>
        )}
        <button type="button" className="composer-send" onClick={() => void send()} disabled={!text.trim() || sending} aria-label={running ? 'Поставить в очередь' : 'Отправить'} data-tip={running ? 'В очередь (Enter)' : 'Отправить (Enter)'}>
          <ArrowUp />
        </button>
      </div>
    </div>
  )
}
