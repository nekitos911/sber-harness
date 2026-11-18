import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { File, Slash } from 'lucide-react'
import { api, qs } from '../../api'
import { useAgentMeta, useSettings } from '../../lib/agents'
import { splitPath } from '../../lib/git'
import { Popover } from '../ui'
import { useFeature } from '../../store'
import { tokenAt } from '../../lib/mention'
import { ATT_REF } from '../../lib/attachments'
import { useListNav } from '../ui/listNav'

interface Item { key: string; text: string; insert: string; node: ReactNode }

/**
 * Inline suggestions for the composer: files for «@» (GET /api/fs/search, debounced), slash commands for a
 * leading «/» (seen in the agent's sessions + task presets). ↑↓ move, Enter/Tab insert, Esc closes.
 * Returns the popover and a keydown handler the textarea calls first.
 */
export function useComposerSuggest({ input, text, caret, cwd, agentId, onInsert }: {
  input: RefObject<HTMLTextAreaElement | null>
  text: string
  caret: number
  cwd: string
  agentId: string
  onInsert: (start: number, end: number, value: string) => void
}) {
  const tok = tokenAt(text, caret)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [files, setFiles] = useState<{ path: string }[]>([])
  const meta = useAgentMeta(tok?.kind === '/' ? agentId : null)
  const settings = useSettings()
  const seq = useRef(0)
  const searchOn = useFeature('fs-search')

  useEffect(() => {
    if (tok?.kind !== '@' || !searchOn) return
    const n = ++seq.current
    const t = window.setTimeout(() => {
      api<{ path: string }[]>('GET', `/fs/search${qs({ cwd, q: tok.query, limit: 30 })}`)
        .then((r) => { if (n === seq.current) setFiles(Array.isArray(r) ? r : []) }, () => { if (n === seq.current) setFiles([]) })
    }, 80)
    return () => window.clearTimeout(t)
  }, [tok?.kind, tok?.query, cwd, searchOn])

  const items = useMemo<Item[]>(() => {
    if (!tok) return []
    if (tok.kind === '@') {
      return files.map((f) => {
        const { dir, name } = splitPath(f.path)
        return {
          key: f.path, text: f.path, insert: `@${f.path} `,
          node: <><File aria-hidden /><span className="option-main"><span className="option-label"><strong>{name}</strong>{dir && <span className="muted"> {dir}</span>}</span></span></>,
        }
      })
    }
    const presets = (settings?.agents[agentId]?.taskPromptPresets ?? []).map((p) => p.split(/\s/)[0]).filter((p) => p.startsWith('/'))
    const all = [...new Set([...presets, ...(meta?.seen?.slashCommands ?? []).map((c) => (c.startsWith('/') ? c : `/${c}`))])]
    const q = tok.query.toLowerCase()
    return all.filter((c) => c.slice(1).toLowerCase().includes(q)).slice(0, 30).map((c) => ({
      key: c, text: c, insert: `${c} `,
      node: <><Slash aria-hidden /><span className="option-main"><span className="option-label mono">{c.slice(1)}</span></span></>,
    }))
  }, [tok?.kind, tok?.query, files, meta, settings, agentId])

  const sig = tok ? `${tok.kind}${tok.start}` : null
  const open = !!tok && items.length > 0 && dismissed !== sig
  const pick = (i: number) => {
    const it = items[i]
    if (!it || !tok) return
    onInsert(tok.start, caret, it.insert)
  }
  const nav = useListNav(items.map((i) => i.text), () => false, pick)
  useEffect(() => { nav.setActive(0) }, [sig, items.length]) // the best match leads

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    if (e.key === 'Escape') { e.preventDefault(); setDismissed(sig); return true }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(nav.active); return true }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { nav.onKeyDown(e, { typeahead: false }); return true }
    return false
  }

  const popover = (
    <Popover anchor={input} open={open} onClose={() => setDismissed(sig)} placement="top-start" role="presentation" initialFocus={input} className="suggest">
      <div className="listbox" role="listbox" aria-label={tok?.kind === '@' ? 'Файлы' : 'Команды'}>
        {items.map((it, i) => (
          <div key={it.key} role="option" aria-selected={i === nav.active} className="option" data-active={i === nav.active || undefined}
            onPointerMove={() => { if (nav.active !== i) nav.setActive(i) }} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
            {it.node}
          </div>
        ))}
      </div>
    </Popover>
  )
  return { popover, onKeyDown }
}

/** Behind the textarea: the same text with @path tokens drawn as chips (the sent message stays plain text). */
export function MentionMirror({ text, scrollTop }: { text: string; scrollTop: number }) {
  const parts = text.split(/(@[^\s@]+|\[(?:Изображение|Файл) №\d+\])/g)
  return (
    <div className="composer-mirror" aria-hidden style={{ transform: `translateY(${-scrollTop}px)` }}>
      {parts.map((p, i) => (p.startsWith('@') && p.length > 1 ? <mark key={i}>{p}</mark> : ATT_REF.test(p) ? <mark key={i} className="att-ref">{p}</mark> : <span key={i}>{p}</span>))}
      {'​'}
    </div>
  )
}
