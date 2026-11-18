import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, AtSign, FolderOpen, Plus, Slash, Square } from 'lucide-react'
import { tryApi } from '../../api'
import { getState, setDraft, setState, toast, useStore, upsertSession } from '../../store'
import type { Session } from '../../types'
import { MenuButton, Select } from '../ui'
import { MentionMirror, useComposerSuggest } from './Suggest'
import { ModelPicker } from '../pickers/ModelPicker'
import { ContextRing } from './ContextRing'
import { FULL_ACCESS, modeShort, useSettings } from '../../lib/agents'
import { pathFor } from '../../lib/agentComment'
import { normPath } from '../../lib/format'
import { FolderPicker } from '../FolderPicker'

export function Composer({ session, active }: { session: Session; active: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agent))
  // Draft lives in the store: survives tab switches, remounts and reloads.
  const text = useStore((s) => s.drafts[session.id] ?? '')
  const [sending, setSending] = useState(false)
  const [caret, setCaret] = useState(0)
  const [scroll, setScroll] = useState(0)
  const [picking, setPicking] = useState(false) // «Файл с диска…»
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

  /** «Файл с диска…»: @path as the chat sees it; a file outside the chat's folders opens its folder to the agent too. */
  const mentionFile = async (file: string) => {
    setPicking(false)
    const sees = (d: string) => normPath(file).startsWith(`${normPath(d)}/`)
    if (!sees(session.cwd) && !(session.includeDirs ?? []).some(sees)) {
      const dir = file.replace(/[\\/][^\\/]*$/, '')
      const s = await tryApi<Session>('PATCH', `/sessions/${session.id}`, { includeDirs: [...(session.includeDirs ?? []), dir] })
      if (!s) return
      setState((st) => ({ sessions: upsertSession(st.sessions, s) }))
      toast(`Агенту открыта папка ${dir}`)
    }
    insert(`@${pathFor(session.cwd, file).replace(/ /g, '\\ ')} `)
  }

  /** Ctrl+V with an image: saved in the chat's folder at the harness, its path goes into the message. */
  const pasteImage = async (img: File) => {
    const r = await tryApi<{ path: string }>('POST', `/sessions/${session.id}/attachments`, img)
    if (!r) return
    insert(`${r.path} `)
    toast('Скриншот сохранён — агент получит путь к нему')
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
          void pasteImage(img)
        }}
        onKeyDown={(e) => {
          if (suggest.onKeyDown(e)) return
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() }
        }}
      />
      </div>
      {suggest.popover}
      {picking && <FolderPicker files title="Файл для агента" submitLabel="Упомянуть файл" initial={session.cwd} onPick={(f) => void mentionFile(f)} onClose={() => setPicking(false)} />}
      <div className="composer-bar">
        <MenuButton
          label="Вставить"
          icon={<Plus />}
          up
          items={[
            { label: 'Упомянуть файл', hint: '@', icon: <AtSign />, onSelect: () => insert('@') },
            { label: 'Файл с диска…', icon: <FolderOpen />, onSelect: () => setPicking(true) },
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
            display={session.effectiveApprovalMode && session.effectiveApprovalMode !== mode ? `${modeShort(mode)} → ${modeShort(session.effectiveApprovalMode)}` : modeShort(mode)}
            options={modes.map((m) => ({ value: m, label: modeShort(m), text: modeShort(m), hint: modeLabels[m] }))}
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
