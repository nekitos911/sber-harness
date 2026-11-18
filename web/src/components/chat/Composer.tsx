import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Clock, Pencil, Plus, Square, X } from 'lucide-react'
import { tryApi } from '../../api'
import { getState, setDraft, setState, toast, useStore, upsertSession } from '../../store'
import type { Session } from '../../types'
import { IconButton, Select } from '../ui'
import { MentionMirror, useComposerSuggest } from './Suggest'
import { ModelPicker } from '../pickers/ModelPicker'
import { ContextRing } from './ContextRing'
import { FULL_ACCESS, modeShort, useSettings } from '../../lib/agents'

export function Composer({ session, active }: { session: Session; active: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agent))
  // Draft lives in the store: survives tab switches, remounts and reloads.
  const text = useStore((s) => s.drafts[session.id] ?? '')
  const [sending, setSending] = useState(false)
  const [caret, setCaret] = useState(0)
  const [scroll, setScroll] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null) // «+»: the system's file dialog
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
  const suggest = useComposerSuggest({
    input: ref, text, caret, cwd: session.cwd, agentId: session.agent,
    onInsert: (start, end, value) => {
      update(text.slice(0, start) + value + text.slice(end))
      const pos = start + value.length
      requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(pos, pos); setCaret(pos) })
    },
  })

  /** Types `value` at the caret (the @ and / triggers, a picked file, a pasted screenshot's path); the draft is read fresh. */
  const insert = (value: string) => {
    const el = ref.current
    const cur = getState().drafts[session.id] ?? ''
    const at = el ? Math.min(el.selectionStart, cur.length) : cur.length
    const before = cur.slice(0, at)
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    update(`${before}${lead}${value}${cur.slice(at)}`)
    requestAnimationFrame(() => {
      el?.focus()
      const pos = at + lead.length + value.length
      el?.setSelectionRange(pos, pos)
    })
  }

  /**
   * «+» (the system's own file dialog) and Ctrl+V with an image: the browser gives the file's bytes, never its path, so a
   * copy is saved in the chat's folder at the harness and that path goes into the message (quoted when the name has spaces,
   * quotes or brackets). Files of the project are mentioned with @ instead.
   */
  const attach = async (files: File[]) => {
    for (const f of files) {
      const r = await tryApi<{ path: string }>('POST', `/sessions/${session.id}/attachments?name=${encodeURIComponent(f.name || 'file')}`, f)
      if (!r) return
      insert(/^[\p{L}\p{N}_./\\:@+-]+$/u.test(r.path) ? `${r.path} ` : `"${r.path}" `)
    }
    if (files.length) toast(files.length === 1 ? `Приложен ${files[0].name || 'файл'} — агент получит путь к нему` : `Приложено файлов: ${files.length}`)
  }

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    const res = await tryApi<{ queued: boolean }>('POST', `/sessions/${session.id}/messages`, { text: body })
    setSending(false)
    if (!res) return
    update('')
    window.dispatchEvent(new CustomEvent('harness:sent', { detail: session.id })) // the chat scrolls to the bottom
    if (res.queued) toast('Сообщение в очереди — агент получит его после текущего шага')
  }

  const stop = () => void tryApi('POST', `/sessions/${session.id}/stop`)

  const patch = async (fields: Partial<Pick<Session, 'model' | 'approvalMode'>>) => {
    const s = await tryApi<Session>('PATCH', `/sessions/${session.id}`, fields)
    if (s) setState((st) => ({ sessions: upsertSession(st.sessions, s) }))
  }
  const setMode = (approvalMode: string) => patch({ approvalMode })

  const mode = session.approvalMode ?? agent?.approvalMode ?? ''
  // The mode chip is the one place to pick the mode: its options carry the explanations (state, else settings).
  const settings = useSettings()
  const modeLabels = { ...settings?.agents[session.agent]?.approvalModeLabels, ...agent?.approvalModeLabels }
  const modes = agent?.approvalModes ?? (mode ? [mode] : [])

  return (
    <div className="composer">
      <QueueList session={session} />
      <div className="composer-field">
      <MentionMirror text={text} scrollTop={scroll} />
      <textarea
        ref={ref}
        rows={1}
        className="composer-input"
        placeholder={running && !session.turnClosing ? 'Сообщение встанет в очередь' : session.status === 'stopped' ? 'Остановлено. Следующее сообщение продолжит работу' : 'Задайте вопрос; @ — файлы, / — команды'}
        aria-label="Сообщение агенту"
        value={text}
        onChange={(e) => { update(e.target.value); setCaret(e.target.selectionStart) }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        onPaste={(e) => {
          const img = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
          if (!img) return // text pastes as usual
          e.preventDefault()
          void attach([img])
        }}
        onKeyDown={(e) => {
          if (suggest.onKeyDown(e)) return
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() }
        }}
      />
      </div>
      {suggest.popover}
      <div className="composer-bar">
        <IconButton label="Приложить файл" icon={<Plus />} onClick={() => fileInput.current?.click()} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void attach([...(e.target.files ?? [])]); e.target.value = '' }} />
        {modes.length > 0 && (
          <Select
            size="sm"
            label="Режим подтверждений"
            className={FULL_ACCESS.has(mode) ? 'mode-select mode-access' : 'mode-select'}
            placement="top-start"
            value={mode}
            onChange={(m) => void setMode(m)}
            display={session.effectiveApprovalMode && session.effectiveApprovalMode !== mode ? `${modeShort(mode)} → ${modeShort(session.effectiveApprovalMode)}` : modeShort(mode)}
            options={modes.map((m) => ({ value: m, label: modeShort(m), text: modeShort(m), hint: modeLabels[m] }))}
          />
        )}
        <span className="grow" />
        <ModelPicker
          agentId={session.agent}
          openKey={session.id}
          label="Модель"
          value={session.model}
          onChange={(model) => void patch({ model })}
        />
        <ContextRing session={session} running={running} />
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

