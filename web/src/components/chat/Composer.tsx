import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, ChevronUp, Clock, FileText, Pencil, Plus, Square, X } from 'lucide-react'
import { tryApi } from '../../api'
import { getState, setDraft, setState, useFeature, useStore, upsertSession } from '../../store'
import { openFile } from '../WorktreeMenu'
import type { Session } from '../../types'
import { IconButton, Select } from '../ui'
import { MentionMirror, useComposerSuggest } from './Suggest'
import { ModelPicker } from '../pickers/ModelPicker'
import { ContextRing } from './ContextRing'
import { FULL_ACCESS, modeShort, useSettings } from '../../lib/agents'
import { attRef, dropRef, insertRef, withAttachments } from '../../lib/attachments'

/** A file attached to the message being written: its copy at the harness, and a preview for an image. */
interface Att { path: string; name: string; preview: string | null }

function AttFace({ a, n }: { a: Att; n: number }) {
  return a.preview ? <img src={a.preview} alt={a.name} /> : <><FileText aria-hidden /><span className="att-n num">#{n}</span><span className="att-name ellipsis">{a.name}</span></>
}

export function Composer({ session, active }: { session: Session; active: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agent))
  // Draft lives in the store: survives tab switches, remounts and reloads.
  const text = useStore((s) => s.drafts[session.id] ?? '')
  const [sending, setSending] = useState(false)
  const [caret, setCaret] = useState(0)
  const [scroll, setScroll] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null) // «+»: the system's file dialog
  const [atts, setAtts] = useState<Att[]>([])
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

  /**
   * «+» (the system's own file dialog), Ctrl+V with an image, a file dropped on the input: the browser gives the bytes,
   * never the path, so a copy is saved in the chat's folder at the harness. It shows as a card above the input (a thumbnail
   * for an image); the agent gets the paths as a list at the end of the message. Project files are mentioned with @.
   */
  const attach = async (files: File[]) => {
    let n = atts.length
    let at = ref.current?.selectionStart ?? text.length
    for (const f of files) {
      const r = await tryApi<{ path: string }>('POST', `/sessions/${session.id}/attachments?name=${encodeURIComponent(f.name || 'file')}`, f)
      if (!r) return
      const image = f.type.startsWith('image/')
      setAtts((list) => [...list, { path: r.path, name: f.name || 'файл', preview: image ? URL.createObjectURL(f) : null }])
      // «[Изображение №1]» where the caret was (as in Orca): the agent sees which part of the question the file is about
      const cur = getState().drafts[session.id] ?? ''
      const next = insertRef(cur, Math.min(at, cur.length), attRef(++n, image))
      update(next.text)
      at = next.caret
    }
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(at, at); setCaret(at) })
  }
  const unattach = (a: Att) => {
    const i = atts.indexOf(a)
    if (a.preview) URL.revokeObjectURL(a.preview)
    setAtts((list) => list.filter((x) => x !== a))
    if (i >= 0) update(dropRef(getState().drafts[session.id] ?? '', i + 1)) // its mention goes, the later ones renumber
  }
  const canOpen = useFeature('open-file')

  const send = async () => {
    const body = withAttachments(text.trim(), atts.map((a) => a.path))
    if (!body || sending) return
    setSending(true)
    const res = await tryApi<{ queued: boolean }>('POST', `/sessions/${session.id}/messages`, { text: body })
    setSending(false)
    if (!res) return
    update('')
    for (const a of atts) if (a.preview) URL.revokeObjectURL(a.preview)
    setAtts([])
    window.dispatchEvent(new CustomEvent('harness:sent', { detail: session.id })) // the chat scrolls to the bottom
    // queued: the list above the input says so (a toast here covered its «×» on a narrow window)
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
    <div className="composer"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); void attach([...e.dataTransfer.files]) }}>
      <QueueList session={session} />
      {atts.length > 0 && (
        <div className="composer-atts" role="list" aria-label="Вложения">
          {atts.map((a, i) => (
            <div key={a.path} className="att" role="listitem" data-tip={canOpen ? `Открыть: ${a.name}` : a.name} data-img={!!a.preview || undefined}>
              {canOpen
                ? <button type="button" className="att-open" aria-label={`Открыть ${a.name}`} onClick={() => openFile(a.path)}><AttFace a={a} n={i + 1} /></button>
                : <AttFace a={a} n={i + 1} />}
              {a.preview && <span className="att-num">#{i + 1}</span>}
              <button type="button" className="att-x" aria-label={`Убрать ${a.name}`} onClick={() => unattach(a)}><X /></button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-field">
      <MentionMirror text={text} scrollTop={scroll} />
      <textarea
        ref={ref}
        rows={1}
        className="composer-input"
        placeholder={session.waitingFor === 'answer' ? 'Ответ на вопрос агента — здесь или в карточке выше' : running && !session.turnClosing ? 'Сообщение встанет в очередь' : session.status === 'stopped' ? 'Остановлено. Следующее сообщение продолжит работу' : 'Задайте вопрос; @ — файлы, / — команды'}
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
        <button type="button" className="composer-send" onClick={() => void send()} disabled={(!text.trim() && !atts.length) || sending} aria-label={running ? 'Поставить в очередь' : 'Отправить'} data-tip={running ? 'В очередь (Enter)' : 'Отправить (Enter)'}>
          <ArrowUp />
        </button>
      </div>
    </div>
  )
}

/** A message from another agent in the queue, in a line: who, and what (a report: «закончил — done»). */
function agentLine(text: string) {
  const m = /^\[harness\] Message from (.+?) \([^)]*\):\s*([\s\S]*)$/.exec(text)
  if (!m) return <><span className="muted">от агента: </span>{text}</>
  const first = m[2].trim().split('\n').find((l) => l.trim()) ?? ''
  const done = /finished.*with status: (\w+)/.exec(first) || /^(?:Updated result|Result) \((\w+)\)/.exec(first)
  const what = done ? `закончил — ${done[1]}` : first.replace(/^Question:\s*/, 'вопрос: ')
  return <><strong>{m[1]}</strong><span className="muted">: {what}</span></>
}

/**
 * What waits for the agent, above the input: each queued message with «×» to take it back. When nothing runs (the
 * last turn failed before its process started) the queue would wait for the next message — «Отправить сейчас» sends it.
 */
function QueueList({ session }: { session: Session }) {
  const queue = session.queue ?? []
  // folds like a step list: a long queue (agents' reports piling up) starts folded, the header still counts them
  const [open, setOpen] = useState<boolean | null>(null)
  if (!queue.length) return null
  const shown = open ?? queue.length <= 3
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
        <button type="button" className="cq-toggle" aria-expanded={shown} onClick={() => setOpen(!shown)}>
          {shown ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
          <span>{running ? `В очереди: ${queue.length} — уйдёт после текущего шага` : `В очереди: ${queue.length} — агент сейчас не работает`}</span>
        </button>
        {running
          ? <button type="button" className="link-btn" data-tip="Остановить текущий шаг и отправить очередь сразу; контекст сохраняется, помощники доработают и пришлют результат" onClick={() => void tryApi('POST', `/sessions/${session.id}/queue/send`, { interrupt: true })}>Прервать и отправить</button>
          : <button type="button" className="link-btn" onClick={() => void tryApi('POST', `/sessions/${session.id}/queue/send`)}>Отправить сейчас</button>}
      </div>
      {shown && queue.map((q) => (
        <div key={q.id} className="cq-item" role="listitem">
          <Clock aria-hidden />
          <span className="cq-text" data-tip={q.from !== 'user' ? q.text.slice(0, 600) : undefined}>{q.from !== 'user' ? agentLine(q.text) : q.text}</span>
          <span className="cq-actions">
            {q.from === 'user' && <button type="button" className="icon-btn icon-btn-sm" aria-label="Изменить: вернуть в поле ввода" onClick={(e) => void edit(q, e.currentTarget)}><Pencil /></button>}
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Отменить: убрать из очереди" onClick={() => void take(q.id)}><X /></button>
          </span>
        </div>
      ))}
    </div>
  )
}
