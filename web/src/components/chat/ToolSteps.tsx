import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, Brain, Check, Eye, LoaderCircle, Pencil, Plug, Search, Sparkles, SquareTerminal, Wrench, X } from 'lucide-react'
import { apiBlobUrl, qs } from '../../api'
import { openSession, useFeature } from '../../store'
import { basename } from '../../lib/format'
import { mcpParts, obj, pathOf, runImages, toolKind } from '../../lib/toolRun'
import { emptyInput, fileEdit, summarizeInput } from '../../lib/toolcall'
import { useElapsed } from '../../lib/live'
import { dur } from '../../lib/sessionState'
import type { DiffLine } from '../../lib/diff'
import type { Message, ToolCall } from '../../types'
import { DiffLines } from '../DiffLines'
import { openFile } from '../WorktreeMenu'
import { Disclosure } from '../ui'
import { isSubagentTool } from './SubagentCard'

/** 14 с · 1 мин 20 с · 2 ч 5 мин */
export function longDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} мин ${s % 60} с` : `${m} мин`
  return `${Math.floor(m / 60)} ч ${m % 60} мин`
}

/** A thought, folded: «Размышлял 11 с» (live while thinking); the text is one click away. */
export function ThoughtBlock({ m, until }: { m: Message; until: number | null }) {
  const sec = useElapsed(m.at, until === null)
  const ms = until === null ? sec * 1000 : until - m.at
  return (
    <Disclosure className="msg msg-thought" summary={<><Brain className="thought-icon" aria-hidden />{until === null ? 'Размышляет' : 'Размышлял'}{(until === null || ms >= 1000) && <span className="num">{longDur(ms)}</span>}</>}>
      <div className="thought-text">{m.text}</div>
    </Disclosure>
  )
}

function stepLine(t: ToolCall): { icon: ReactNode; text: ReactNode } {
  const input = obj(t.input)
  // the model called GigaCode's tool bridge without saying which tool: nothing ran (not «tool без аргументов»)
  if (/tool_call bridge refused/i.test(t.output ?? '')) return { icon: <Wrench />, text: <>Вызов без имени инструмента <span className="muted">— GigaCode отклонил, ничего не выполнено (ошибка модели)</span></> }
  if (isSubagentTool(t) || toolKind(t.name) === 'agent') {
    const type = [input.subagent_type, input.profile].find((x) => typeof x === 'string' && x) as string | undefined
    const what = [input.description, input.title, input.prompt, input.spec].find((x) => typeof x === 'string' && x.trim()) as string | undefined
    return { icon: <Bot />, text: <>Субагент{type ? ` ${type}` : ''}{what && <span className="muted">: {what.split('\n')[0].slice(0, 160)}</span>}</> }
  }
  if (/^(skill|activate_skill|use_skill)$/i.test(t.name)) return { icon: <Sparkles />, text: <>Навык {String(input.skill ?? input.name ?? '')}</> }
  const file = pathOf(t.input)
  const now = t.status === 'running' // «Читает» while it runs, «Прочитано» once done
  switch (toolKind(t.name)) {
    case 'read': return { icon: <Eye />, text: <>{now ? 'Читает' : 'Прочитано'} <span className="mono">{file ? basename(file) : summarizeInput(t.input)}</span></> }
    case 'edit': {
      const e = fileEdit(t.input)
      return { icon: <Pencil />, text: <>{now ? 'Изменяет' : 'Изменено'} <span className="mono">{file ? basename(file) : summarizeInput(t.input)}</span>{e && <span className="diff-stat num"> <span className="add">+{e.added}</span> <span className="del">−{e.removed}</span></span>}</> }
    }
    case 'shell': return { icon: <SquareTerminal />, text: <span className="mono">{String(input.command ?? input.cmd ?? (summarizeInput(t.input) || t.name))}</span> } // no arguments yet: at least the tool
    case 'search': return { icon: <Search />, text: <>Поиск <span className="mono">{String(input.pattern ?? input.query ?? summarizeInput(t.input))}</span></> }
    case 'mcp': {
      const [server, tool] = mcpParts(t.name)
      const args = JSON.stringify(t.input ?? {})
      return { icon: <Plug />, text: <>{server && `${server} / `}{tool} <span className="mono muted">{args === '{}' ? '' : args.slice(0, 160)}</span></> }
    }
    default: return { icon: <Wrench />, text: <><span className="mono">{t.name}</span> <span className="muted">{summarizeInput(t.input)}</span></> }
  }
}

/** A sub-agent's chat: the built-in one's virtual chat, or a harness worker's (worker_run / agent answer `{ sessionId }`). */
const subChat = (t: ToolCall) => t.subSessionId
  ?? (/(^|__)(worker_run|worker_start|agent)$/.test(t.name) && t.output ? /"sessionId"\s*:\s*"([^"]+)"/.exec(t.output)?.[1] ?? null : null)

const editLines = (e: NonNullable<ReturnType<typeof fileEdit>>): DiffLine[] =>
  e.lines.map((l) => ({ kind: l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx', text: l.text, old: null, new: null }))

/** What was asked (a diff for edits, the command for shells, JSON otherwise), what came back, how long, ✓/✗. */
function StepDetails({ t, ms }: { t: ToolCall; ms: number | null }) {
  const [all, setAll] = useState(false)
  const e = toolKind(t.name) === 'edit' ? fileEdit(t.input) : null
  const input = obj(t.input)
  const out = t.output ?? ''
  const lines = out.split('\n')
  return (
    <div className="step-details">
      {e ? <DiffLines lines={editLines(e)} numbers={false} limit={400} label={`Изменения ${basename(e.file)}`} />
        : emptyInput(t.input)
          ? <p className="muted tool-noinput">{t.status === 'running' ? 'аргументы ещё не пришли' : 'без аргументов'}</p>
          : <pre>{toolKind(t.name) === 'shell' && typeof input.command === 'string' ? input.command : typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}</pre>}
      {out && <pre data-error={t.status === 'error'}>{all ? out : lines.slice(0, 40).join('\n')}</pre>}
      {!all && lines.length > 40 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll(true)}>Показать всё ({lines.length} строк)</button>}
      <div className="step-foot muted">
        {t.status === 'error' ? <><X className="tool-st" data-s="error" aria-hidden />ошибка</> : t.status === 'running' ? 'выполняется' : <><Check className="tool-st" aria-hidden />готово</>}
        {ms !== null && ms >= 1000 && <span className="num"> · {dur(ms)}</span>}
      </div>
    </div>
  )
}

function StepRow({ m, next, live }: { m: Message; next?: Message; live: boolean }) {
  const t = m.tool!
  const running = t.status === 'running'
  const sec = useElapsed(m.at, running && live)
  const ms = next ? next.at - m.at : running ? sec * 1000 : null
  const { icon, text } = stepLine(t)
  const sub = subChat(t)
  return (
    <div className="step" data-current={running || undefined} data-error={t.status === 'error' || undefined}>
      <Disclosure
        chevron="end"
        summary={<>
          {running ? <LoaderCircle className="step-icon spinner" aria-label="выполняется" /> : <span className="step-icon" aria-hidden>{icon}</span>}
          <span className="step-text ellipsis">{text}</span>
          {t.status === 'error' && <X className="tool-st" data-s="error" aria-label="ошибка" />}
        </>}
      >
        <StepDetails t={t} ms={ms} />
      </Disclosure>
      {/* its report stays one click away after it finished (the finished chat is archived, not lost) */}
      {sub && <button type="button" className="step-link" onClick={() => openSession(sub)}>Открыть чат субагента</button>}
    </div>
  )
}

/** Every step of a run in order, thoughts included; scrolls to the newest while running. */
export function StepList({ msgs, live }: { msgs: Message[]; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const running = msgs.some((m) => m.tool?.status === 'running')
  useLayoutEffect(() => {
    const el = ref.current
    if (el && running) el.scrollTop = el.scrollHeight
  }, [msgs.length, running])
  return (
    <div className="tool-steps" ref={ref}>
      {msgs.map((m, i) => m.kind === 'thought'
        ? <div key={m.id} className="step step-thought"><ThoughtBlock m={m} until={msgs[i + 1]?.at ?? (live ? null : m.at)} /></div>
        : <StepRow key={m.id} m={m} next={msgs[i + 1]} live={live} />)}
    </div>
  )
}

export function Thumb({ cwd, path, number }: { cwd: string; path: string; number?: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const box = useRef<HTMLDialogElement>(null)
  const canReveal = useFeature('open-file')
  useEffect(() => {
    let live = true
    let made: string | null = null
    apiBlobUrl(`/fs/raw${qs({ cwd, path })}`).then((u) => { made = u; if (live) setUrl(u); else URL.revokeObjectURL(u) }, () => { if (live) setFailed(true) })
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [cwd, path])
  if (failed) return number ? <span className="chip" data-tip={path}>#{number} {basename(path)}</span> : null
  return (
    <>
      <button type="button" className="thumb" data-tip={path} onClick={() => box.current?.showModal()} disabled={!url}>
        {url ? <img src={url} alt={basename(path)} /> : <span className="thumb-wait" aria-hidden />}
        {number && <span className="att-num">#{number}</span>}
      </button>
      {url && (
        <dialog ref={box} className="lightbox" aria-label={basename(path)} onClick={() => box.current?.close()}>
          <img src={url} alt={basename(path)} />
          <span className="lightbox-name mono">{path}</span>
          {canReveal && (
            <span className="lightbox-actions">
              <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openFile(path, 'file', cwd) }}>Открыть</button>
              <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openFile(path, 'reveal', cwd) }}>Показать в папке</button>
            </span>
          )}
        </dialog>
      )}
    </>
  )
}

/** Thumbnails under a run's header; only when the server can serve files (fs-raw). */
export function RunImages({ msgs, cwd }: { msgs: Message[]; cwd: string }) {
  const on = useFeature('fs-raw')
  const paths = on ? runImages(msgs) : []
  if (!paths.length) return null
  return <div className="run-images">{paths.map((p) => <Thumb key={p} cwd={cwd} path={p} />)}</div>
}