/**
 * What waits for the agent, above the input: each queued message with «×» to take it back. When nothing runs (the
 * last turn failed before its process started) the queue would wait for the next message — «Отправить сейчас» sends it.
 */
function QueueList({ session }: { session: Session }) {
  const queue = session.queue ?? []
  if (!queue.length) return null
  const running = session.status === 'running'
  const take = async (id: string) => {
    const s = await tryApi<Session>('DELETE', `/sessions/${session.id}/queue/${id}`)
    if (s) setState((st) => ({ sessions: upsertSession(st.sessions, s) }))
    return !!s
  }
  // «Изменить»: out of the queue, back into the input (after what is typed there) to fix and send again
  const edit = async (q: { id: string; text: string }, from: HTMLElement) => {
    const input = from.closest('.composer')?.querySelector<HTMLTextAreaElement>('.composer-input') // this chat's, not another tab's
    if (!(await take(q.id))) return
    const cur = getState().drafts[session.id] ?? ''
    setDraft(session.id, cur.trim() ? `${cur.trimEnd()}
${q.text}` : q.text)
    input?.focus()
  }
  return (
    <div className="composer-queue" role="list" aria-label="Очередь сообщений">
      <div className="cq-head">
        <span>{running ? `В очереди: ${queue.length} — уйдёт после текущего шага` : `В очереди: ${queue.length} — агент сейчас не работает`}</span>
        {!running && <button type="button" className="link-btn" onClick={() => void tryApi('POST', `/sessions/${session.id}/queue/send`)}>Отправить сейчас</button>}
      </div>
      {queue.map((q) => (
        <div key={q.id} className="cq-item" role="listitem">
          <Clock aria-hidden />
          <span className="cq-text">{q.from !== 'user' && <span className="muted">от агента: </span>}{q.text}</span>
          <span className="cq-actions">
            {q.from === 'user' && <button type="button" className="icon-btn icon-btn-sm" aria-label="Изменить: вернуть в поле ввода" onClick={(e) => void edit(q, e.currentTarget)}><Pencil /></button>}
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Отменить: убрать из очереди" onClick={() => void take(q.id)}><X /></button>
          </span>
        </div>
      ))}
    </div>
  )
}
